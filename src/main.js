const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

const shipImg = new Image();
let shipImgReady = false;
shipImg.onload = () => { shipImgReady = true; };
shipImg.src = '/textures/ships/basic_ship/basicship.svg';

const shipOffscreen = document.createElement('canvas');
const shipOffCtx = shipOffscreen.getContext('2d');

const minimapFrameImg = new Image();
let minimapFrameReady = false;
minimapFrameImg.onload = () => { minimapFrameReady = true; };
minimapFrameImg.src = '/textures/minimapframe.svg';

const bulletImg = new Image();
let bulletImgReady = false;
bulletImg.onload = () => { bulletImgReady = true; };
bulletImg.src = '/textures/ships/basic_ship/basicship_bullet.svg';

const goldImg = new Image();
goldImg._loaded = false;
goldImg.onload = () => { goldImg._loaded = true; };
goldImg.src = '/textures/particles/gold/gold1.svg';

const xpImgs = Array.from({ length: 10 }, (_, i) => {
  const img = new Image();
  img._loaded = false;
  img.onload = () => { img._loaded = true; };
  img.src = `/textures/particles/xp/xp${i + 1}.svg`;
  return img;
});

const rockImgCache = new Map(); // path → HTMLImageElement

function loadRockTexture(path) {
  if (rockImgCache.has(path)) return rockImgCache.get(path);
  const img = new Image();
  img._loaded = false;
  img.onload = () => { img._loaded = true; };
  img.src = path;
  rockImgCache.set(path, img);
  return img;
}

// Per-rock cosmetic state — only stores random rotation angle (server owns size/variant)
const rockAppearance = new Map(); // id -> { angle }

function syncRockAppearance(rocks) {
  const seen = new Set();
  for (const rock of rocks) {
    seen.add(rock.id);
    if (!rockAppearance.has(rock.id)) {
      rockAppearance.set(rock.id, { angle: Math.random() * Math.PI * 2 });
      if (rock.texturePath) loadRockTexture(rock.texturePath);
    }
  }
  for (const [id] of rockAppearance) {
    if (!seen.has(id)) rockAppearance.delete(id);
  }
}

const STAR_COUNT = 220;
const stars = [];

function initStars() {
  stars.length = 0;
  for (let i = 0; i < STAR_COUNT; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = Math.random() * 12 + 3;
    stars.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.pow(Math.random(), 2) * 1.8 + 0.3,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      base: Math.random() * 0.4 + 0.2,
      phase: Math.random() * Math.PI * 2,
      phaseSpeed: Math.random() * 1.5 + 0.3,
    });
  }
}

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  initStars();
}
window.addEventListener("resize", resize);
resize();

// Constants (must match server)
const WORLD_W = 4000;
const WORLD_H = 4000;
const PLAYER_R = 30;
const PLAYER_ACCEL = 900;
const PLAYER_MAX_SPEED = 650;
const FWD_DRAG = 0.8;
const LAT_DRAG = 7.0;
const TURN_SPEED = 3.0;
const FIRE_COOLDOWN = 0.25;
const MINIMAP_SIZE = 144;
const MINIMAP_HALF_WORLD = 1000;
const CORNER_PAD = 32;

const MAX_LEVEL = 99;
const LEVEL_THRESHOLDS = (() => {
  const t = [0];
  for (let i = 1; i < MAX_LEVEL; i++)
    t.push(t[i - 1] + Math.floor(10 * Math.pow(1.15, i - 1)));
  return t;
})();

const AWARD_LEVELS = new Set([
  ...Array.from({ length: 29 }, (_, i) => i + 1),
  ...Array.from({ length: 16 }, (_, i) => 30 + i * 2),
  ...Array.from({ length: 13 }, (_, i) => 63 + i * 3),
]);

function upgradeGoldCost(currentLevel) {
  return Math.floor(50 * Math.pow(1.5, currentLevel));
}

function getLevelInfo(totalXp) {
  let level = MAX_LEVEL;
  for (let i = 0; i < MAX_LEVEL - 1; i++) {
    if (totalXp < LEVEL_THRESHOLDS[i + 1]) { level = i + 1; break; }
  }
  const start = LEVEL_THRESHOLDS[level - 1];
  const end   = level < MAX_LEVEL ? LEVEL_THRESHOLDS[level] : LEVEL_THRESHOLDS[MAX_LEVEL - 1] + 1;
  return { level, progress: Math.min(1, (totalXp - start) / (end - start)) };
}

const UPGRADE_DEFS_CLIENT = [
  { id: 'healthCap',       label: 'Health Capacity',  color: '#ef4444' },
  { id: 'healthRegen',     label: 'Health Regen',     color: '#f472b6' },
  { id: 'bulletReload',    label: 'Bullet Reload',    color: '#fbbf24' },
  { id: 'bulletSpeed',     label: 'Bullet Speed',     color: '#fb923c' },
  { id: 'bulletDamage',    label: 'Bullet Damage',    color: '#f97316' },
  { id: 'shipSpeed',       label: 'Ship Speed',       color: '#22d3ee' },
  { id: 'shipAgility',     label: 'Ship Agility',     color: '#60a5fa' },
  { id: 'bodyDamage',      label: 'Body Damage',      color: '#c084fc' },
  { id: 'collisionShield', label: 'Collision Shield', color: '#818cf8' },
];
const MAX_UPGRADE_LEVEL = 6;
const UPGRADE_XP_PER_LEVEL = 50;

function torusDelta(a, b, size) {
  let d = a - b;
  if (d > size / 2) d -= size;
  if (d < -size / 2) d += size;
  return d;
}

// --- WebSocket ---

let connected = false;
let myId = null;
let ws = null;

function connectToGame(nickname) {
  localPlayer.nickname = nickname || 'Player';

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token    = localStorage.getItem('starship_token') || '';
  const query    = token ? `?token=${encodeURIComponent(token)}` : '';
  ws = new WebSocket(`${protocol}//${location.host}/ws${query}`);

  ws.onopen  = () => { connected = true; };
  ws.onclose = () => { connected = false; };
  ws.onerror = () => { connected = false; };
  ws.onmessage = handleMessage;
}

// --- Local player (client-side prediction) ---

const localPlayer = {
  x: WORLD_W / 2, y: WORLD_H / 2,
  vx: 0, vy: 0, angle: 0,
  hp: 100, maxHp: 100,
  color: '#ffffff',
  gemCount: 0,
  xpCount: 0,
  totalXpEarned: 0,
  level: 1,
  upgradePoints: 0,
  dead: false,
  respawnTimer: 0,
  fireCooldown: 0,
  shipType: 'basic',
  upgrades: Object.fromEntries(UPGRADE_DEFS_CLIENT.map(d => [d.id, 0])),
  turnSpeed: TURN_SPEED,
};

let deathPoint = null;
let prevDead = false;

// Server-authoritative state
const remotePlayers = new Map();
let serverRocks = [];
let serverGems = [];
let serverXpDrops = [];
let serverBullets = [];

// --- Input ---

const keys = new Set();
window.addEventListener("keydown", e => {
  const upgradeIdx = parseInt(e.key) - 1;
  if (upgradeIdx >= 0 && upgradeIdx < UPGRADE_DEFS_CLIENT.length) {
    sendUpgrade(UPGRADE_DEFS_CLIENT[upgradeIdx].id);
  }
  keys.add(e.key.toLowerCase());
  if (e.key === ' ') e.preventDefault();
});
window.addEventListener("keyup", e => keys.delete(e.key.toLowerCase()));

let mouseX = canvas.width / 2;
let mouseY = canvas.height / 2;
let leftMouseDown = false;
let rightMouseDown = false;
let pendingShoot = false;
let aimAngle = 0;
let currentThrust = 0;

window.addEventListener("mousemove", e => {
  mouseX = e.clientX;
  mouseY = e.clientY;
  aimAngle = Math.atan2(mouseY - canvas.height / 2, mouseX - canvas.width / 2);
});
window.addEventListener("contextmenu", e => e.preventDefault());
window.addEventListener("mousedown", e => {
  if (e.button === 0) leftMouseDown = true;
  if (e.button === 2) rightMouseDown = true;
});
window.addEventListener("mouseup", e => {
  if (e.button === 0) leftMouseDown = false;
  if (e.button === 2) rightMouseDown = false;
});

// --- Server messages ---

function handleMessage(event) {
  const msg = JSON.parse(event.data);

  if (msg.type === 'init') {
    myId = msg.id;
    localPlayer.x = msg.x;
    localPlayer.y = msg.y;
    localPlayer.color = msg.color;
    serverRocks = msg.rocks;
    serverGems = msg.gems;
    syncRockAppearance(serverRocks);
    for (const p of msg.players) {
      if (p.id !== myId) remotePlayers.set(p.id, p);
    }
  }

  else if (msg.type === 'tick') {
    if (msg.rocks    !== undefined) { serverRocks = msg.rocks; syncRockAppearance(serverRocks); }
    if (msg.gems     !== undefined) serverGems    = msg.gems;
    if (msg.xpDrops  !== undefined) serverXpDrops = msg.xpDrops || [];
    serverBullets = msg.bullets || [];

    const seen = new Set();
    for (const p of msg.players) {
      if (p.id === myId) {
        // Smooth reconciliation (toroidal shortest path)
        localPlayer.x += torusDelta(p.x, localPlayer.x, WORLD_W) * 0.3;
        localPlayer.y += torusDelta(p.y, localPlayer.y, WORLD_H) * 0.3;
        localPlayer.hp = p.hp;
        localPlayer.maxHp = p.maxHp;
        localPlayer.dead = p.dead;
        localPlayer.respawnTimer = p.respawnTimer;
        localPlayer.gemCount = p.gemCount;
        localPlayer.xpCount = p.xpCount;
        localPlayer.totalXpEarned = p.totalXpEarned ?? localPlayer.totalXpEarned;
        localPlayer.level = p.level ?? localPlayer.level;
        localPlayer.upgradePoints = p.upgradePoints ?? localPlayer.upgradePoints;
        localPlayer.upgrades = p.upgrades || localPlayer.upgrades;
        localPlayer.turnSpeed = p.turnSpeed || TURN_SPEED;
        localPlayer.shipType = p.shipType || 'basic';
        if (p.dead) { localPlayer.vx = 0; localPlayer.vy = 0; }
      } else {
        remotePlayers.set(p.id, p);
        seen.add(p.id);
      }
    }
    for (const [id] of remotePlayers) {
      if (!seen.has(id)) remotePlayers.delete(id);
    }
  }

  else if (msg.type === 'playerLeft') {
    remotePlayers.delete(msg.id);
  }

  else if (msg.type === 'playerJoined') {
    if (msg.player.id !== myId) remotePlayers.set(msg.player.id, msg.player);
  }
}

// --- Send input (throttled to server tick rate) ---

let inputTimer = 0;
const INPUT_INTERVAL = 1 / 60;

function sendInput() {
  if (!ws || !connected || myId === null || ws.readyState !== 1) return;

  ws.send(JSON.stringify({
    type: 'input',
    angle: localPlayer.angle,
    thrust: currentThrust,
    shoot: pendingShoot,
  }));

  pendingShoot = false;
}

// --- Client-side prediction ---

function update(dt) {
  if (localPlayer.dead || myId === null) {
    inputTimer += dt;
    if (inputTimer >= INPUT_INTERVAL) { sendInput(); inputTimer = 0; }
    return;
  }

  // Turning: Q/E/A/D rotate the ship heading; speed scales with Ship Agility upgrade
  const ts = localPlayer.turnSpeed || TURN_SPEED;
  if (keys.has('q') || keys.has('a') || keys.has('arrowleft')) aimAngle -= ts * dt;
  if (keys.has('e') || keys.has('d') || keys.has('arrowright')) aimAngle += ts * dt;

  // Right-mouse snaps heading toward cursor and drives forward
  if (rightMouseDown) {
    aimAngle = Math.atan2(mouseY - canvas.height / 2, mouseX - canvas.width / 2);
  }
  localPlayer.angle = aimAngle;

  // Thrust: W/up or right-mouse = forward, S/down = reverse
  currentThrust = 0;
  if (keys.has('w') || keys.has('arrowup') || rightMouseDown) currentThrust = 1;
  if (keys.has('s') || keys.has('arrowdown')) currentThrust = -0.5;

  // Shoot
  if (localPlayer.fireCooldown > 0) localPlayer.fireCooldown -= dt;
  if ((leftMouseDown || keys.has(' ')) && localPlayer.fireCooldown <= 0) {
    pendingShoot = true;
    localPlayer.fireCooldown = FIRE_COOLDOWN;
  }

  // Car physics: thrust along facing direction + directional drag
  const fx = Math.cos(localPlayer.angle), fy = Math.sin(localPlayer.angle);
  const lx = -fy, ly = fx; // lateral (perpendicular) unit vector

  localPlayer.vx += fx * currentThrust * PLAYER_ACCEL * dt;
  localPlayer.vy += fy * currentThrust * PLAYER_ACCEL * dt;

  // Decompose into forward/lateral, apply separate drag
  const fwdSpd = localPlayer.vx * fx + localPlayer.vy * fy;
  const latSpd = localPlayer.vx * lx + localPlayer.vy * ly;
  const fwdNew = fwdSpd * Math.exp(-FWD_DRAG * dt);
  const latNew = latSpd * Math.exp(-LAT_DRAG * dt);
  localPlayer.vx = fwdNew * fx + latNew * lx;
  localPlayer.vy = fwdNew * fy + latNew * ly;

  const spd = Math.hypot(localPlayer.vx, localPlayer.vy);
  if (spd > PLAYER_MAX_SPEED) {
    localPlayer.vx *= PLAYER_MAX_SPEED / spd;
    localPlayer.vy *= PLAYER_MAX_SPEED / spd;
  }

  localPlayer.x += localPlayer.vx * dt;
  localPlayer.y += localPlayer.vy * dt;
  if (localPlayer.x < 0) localPlayer.x += WORLD_W;
  else if (localPlayer.x > WORLD_W) localPlayer.x -= WORLD_W;
  if (localPlayer.y < 0) localPlayer.y += WORLD_H;
  else if (localPlayer.y > WORLD_H) localPlayer.y -= WORLD_H;

  inputTimer += dt;
  if (inputTimer >= INPUT_INTERVAL) { sendInput(); inputTimer = 0; }

  for (const s of stars) {
    s.x = (s.x + s.vx * dt + canvas.width)  % canvas.width;
    s.y = (s.y + s.vy * dt + canvas.height) % canvas.height;
    s.phase += s.phaseSpeed * dt;
  }
}

// --- Upgrade actions ---

const upgradeHitBoxes = []; // [{x, y, w, h, id}] rebuilt every frame

function sendUpgrade(statId) {
  if (!ws || !connected || myId === null || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'upgrade', stat: statId }));
}

canvas.addEventListener('click', e => {
  if (localPlayer.dead) return;
  for (const box of upgradeHitBoxes) {
    if (e.clientX >= box.x && e.clientX <= box.x + box.w &&
        e.clientY >= box.y && e.clientY <= box.y + box.h) {
      sendUpgrade(box.id);
      break;
    }
  }
});

// --- Drawing ---

function drawGrid(camX, camY) {
  const gridSize = 60;
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;

  const startX = Math.floor((camX - canvas.width / 2) / gridSize) * gridSize;
  const endX = Math.floor((camX + canvas.width / 2) / gridSize) * gridSize;
  const startY = Math.floor((camY - canvas.height / 2) / gridSize) * gridSize;
  const endY = Math.floor((camY + canvas.height / 2) / gridSize) * gridSize;

  ctx.beginPath();
  for (let x = startX; x <= endX; x += gridSize) {
    ctx.moveTo(x - camX + canvas.width / 2, startY - camY + canvas.height / 2);
    ctx.lineTo(x - camX + canvas.width / 2, endY - camY + canvas.height / 2);
  }
  for (let y = startY; y <= endY; y += gridSize) {
    ctx.moveTo(startX - camX + canvas.width / 2, y - camY + canvas.height / 2);
    ctx.lineTo(endX - camX + canvas.width / 2, y - camY + canvas.height / 2);
  }
  ctx.stroke();
}

function drawHealthBar(centerX, topY, radius, hp, maxHp) {
  const w = Math.max(34, radius * 2.2);
  const h = 6;
  const x = centerX - w / 2;
  const pct = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;

  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.fillRect(x, topY, w, h);
  ctx.fillStyle = "rgba(239,68,68,0.9)";
  ctx.fillRect(x, topY, w * pct, h);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x, topY, w, h);
}

function drawXpBar(centerX, topY, radius, totalXp) {
  const { level, progress } = getLevelInfo(totalXp);
  const w = Math.max(34, radius * 2.2);
  const h = 6;
  const x = centerX - w / 2;

  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.fillRect(x, topY, w, h);
  ctx.fillStyle = "rgba(74,222,128,0.9)";
  ctx.fillRect(x, topY, w * progress, h);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x, topY, w, h);

  ctx.font = 'bold 10px Ticketing';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText(`${level}`, x + w + 4, topY + h / 2);
}

function drawShip(sx, sy, angle, color, r) {
  const size = r * 2; // diameter = hitbox

  if (shipImgReady) {
    if (shipOffscreen.width !== size) {
      shipOffscreen.width = size;
      shipOffscreen.height = size;
    }
    shipOffCtx.clearRect(0, 0, size, size);
    shipOffCtx.globalCompositeOperation = 'source-over';
    shipOffCtx.drawImage(shipImg, 0, 0, size, size);
    shipOffCtx.globalCompositeOperation = 'multiply';
    shipOffCtx.fillStyle = color;
    shipOffCtx.fillRect(0, 0, size, size);
    // Clip tint back to original alpha so transparent areas stay transparent
    shipOffCtx.globalCompositeOperation = 'destination-in';
    shipOffCtx.drawImage(shipImg, 0, 0, size, size);

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(angle + Math.PI / 2);
    ctx.drawImage(shipOffscreen, -size / 2, -size / 2);
    ctx.restore();
  } else {
    // Fallback triangle while image loads
    const tip = r + 10, back = r + 6, halfW = r * 0.9;
    ctx.beginPath();
    ctx.moveTo(sx + Math.cos(angle) * tip, sy + Math.sin(angle) * tip);
    ctx.lineTo(sx + Math.cos(angle + Math.PI) * back + Math.cos(angle + Math.PI / 2) * halfW,
               sy + Math.sin(angle + Math.PI) * back + Math.sin(angle + Math.PI / 2) * halfW);
    ctx.lineTo(sx + Math.cos(angle + Math.PI) * back + Math.cos(angle - Math.PI / 2) * halfW,
               sy + Math.sin(angle + Math.PI) * back + Math.sin(angle - Math.PI / 2) * halfW);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }
}

function drawRocks(camX, camY) {
  for (const rock of serverRocks) {
    const dx = torusDelta(rock.x, camX, WORLD_W);
    const dy = torusDelta(rock.y, camY, WORLD_H);
    const sx = canvas.width / 2 + dx;
    const sy = canvas.height / 2 + dy;

    const margin = rock.r + 40;
    if (sx < -margin || sx > canvas.width + margin || sy < -margin || sy > canvas.height + margin) continue;

    const drawSize = rock.r * 2;
    const angle = rockAppearance.get(rock.id)?.angle ?? 0;

    const img = rock.texturePath ? loadRockTexture(rock.texturePath) : null;

    if (img && img._loaded) {
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(angle);
      ctx.drawImage(img, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(sx, sy, rock.r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(160,160,160,0.2)";
      ctx.fill();
      ctx.strokeStyle = "rgba(200,200,200,0.4)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

function drawGems(camX, camY) {
  for (const g of serverGems) {
    const dx = torusDelta(g.x, camX, WORLD_W);
    const dy = torusDelta(g.y, camY, WORLD_H);
    const sx = canvas.width  / 2 + dx;
    const sy = canvas.height / 2 + dy;

    const margin = 20;
    if (sx < -margin || sx > canvas.width + margin || sy < -margin || sy > canvas.height + margin) continue;

    if (goldImg._loaded) {
      ctx.drawImage(goldImg, sx - 7.5, sy - 7.5, 15, 15);
    } else {
      ctx.beginPath();
      ctx.arc(sx, sy, 7.5, 0, Math.PI * 2);
      ctx.fillStyle = '#facc15';
      ctx.fill();
    }
  }
}

function drawXpDrops(camX, camY) {
  for (const x of serverXpDrops) {
    const dx = torusDelta(x.x, camX, WORLD_W);
    const dy = torusDelta(x.y, camY, WORLD_H);
    const sx = canvas.width  / 2 + dx;
    const sy = canvas.height / 2 + dy;

    const margin = 20;
    if (sx < -margin || sx > canvas.width + margin || sy < -margin || sy > canvas.height + margin) continue;

    const img = xpImgs[x.id % 10];
    if (img._loaded) {
      ctx.drawImage(img, sx - 10, sy - 10, 20, 20);
    } else {
      ctx.beginPath();
      ctx.arc(sx, sy, 2, 0, Math.PI * 2);
      ctx.fillStyle = '#4ade80';
      ctx.fill();
    }
  }
}

function drawBullets(camX, camY) {
  for (const b of serverBullets) {
    const dx = torusDelta(b.x, camX, WORLD_W);
    const dy = torusDelta(b.y, camY, WORLD_H);
    const sx = canvas.width  / 2 + dx;
    const sy = canvas.height / 2 + dy;

    if (bulletImgReady) {
      const color = b.ownerId === myId
        ? localPlayer.color
        : (remotePlayers.get(b.ownerId)?.color ?? '#ffffff');
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate((b.angle ?? 0) + Math.PI / 2);
      ctx.drawImage(bulletImg, -4, -16, 8, 32);
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = color;
      ctx.fillRect(-4, -16, 8, 32);
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(sx, sy, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#fde047';
      ctx.fill();
    }
  }
}

function drawRemotePlayers(camX, camY) {
  for (const [, p] of remotePlayers) {
    if (p.dead) continue;

    const dx = torusDelta(p.x, camX, WORLD_W);
    const dy = torusDelta(p.y, camY, WORLD_H);
    const sx = canvas.width / 2 + dx;
    const sy = canvas.height / 2 + dy;

    const margin = PLAYER_R + 60;
    if (sx < -margin || sx > canvas.width + margin || sy < -margin || sy > canvas.height + margin) continue;

    drawShip(sx, sy, p.angle, p.color, PLAYER_R);
    drawHealthBar(sx, sy - PLAYER_R - 12, PLAYER_R, p.hp, p.maxHp);
    drawXpBar(sx, sy + PLAYER_R + 6, PLAYER_R, p.totalXpEarned ?? 0);
  }
}

function drawMinimap() {
  const mx = canvas.width  - CORNER_PAD - MINIMAP_SIZE;
  const my = canvas.height - CORNER_PAD - MINIMAP_SIZE;
  const half = MINIMAP_SIZE / 2;
  const scale = half / MINIMAP_HALF_WORLD;

  const camX = localPlayer.x;
  const camY = localPlayer.y;

  // Track death point transitions
  if (localPlayer.dead && !prevDead) deathPoint = { x: localPlayer.x, y: localPlayer.y };
  if (!localPlayer.dead && prevDead) deathPoint = null;
  prevDead = localPlayer.dead;

  // Background
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(mx, my, MINIMAP_SIZE, MINIMAP_SIZE);

  // Clip contents to rounded frame shape
  ctx.save();
  roundRect(ctx, mx + 4, my + 4, MINIMAP_SIZE - 8, MINIMAP_SIZE - 8, 12);
  ctx.clip();

  // Rocks
  for (const rock of serverRocks) {
    const dx = torusDelta(rock.x, camX, WORLD_W);
    const dy = torusDelta(rock.y, camY, WORLD_H);
    const sx = mx + half + dx * scale;
    const sy = my + half + dy * scale;
    if (sx < mx || sx > mx + MINIMAP_SIZE || sy < my || sy > my + MINIMAP_SIZE) continue;
    const rr = Math.min(6, Math.max(2, rock.r * scale));
    ctx.beginPath();
    ctx.arc(sx, sy, rr, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }

  // Remote players
  for (const [, p] of remotePlayers) {
    if (p.dead) continue;
    const dx = torusDelta(p.x, camX, WORLD_W);
    const dy = torusDelta(p.y, camY, WORLD_H);
    const sx = mx + half + dx * scale;
    const sy = my + half + dy * scale;
    if (sx < mx || sx > mx + MINIMAP_SIZE || sy < my || sy > my + MINIMAP_SIZE) continue;
    ctx.beginPath();
    ctx.arc(sx, sy, 3, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
  }

  // Self
  ctx.beginPath();
  ctx.arc(mx + half, my + half, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  // Death point (inside minimap)
  if (deathPoint) {
    const ddx = torusDelta(deathPoint.x, camX, WORLD_W);
    const ddy = torusDelta(deathPoint.y, camY, WORLD_H);
    const dsx = mx + half + ddx * scale;
    const dsy = my + half + ddy * scale;
    if (dsx >= mx && dsx <= mx + MINIMAP_SIZE && dsy >= my && dsy <= my + MINIMAP_SIZE) {
      ctx.beginPath();
      ctx.arc(dsx, dsy, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ef4444';
      ctx.fill();
    }
  }

  ctx.restore();

  // Frame
  if (minimapFrameReady) {
    ctx.drawImage(minimapFrameImg, mx, my, MINIMAP_SIZE, MINIMAP_SIZE);
  }

  // Death point outside minimap — dot on the contour pointing toward it
  if (deathPoint) {
    const ddx = torusDelta(deathPoint.x, camX, WORLD_W);
    const ddy = torusDelta(deathPoint.y, camY, WORLD_H);
    const dsx = mx + half + ddx * scale;
    const dsy = my + half + ddy * scale;
    const outside = dsx < mx || dsx > mx + MINIMAP_SIZE || dsy < my || dsy > my + MINIMAP_SIZE;
    if (outside) {
      const angle = Math.atan2(ddy, ddx);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const margin = 5;
      let t = Infinity;
      if (cos > 0)  t = Math.min(t, (half - margin) / cos);
      if (cos < 0)  t = Math.min(t, (-half + margin) / cos);
      if (sin > 0)  t = Math.min(t, (half - margin) / sin);
      if (sin < 0)  t = Math.min(t, (-half + margin) / sin);
      const ex = mx + half + cos * t;
      const ey = my + half + sin * t;
      ctx.beginPath();
      ctx.arc(ex, ey, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ef4444';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

function roundRect(cx, x, y, w, h, r) {
  cx.beginPath();
  cx.moveTo(x + r, y);
  cx.lineTo(x + w - r, y);
  cx.quadraticCurveTo(x + w, y, x + w, y + r);
  cx.lineTo(x + w, y + h - r);
  cx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  cx.lineTo(x + r, y + h);
  cx.quadraticCurveTo(x, y + h, x, y + h - r);
  cx.lineTo(x, y + r);
  cx.quadraticCurveTo(x, y, x + r, y);
  cx.closePath();
}

function drawUpgrade1Content(bx, by, level) {
  ctx.fillStyle = '#D9D9D9';

  // Top-left heart
  ctx.beginPath();
  ctx.moveTo(bx+18,by+32); ctx.lineTo(bx+21,by+28); ctx.lineTo(bx+25,by+28);
  ctx.lineTo(bx+28,by+33); ctx.lineTo(bx+31,by+28); ctx.lineTo(bx+35,by+28);
  ctx.lineTo(bx+38,by+32); ctx.lineTo(bx+38,by+38); ctx.lineTo(bx+30,by+46);
  ctx.lineTo(bx+26,by+46); ctx.lineTo(bx+18,by+38); ctx.closePath();
  ctx.fill();

  // Top-right heart
  ctx.beginPath();
  ctx.moveTo(bx+42,by+32); ctx.lineTo(bx+45,by+28); ctx.lineTo(bx+49,by+28);
  ctx.lineTo(bx+52,by+33); ctx.lineTo(bx+55,by+28); ctx.lineTo(bx+59,by+28);
  ctx.lineTo(bx+62,by+32); ctx.lineTo(bx+62,by+38); ctx.lineTo(bx+54,by+46);
  ctx.lineTo(bx+50,by+46); ctx.lineTo(bx+42,by+38); ctx.closePath();
  ctx.fill();

  // Bottom-center heart
  ctx.beginPath();
  ctx.moveTo(bx+30,by+50); ctx.lineTo(bx+33,by+46); ctx.lineTo(bx+37,by+46);
  ctx.lineTo(bx+40,by+51); ctx.lineTo(bx+43,by+46); ctx.lineTo(bx+47,by+46);
  ctx.lineTo(bx+50,by+50); ctx.lineTo(bx+50,by+56); ctx.lineTo(bx+42,by+64);
  ctx.lineTo(bx+38,by+64); ctx.lineTo(bx+30,by+56); ctx.closePath();
  ctx.fill();

  // 6 progress bars
  const barXs = [17, 25, 33, 41, 49, 57];
  for (let b = 0; b < 6; b++) {
    roundRect(ctx, bx + barXs[b], by + 67, 6, 16, 3);
    if (b < level) {
      ctx.fillStyle = '#D9D9D9';
      ctx.fill();
    } else {
      ctx.strokeStyle = 'rgba(217,217,217,0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

function drawUpgradeBar() {
  if (!myId || localPlayer.dead) return;

  const upgrades = localPlayer.upgrades;
  const xp = localPlayer.xpCount;

  const SLOTS  = 10;
  const btnW   = 80;
  const btnH   = 112;
  const gap    = 16;
  const totalW = SLOTS * btnW + (SLOTS - 1) * gap;
  const minimapX = canvas.width - CORNER_PAD - MINIMAP_SIZE;
  const startX = minimapX - 32 - totalW;
  const startY = canvas.height - CORNER_PAD - btnH;

  upgradeHitBoxes.length = 0;

  for (let i = 0; i < SLOTS; i++) {
    const def = UPGRADE_DEFS_CLIENT[i];
    const bx = startX + i * (btnW + gap);
    const by = startY;

    const level      = def ? ((upgrades && upgrades[def.id]) || 0) : 0;
    const maxed      = def && level >= MAX_UPGRADE_LEVEL;
    const goldCost   = def && !maxed ? upgradeGoldCost(level) : null;
    const hasPoint   = localPlayer.upgradePoints >= 1;
    const canAfford  = goldCost !== null && hasPoint && localPlayer.gemCount >= goldCost;
    const hovered = mouseX >= bx && mouseX <= bx + btnW && mouseY >= by && mouseY <= by + btnH;

    // Background
    ctx.fillStyle = def ? 'rgba(0,0,0,0.78)' : 'rgba(0,0,0,0.35)';
    roundRect(ctx, bx, by, btnW, btnH, 10);
    ctx.fill();

    if (hovered && def) {
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      roundRect(ctx, bx, by, btnW, btnH, 10);
      ctx.fill();
    }

    // Border
    ctx.strokeStyle = maxed      ? 'rgba(255,215,0,0.75)'   :
                      canAfford  ? 'rgba(255,255,255,0.85)'  :
                      def        ? 'rgba(255,255,255,0.35)'  :
                                   'rgba(255,255,255,0.12)';
    ctx.lineWidth = 2;
    roundRect(ctx, bx, by, btnW, btnH, 10);
    ctx.stroke();

    if (!def) continue;

    if (i === 0) {
      drawUpgrade1Content(bx, by, level);
    } else {
      // Color strip at top
      ctx.fillStyle = def.color;
      ctx.fillRect(bx + 12, by + 8, btnW - 24, 4);

      // Key number
      ctx.font = 'bold 10px Ticketing';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillText(`${i + 1}`, bx + 6, by + 6);

      // Label — two lines
      const words = def.label.split(' ');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '11px Ticketing';
      ctx.fillStyle = maxed ? 'rgba(255,215,0,0.9)' : 'rgba(255,255,255,0.88)';
      if (words.length >= 2) {
        ctx.fillText(words[0],               bx + btnW / 2, by + 36);
        ctx.fillText(words.slice(1).join(' '), bx + btnW / 2, by + 50);
      } else {
        ctx.fillText(def.label, bx + btnW / 2, by + 43);
      }

      // Level dots
      const dotR = 3.5;
      const dotSpacing = 10;
      const dotsW = (MAX_UPGRADE_LEVEL - 1) * dotSpacing;
      const dotsStartX = bx + btnW / 2 - dotsW / 2;
      const dotsY = by + 72;
      for (let d = 0; d < MAX_UPGRADE_LEVEL; d++) {
        ctx.beginPath();
        ctx.arc(dotsStartX + d * dotSpacing, dotsY, dotR, 0, Math.PI * 2);
        if (d < level) {
          ctx.fillStyle = def.color;
          ctx.fill();
        } else {
          ctx.strokeStyle = 'rgba(255,255,255,0.22)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      // Cost / MAX
      ctx.font = '11px Ticketing';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (maxed) {
        ctx.fillStyle = 'rgba(255,215,0,0.8)';
        ctx.fillText('MAX', bx + btnW / 2, by + 93);
      } else if (!hasPoint) {
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.fillText('no points', bx + btnW / 2, by + 93);
      } else {
        ctx.fillStyle = canAfford ? '#facc15' : 'rgba(255,255,255,0.32)';
        ctx.fillText(`${goldCost} gold`, bx + btnW / 2, by + 93);
      }
    }

    upgradeHitBoxes.push({ x: bx, y: by, w: btnW, h: btnH, id: def.id });
  }

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
}

function drawHUD() {
  const pad = 16;

  ctx.font = "20px Ticketing";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#facc15";
  ctx.fillText(`Gold: ${localPlayer.gemCount}`, pad, pad);

  ctx.fillStyle = "#4ade80";
  ctx.fillText(`XP: ${localPlayer.xpCount}`, pad, pad + 28);

  ctx.fillStyle = "#818cf8";
  ctx.fillText(`Points: ${localPlayer.upgradePoints}`, pad, pad + 56);

  ctx.font = "14px Ticketing";
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.fillText(`Players online: ${remotePlayers.size + 1}`, pad, pad + 84);

  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillText(
    `X: ${Math.floor(localPlayer.x)}  Y: ${Math.floor(localPlayer.y)}`,
    canvas.width - pad, pad
  );
  ctx.textAlign = "left";
}

function drawDeathScreen() {
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.font = "bold 64px Ticketing";
  ctx.fillStyle = "#ef4444";
  ctx.fillText("YOU DIED", canvas.width / 2, canvas.height / 2 - 44);

  ctx.font = "24px Ticketing";
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.fillText(
    `Respawning in ${Math.ceil(Math.max(0, localPlayer.respawnTimer))}s...`,
    canvas.width / 2, canvas.height / 2 + 20
  );

  ctx.textAlign = "left";
  ctx.textBaseline = "top";
}

function drawConnecting() {
  ctx.fillStyle = "rgba(0,0,0,0.85)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "28px Ticketing";
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.fillText("Connecting to server...", canvas.width / 2, canvas.height / 2);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
}

function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const s of stars) {
    const alpha = s.base * (0.6 + 0.4 * Math.sin(s.phase));
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(180,180,180,${alpha.toFixed(2)})`;
    ctx.fill();
  }

  if (!connected || myId === null) {
    drawConnecting();
    return;
  }

  const camX = localPlayer.x;
  const camY = localPlayer.y;
  drawRocks(camX, camY);
  drawGems(camX, camY);
  drawXpDrops(camX, camY);
  drawBullets(camX, camY);
  drawRemotePlayers(camX, camY);

  if (!localPlayer.dead) {
    drawShip(canvas.width / 2, canvas.height / 2, localPlayer.angle, localPlayer.color, PLAYER_R);
    drawHealthBar(canvas.width / 2, canvas.height / 2 - PLAYER_R - 12, PLAYER_R, localPlayer.hp, localPlayer.maxHp);
    drawXpBar(canvas.width / 2, canvas.height / 2 + PLAYER_R + 6, PLAYER_R, localPlayer.totalXpEarned);
  }

  drawHUD();
  drawUpgradeBar();
  drawMinimap();

  if (localPlayer.dead) drawDeathScreen();
}

let last = performance.now();
function loop(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  update(dt);
  draw();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// --- Main menu ---

document.getElementById('btn-play').addEventListener('click', () => {
  const storedName = localStorage.getItem('starship_username');
  const nickname = storedName || document.getElementById('nickname').value.trim();
  document.getElementById('menu').style.display = 'none';
  document.getElementById('menu-topleft').style.display = 'none';
  connectToGame(nickname);
});

document.getElementById('nickname').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-play').click();
});

// --- Color picker ---
const SHIP_COLORS = [
  '#ef4444','#f97316','#eab308','#22c55e',
  '#06b6d4','#3b82f6','#a855f7','#ec4899',
  '#14b8a6','#f59e0b','#FCAFFF','#ffffff',
];

let selectedColor = localStorage.getItem('starship_color') || '#FCAFFF';
const colorBtn    = document.getElementById('btn-color');
const colorPopup  = document.getElementById('color-picker-popup');

function applyColor(c) {
  selectedColor = c;
  colorBtn.style.background = c;
  localStorage.setItem('starship_color', c);
  document.querySelectorAll('.color-swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.color === c);
  });
}

SHIP_COLORS.forEach(c => {
  const sw = document.createElement('button');
  sw.className = 'color-swatch';
  sw.dataset.color = c;
  sw.style.background = c;
  sw.addEventListener('click', () => { applyColor(c); colorPopup.classList.remove('open'); });
  colorPopup.appendChild(sw);
});

applyColor(selectedColor);

colorBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  colorPopup.classList.toggle('open');
  if (colorPopup.classList.contains('open')) {
    const rect = colorBtn.getBoundingClientRect();
    colorPopup.style.left = rect.left + 'px';
    colorPopup.style.top  = (rect.top - colorPopup.offsetHeight - 8) + 'px';
  }
});
document.addEventListener('click', () => colorPopup.classList.remove('open'));

// --- Account modal ---

const accountModal  = document.getElementById('account-modal');
const accountAuth   = document.getElementById('account-auth');
const accountLoggedIn = document.getElementById('account-loggedin');
const authError     = document.getElementById('auth-error');
const authUsername  = document.getElementById('auth-username');
const authPassword  = document.getElementById('auth-password');
const btnSubmit     = document.getElementById('btn-auth-submit');
const tabLogin      = document.getElementById('tab-login');
const tabRegister   = document.getElementById('tab-register');

let authMode = 'login';

function setAuthMode(mode) {
  authMode = mode;
  tabLogin.classList.toggle('active', mode === 'login');
  tabRegister.classList.toggle('active', mode === 'register');
  btnSubmit.textContent = mode === 'login' ? 'LOGIN' : 'REGISTER';
  authError.textContent = '';
}

function openAccountModal() {
  const token = localStorage.getItem('starship_token');
  const uname = localStorage.getItem('starship_username');
  if (token && uname) {
    accountAuth.style.display = 'none';
    accountLoggedIn.style.display = '';
    document.getElementById('account-display-name').textContent = uname;
  } else {
    accountAuth.style.display = '';
    accountLoggedIn.style.display = 'none';
  }
  accountModal.classList.add('open');
}

document.getElementById('btn-account').addEventListener('click', openAccountModal);
document.getElementById('btn-close-account').addEventListener('click', () => accountModal.classList.remove('open'));
accountModal.addEventListener('click', e => { if (e.target === accountModal) accountModal.classList.remove('open'); });

tabLogin.addEventListener('click',    () => setAuthMode('login'));
tabRegister.addEventListener('click', () => setAuthMode('register'));

btnSubmit.addEventListener('click', async () => {
  const username = authUsername.value.trim();
  const password = authPassword.value;
  authError.textContent = '';
  if (!username || !password) { authError.textContent = 'Fill in both fields.'; return; }

  const endpoint = authMode === 'login' ? '/auth/login' : '/auth/register';
  try {
    const res  = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) { authError.textContent = data.error || 'Error'; return; }

    localStorage.setItem('starship_token',    data.token);
    localStorage.setItem('starship_username', data.username);

    // Update nickname field to account name
    document.getElementById('nickname').value = data.username;

    accountModal.classList.remove('open');
  } catch {
    authError.textContent = 'Network error.';
  }
});

document.getElementById('btn-logout').addEventListener('click', () => {
  localStorage.removeItem('starship_token');
  localStorage.removeItem('starship_username');
  document.getElementById('nickname').value = '';
  accountModal.classList.remove('open');
});

// Pre-fill nickname if already logged in
const savedUsername = localStorage.getItem('starship_username');
if (savedUsername) document.getElementById('nickname').value = savedUsername;

// Custom placeholder show/hide
const nicknameInput = document.getElementById('nickname');
const nicknamePlaceholder = document.getElementById('nickname-placeholder');
function syncPlaceholder() {
  nicknamePlaceholder.style.display = nicknameInput.value ? 'none' : 'block';
}
nicknameInput.addEventListener('input', syncPlaceholder);
syncPlaceholder();

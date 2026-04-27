import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT       = process.env.PORT       || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const DB_PATH    = process.env.DB_PATH    || join(__dirname, 'game.db');

const TICK_RATE = 60;
const DT = 1 / TICK_RATE;

const WORLD_W = 4000;
const WORLD_H = 4000;

// --- Database ---
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS player_data (
    user_id        INTEGER PRIMARY KEY REFERENCES users(id),
    level          INTEGER DEFAULT 1,
    total_xp       INTEGER DEFAULT 0,
    upgrade_points INTEGER DEFAULT 0,
    gold           INTEGER DEFAULT 0,
    xp_count       INTEGER DEFAULT 0,
    upgrades       TEXT DEFAULT '{}',
    updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// --- Ship type stencils ---
const SHIP_TYPES = {
  basic: {
    name: 'Basic',
    r: 30,
    maxHp: 100,
    regenRate: 6,
    regenDelay: 2.0,
    fireCooldown: 0.25,
    bulletSpeed: 700,
    bulletDamage: 25,
    maxSpeed: 650,
    accel: 900,
    fwdDrag: 0.8,
    latDrag: 7.0,
    turnSpeed: 3.0,
    bodyDamageScale: 1.0,
    collisionShieldFrac: 0.0,
    collisionPunchMult: 1.0,
  },
};

// --- Upgrade system ---
const MAX_UPGRADE_LEVEL = 6;
const UPGRADE_XP_PER_LEVEL = 50;

const UPGRADE_IDS = [
  'healthCap', 'healthRegen', 'bulletReload', 'bulletSpeed',
  'bulletDamage', 'shipSpeed', 'shipAgility', 'bodyDamage', 'collisionShield',
];

function computeStats(p) {
  const base = SHIP_TYPES[p.shipType] || SHIP_TYPES.basic;
  const L = k => p.upgrades[k] || 0;
  return {
    r: base.r,
    maxHp:               Math.round(base.maxHp * (1 + L('healthCap') * 0.20)),
    regenRate:           base.regenRate * (1 + L('healthRegen') * 0.35),
    regenDelay:          base.regenDelay * Math.max(0.15, 1 - L('healthRegen') * 0.12),
    fireCooldown:        base.fireCooldown / (1 + L('bulletReload') * 0.20),
    bulletSpeed:         base.bulletSpeed * (1 + L('bulletSpeed') * 0.15),
    bulletDamage:        base.bulletDamage * (1 + L('bulletDamage') * 0.20),
    maxSpeed:            base.maxSpeed * (1 + L('shipSpeed') * 0.12),
    accel:               base.accel * (1 + L('shipSpeed') * 0.10),
    fwdDrag:             base.fwdDrag,
    latDrag:             base.latDrag * Math.max(0.3, 1 - L('shipAgility') * 0.09),
    turnSpeed:           base.turnSpeed * (1 + L('shipAgility') * 0.15),
    bodyDamageScale:     base.bodyDamageScale * (1 + L('bodyDamage') * 0.50),
    collisionShieldFrac: Math.min(0.60, L('collisionShield') * 0.08),
    collisionPunchMult:  1 + L('collisionShield') * 0.20,
  };
}

// --- Level & upgrade point system ---
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

function getLevel(totalXp) {
  for (let i = 0; i < MAX_LEVEL - 1; i++)
    if (totalXp < LEVEL_THRESHOLDS[i + 1]) return i + 1;
  return MAX_LEVEL;
}

function upgradeGoldCost(currentLevel) {
  return Math.floor(50 * Math.pow(1.5, currentLevel));
}

// --- Network optimisation constants ---
const VIEW_RANGE = 1600; // world units sent to each client
const NET_RATE   = 3;    // send every Nth physics tick → 20 Hz
const SLOW_RATE  = 6;    // rocks/gems/xp every Nth → 10 Hz
let   physTick   = 0;

// --- Rock texture manifest ---
const ROCK_TEXTURES = readdirSync(join(__dirname, 'public/textures/rocks'))
  .filter(f => f.endsWith('.svg'))
  .map(f => {
    const src = readFileSync(join(__dirname, 'public/textures/rocks', f), 'utf8');
    const m = src.match(/width="(\d+)"/);
    const size = m ? parseInt(m[1]) : 128;
    return { path: `/textures/rocks/${f}`, r: size / 2 };
  });

console.log(`Loaded ${ROCK_TEXTURES.length} rock textures:`, ROCK_TEXTURES.map(t => `${t.path} (r=${t.r})`));

// --- World constants ---
const PLAYER_R = 30;

const ROCK_COUNT = 80;
const ROCK_DRAG = 1.8;
const ROCK_MAX_SPEED = 220;
const COLLISION_DAMAGE_SCALE = 0.06;
const COLLISION_MIN_DAMAGE = 2;
const BULLET_LIFE = 1.2;
const RESPAWN_TIME = 3.0;

const GEM_RADIUS = 6;
const GEM_DESPAWN = 20;
const GEM_MAGNET_RADIUS = 220;
const GEM_MAGNET_FORCE = 900;

const XP_RADIUS = 5;
const XP_DESPAWN = 25;
const XP_MAGNET_RADIUS = 400;
const XP_MAGNET_FORCE = 1800;

const PLAYER_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#06b6d4', '#3b82f6', '#a855f7', '#ec4899',
  '#14b8a6', '#f59e0b',
];

let nextId = 1;
let nextRockId = 1;
let nextGemId = 1;
let nextXpId = 1;
let nextBulletId = 1;

const players = new Map();
const rocks = [];
const gems = [];
const xpDrops = [];
const bullets = [];

// --- helpers ---

function rand(min, max) { return Math.random() * (max - min) + min; }

function torusDelta(a, b, size) {
  let d = a - b;
  if (d > size / 2) d -= size;
  if (d < -size / 2) d += size;
  return d;
}

function torusDist(x1, y1, x2, y2) {
  return Math.hypot(torusDelta(x1, x2, WORLD_W), torusDelta(y1, y2, WORLD_H));
}

function wrapX(x) { return ((x % WORLD_W) + WORLD_W) % WORLD_W; }
function wrapY(y) { return ((y % WORLD_H) + WORLD_H) % WORLD_H; }
function wsReady(ws) { return ws.readyState === 1; }

function send(ws, data) {
  if (wsReady(ws)) ws.send(JSON.stringify(data));
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const [, p] of players) {
    if (wsReady(p.ws)) p.ws.send(msg);
  }
}

// --- rock / gem / xp spawning ---

function spawnRock() {
  const tex = ROCK_TEXTURES[Math.floor(Math.random() * ROCK_TEXTURES.length)];
  const r = tex.r;
  const texturePath = tex.path;
  const maxHp = Math.round(r * 2);

  let x = rand(0, WORLD_W);
  let y = rand(0, WORLD_H);
  for (let tries = 0; tries < 200; tries++) {
    x = rand(0, WORLD_W);
    y = rand(0, WORLD_H);
    let ok = true;
    for (const [, p] of players) {
      if (!p.dead && torusDist(x, y, p.x, p.y) < 300 + r + PLAYER_R) {
        ok = false;
        break;
      }
    }
    if (ok) break;
  }

  return { id: nextRockId++, x, y, r, texturePath, maxHp, hp: maxHp, vx: 0, vy: 0 };
}

function serializeRock(rock) {
  return {
    id: rock.id, x: rock.x, y: rock.y, r: rock.r,
    hp: rock.hp, maxHp: rock.maxHp, vx: rock.vx, vy: rock.vy,
    texturePath: rock.texturePath,
  };
}

function spawnGemsAt(x, y, r) {
  const mult = Math.max(2, Math.round(r / PLAYER_R));
  const count = Math.max(2, mult * 2);
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = rand(40, 140);
    gems.push({
      id: nextGemId++, x, y, r: GEM_RADIUS,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      life: GEM_DESPAWN, value: 1,
    });
  }
}

function spawnXpAt(x, y, amount) {
  const count = Math.max(1, Math.round(amount / 2));
  const perDrop = Math.max(1, Math.floor(amount / count));
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = rand(30, 100);
    xpDrops.push({
      id: nextXpId++, x, y, r: XP_RADIUS,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      life: XP_DESPAWN, value: perDrop,
    });
  }
}

function initRocks() {
  for (let i = 0; i < ROCK_COUNT; i++) rocks.push(spawnRock());
}

// --- player lifecycle ---

function createPlayer(ws, id, userId = null, name = null, savedData = null) {
  const color    = PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length];
  const shipType = 'basic';
  const base     = SHIP_TYPES[shipType];

  const gemCount   = savedData ? savedData.gold           : 99999;
  const xpCount    = savedData ? savedData.xp_count       : 99999;
  const totalXp    = savedData ? savedData.total_xp       : 0;
  const level      = savedData ? savedData.level          : 1;
  const upPoints   = savedData ? savedData.upgrade_points : 0;
  const upgrades   = savedData
    ? JSON.parse(savedData.upgrades)
    : Object.fromEntries(UPGRADE_IDS.map(k => [k, 0]));

  return {
    id, ws, userId,
    name: name || 'Player',
    x: rand(200, WORLD_W - 200), y: rand(200, WORLD_H - 200),
    vx: 0, vy: 0, angle: 0,
    hp: base.maxHp, maxHp: base.maxHp,
    color, shipType,
    upgrades,
    gemCount, xpCount, totalXpEarned: totalXp,
    level, upgradePoints: upPoints,
    fireCooldown: 0, regenCooldown: 0,
    dead: false, respawnTimer: 0,
    input: { angle: 0, thrust: 0, shoot: false },
  };
}

function savePlayerData(p) {
  if (!p.userId) return;
  db.prepare(`
    INSERT INTO player_data (user_id, level, total_xp, upgrade_points, gold, xp_count, upgrades, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      level          = excluded.level,
      total_xp       = excluded.total_xp,
      upgrade_points = excluded.upgrade_points,
      gold           = excluded.gold,
      xp_count       = excluded.xp_count,
      upgrades       = excluded.upgrades,
      updated_at     = excluded.updated_at
  `).run(p.userId, p.level, p.totalXpEarned, p.upgradePoints, p.gemCount, p.xpCount, JSON.stringify(p.upgrades));
}

function serialize(p) {
  const stats = computeStats(p);
  return {
    id: p.id, x: p.x, y: p.y, vx: p.vx, vy: p.vy,
    angle: p.angle, hp: p.hp, maxHp: stats.maxHp,
    color: p.color, gemCount: p.gemCount, xpCount: p.xpCount,
    totalXpEarned: p.totalXpEarned || 0,
    level: p.level || 1, upgradePoints: p.upgradePoints || 0,
    dead: p.dead, respawnTimer: p.dead ? p.respawnTimer : 0,
    shipType: p.shipType, upgrades: p.upgrades, turnSpeed: stats.turnSpeed,
    name: p.name || 'Player',
  };
}

function killPlayer(p) {
  if (p.dead) return;
  p.dead = true;
  p.hp = 0;
  p.respawnTimer = RESPAWN_TIME;
  const drop = Math.min(10, Math.floor(p.gemCount / 2));
  for (let i = 0; i < drop; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = rand(40, 120);
    gems.push({
      id: nextGemId++, x: p.x, y: p.y, r: GEM_RADIUS,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      life: GEM_DESPAWN, value: 1,
    });
  }
  p.gemCount = Math.floor(p.gemCount / 2);
  const xpDrop = Math.floor(p.xpCount / 2);
  if (xpDrop > 0) spawnXpAt(p.x, p.y, xpDrop);
  p.xpCount = Math.floor(p.xpCount / 2);
}

function respawnPlayer(p) {
  p.dead = false;
  const stats = computeStats(p);
  p.hp = stats.maxHp;
  p.maxHp = stats.maxHp;
  p.x = rand(200, WORLD_W - 200);
  p.y = rand(200, WORLD_H - 200);
  p.vx = 0; p.vy = 0;
  p.fireCooldown = 0;
  p.regenCooldown = 0;
}

// --- Express app ---

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'dist')));

app.post('/auth/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Missing fields' });
  if (username.length < 2 || username.length > 20)
    return res.status(400).json({ error: 'Username must be 2–20 characters' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
    const token = jwt.sign({ userId: result.lastInsertRowid, username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, username });
  } catch (e) {
    if (e.message.includes('UNIQUE'))
      return res.status(409).json({ error: 'Username already taken' });
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Missing fields' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid username or password' });
  const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: user.username });
});

// --- HTTP + WebSocket server ---

const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/ws')) {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

httpServer.listen(PORT, () => {
  console.log(`Starship.io server running on port ${PORT}`);
});

wss.on('connection', (ws, req) => {
  const url   = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');

  let userId   = null;
  let username = null;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      userId   = payload.userId;
      username = payload.username;
    } catch {}
  }

  const savedData = userId
    ? db.prepare('SELECT * FROM player_data WHERE user_id = ?').get(userId)
    : null;

  const id = nextId++;
  const player = createPlayer(ws, id, userId, username, savedData);
  players.set(id, player);

  send(ws, {
    type: 'init',
    id, color: player.color, x: player.x, y: player.y,
    name: player.name,
    rocks: rocks.map(serializeRock),
    gems: gems.map(g => ({ id: g.id, x: g.x, y: g.y, r: g.r })),
    xpDrops: xpDrops.map(x => ({ id: x.id, x: x.x, y: x.y, r: x.r })),
    players: Array.from(players.values()).map(serialize),
    upgradeIds: UPGRADE_IDS,
    xpPerLevel: UPGRADE_XP_PER_LEVEL,
    maxUpgradeLevel: MAX_UPGRADE_LEVEL,
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'input') {
        player.input = msg;
      } else if (msg.type === 'upgrade') {
        const stat = msg.stat;
        if (!UPGRADE_IDS.includes(stat)) return;
        const currentLevel = player.upgrades[stat];
        if (currentLevel >= MAX_UPGRADE_LEVEL) return;
        const goldCost = upgradeGoldCost(currentLevel);
        if (player.upgradePoints < 1) return;
        if (player.gemCount < goldCost) return;
        player.upgradePoints--;
        player.gemCount -= goldCost;
        player.upgrades[stat] = currentLevel + 1;
        const newStats = computeStats(player);
        player.maxHp = newStats.maxHp;
        if (player.hp > player.maxHp) player.hp = player.maxHp;
      }
    } catch {}
  });

  const cleanup = () => {
    savePlayerData(player);
    players.delete(id);
    broadcast({ type: 'playerLeft', id });
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

// --- physics ---

function updatePlayers() {
  for (const [, p] of players) {
    if (p.dead) {
      p.respawnTimer -= DT;
      if (p.respawnTimer <= 0) respawnPlayer(p);
      continue;
    }

    const stats = computeStats(p);
    p.maxHp = stats.maxHp;

    if (p.fireCooldown > 0) p.fireCooldown -= DT;
    if (p.regenCooldown > 0) p.regenCooldown -= DT;

    if (p.regenCooldown <= 0 && p.hp < stats.maxHp) {
      p.hp = Math.min(stats.maxHp, p.hp + stats.regenRate * DT);
    }

    p.angle = p.input.angle;
    const fx = Math.cos(p.angle), fy = Math.sin(p.angle);
    const lx = -fy, ly = fx;

    const thrust = p.input.thrust || 0;
    p.vx += fx * thrust * stats.accel * DT;
    p.vy += fy * thrust * stats.accel * DT;

    const fwdSpd = p.vx * fx + p.vy * fy;
    const latSpd = p.vx * lx + p.vy * ly;
    const fwdNew = fwdSpd * Math.exp(-stats.fwdDrag * DT);
    const latNew = latSpd * Math.exp(-stats.latDrag * DT);
    p.vx = fwdNew * fx + latNew * lx;
    p.vy = fwdNew * fy + latNew * ly;

    const spd = Math.hypot(p.vx, p.vy);
    if (spd > stats.maxSpeed) {
      p.vx *= stats.maxSpeed / spd;
      p.vy *= stats.maxSpeed / spd;
    }

    p.x = wrapX(p.x + p.vx * DT);
    p.y = wrapY(p.y + p.vy * DT);

    if (p.input.shoot && p.fireCooldown <= 0) {
      bullets.push({
        id: nextBulletId++,
        x: p.x, y: p.y,
        vx: Math.cos(p.input.angle) * stats.bulletSpeed,
        vy: Math.sin(p.input.angle) * stats.bulletSpeed,
        life: BULLET_LIFE,
        ownerId: p.id,
        damage: stats.bulletDamage,
      });
      p.fireCooldown = stats.fireCooldown;
      p.input.shoot = false;
    }
  }
}

function updateRocks() {
  const df = Math.exp(-ROCK_DRAG * DT);
  for (const rock of rocks) {
    rock.vx *= df;
    rock.vy *= df;
    const rs = Math.hypot(rock.vx, rock.vy);
    if (rs > ROCK_MAX_SPEED) {
      rock.vx *= ROCK_MAX_SPEED / rs;
      rock.vy *= ROCK_MAX_SPEED / rs;
    }
    rock.x = wrapX(rock.x + rock.vx * DT);
    rock.y = wrapY(rock.y + rock.vy * DT);
  }
}

function updateBullets() {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x = wrapX(b.x + b.vx * DT);
    b.y = wrapY(b.y + b.vy * DT);
    b.life -= DT;

    let hit = false;

    for (let r = rocks.length - 1; r >= 0; r--) {
      const rock = rocks[r];
      if (Math.hypot(torusDelta(b.x, rock.x, WORLD_W), torusDelta(b.y, rock.y, WORLD_H)) < rock.r) {
        rock.hp -= b.damage;
        hit = true;
        if (rock.hp <= 0) {
          spawnGemsAt(rock.x, rock.y, rock.r);
          spawnXpAt(rock.x, rock.y, Math.max(1, Math.round(rock.r / PLAYER_R)));
          rocks.splice(r, 1);
          rocks.push(spawnRock());
        }
        break;
      }
    }

    if (!hit) {
      for (const [, p] of players) {
        if (p.id === b.ownerId || p.dead) continue;
        if (Math.hypot(torusDelta(b.x, p.x, WORLD_W), torusDelta(b.y, p.y, WORLD_H)) < PLAYER_R) {
          const pStats = computeStats(p);
          p.hp = Math.max(0, p.hp - b.damage);
          p.regenCooldown = pStats.regenDelay;
          hit = true;
          if (p.hp <= 0) killPlayer(p);
          break;
        }
      }
    }

    if (hit || b.life <= 0) bullets.splice(i, 1);
  }
}

function updateGems() {
  for (let i = gems.length - 1; i >= 0; i--) {
    const g = gems[i];
    g.x = wrapX(g.x + g.vx * DT);
    g.y = wrapY(g.y + g.vy * DT);
    g.vx *= Math.exp(-3 * DT);
    g.vy *= Math.exp(-3 * DT);
    g.life -= DT;

    let removed = false;
    for (const [, p] of players) {
      if (p.dead) continue;
      const mdx = torusDelta(p.x, g.x, WORLD_W);
      const mdy = torusDelta(p.y, g.y, WORLD_H);
      const mdist = Math.hypot(mdx, mdy);
      if (mdist < GEM_MAGNET_RADIUS && mdist > 1) {
        const force = (1 - mdist / GEM_MAGNET_RADIUS) * GEM_MAGNET_FORCE;
        g.vx += (mdx / mdist) * force * DT;
        g.vy += (mdy / mdist) * force * DT;
      }
      if (mdist <= PLAYER_R + g.r) {
        p.gemCount += g.value;
        gems.splice(i, 1);
        removed = true;
        break;
      }
    }
    if (!removed && g.life <= 0) gems.splice(i, 1);
  }
}

function updateXpDrops() {
  for (let i = xpDrops.length - 1; i >= 0; i--) {
    const x = xpDrops[i];
    x.x = wrapX(x.x + x.vx * DT);
    x.y = wrapY(x.y + x.vy * DT);
    x.vx *= Math.exp(-3 * DT);
    x.vy *= Math.exp(-3 * DT);
    x.life -= DT;

    let removed = false;
    for (const [, p] of players) {
      if (p.dead) continue;
      const mdx = torusDelta(p.x, x.x, WORLD_W);
      const mdy = torusDelta(p.y, x.y, WORLD_H);
      const mdist = Math.hypot(mdx, mdy);
      if (mdist < XP_MAGNET_RADIUS && mdist > 1) {
        const force = (1 - mdist / XP_MAGNET_RADIUS) * XP_MAGNET_FORCE;
        x.vx += (mdx / mdist) * force * DT;
        x.vy += (mdy / mdist) * force * DT;
      }
      if (mdist <= PLAYER_R + x.r) {
        p.xpCount += x.value;
        p.totalXpEarned += x.value;
        const newLevel = getLevel(p.totalXpEarned);
        if (newLevel > p.level) {
          for (let l = p.level + 1; l <= newLevel; l++)
            if (AWARD_LEVELS.has(l)) p.upgradePoints++;
          p.level = newLevel;
        }
        xpDrops.splice(i, 1);
        removed = true;
        break;
      }
    }
    if (!removed && x.life <= 0) xpDrops.splice(i, 1);
  }
}

function checkPlayerRockCollisions() {
  for (const [, p] of players) {
    if (p.dead) continue;
    const stats = computeStats(p);

    for (let i = rocks.length - 1; i >= 0; i--) {
      const rock = rocks[i];
      const cdx = torusDelta(p.x, rock.x, WORLD_W);
      const cdy = torusDelta(p.y, rock.y, WORLD_H);
      const dist = Math.hypot(cdx, cdy);
      const minDist = PLAYER_R + rock.r;

      if (dist < minDist && dist > 0) {
        const overlap = minDist - dist;
        const nx = cdx / dist;
        const ny = cdy / dist;

        const mP = PLAYER_R * PLAYER_R;
        const mR = rock.r * rock.r;
        const invSum = 1 / (mP + mR);

        p.x = wrapX(p.x + nx * overlap * (mR * invSum));
        p.y = wrapY(p.y + ny * overlap * (mR * invSum));
        rock.x = wrapX(rock.x - nx * overlap * (mP * invSum));
        rock.y = wrapY(rock.y - ny * overlap * (mP * invSum));

        const relVx = p.vx - rock.vx;
        const relVy = p.vy - rock.vy;
        const relN = relVx * nx + relVy * ny;

        if (relN < 0) {
          const j = -(1 + 0.15) * relN / (1 / mP + 1 / mR);
          p.vx += (j / mP) * nx;
          p.vy += (j / mP) * ny;
          rock.vx -= (j * stats.collisionPunchMult * 3.0 / mR) * nx;
          rock.vy -= (j * stats.collisionPunchMult * 3.0 / mR) * ny;

          const impact = -relN;
          const baseDmg = Math.max(COLLISION_MIN_DAMAGE, impact / 10);
          const dmg = baseDmg + impact * COLLISION_DAMAGE_SCALE;
          const sizeRatio = rock.r / PLAYER_R;

          const rawDmg = dmg * Math.min(3, Math.max(0.6, sizeRatio)) * 0.15;
          p.hp = Math.max(0, p.hp - rawDmg * (1 - stats.collisionShieldFrac));
          p.regenCooldown = stats.regenDelay;

          const rockDmg = dmg * Math.min(3, Math.max(0.6, 1 / sizeRatio)) * stats.bodyDamageScale / 5;
          rock.hp = Math.max(0, rock.hp - rockDmg);

          if (p.hp <= 0) killPlayer(p);
          if (rock.hp <= 0) {
            spawnGemsAt(rock.x, rock.y, rock.r);
            spawnXpAt(rock.x, rock.y, Math.max(1, Math.round(rock.r / PLAYER_R)));
            rocks.splice(i, 1);
            rocks.push(spawnRock());
          }
        }
      }
    }
  }
}

// --- main loop ---

function tick() {
  physTick++;
  updatePlayers();
  updateRocks();
  updateBullets();
  updateGems();
  updateXpDrops();
  checkPlayerRockCollisions();

  if (physTick % NET_RATE !== 0) return;

  const sendSlow   = physTick % SLOW_RATE === 0;
  const allPlayers = Array.from(players.values()).map(serialize);

  for (const [, p] of players) {
    if (!wsReady(p.ws)) continue;

    const msg = {
      type: 'tick',
      players: allPlayers,
      bullets: bullets
        .filter(b => torusDist(p.x, p.y, b.x, b.y) < VIEW_RANGE)
        .map(b => ({ id: b.id, x: b.x, y: b.y, ownerId: b.ownerId, angle: Math.atan2(b.vy, b.vx) })),
    };

    if (sendSlow) {
      msg.rocks = rocks
        .filter(r => torusDist(p.x, p.y, r.x, r.y) < VIEW_RANGE)
        .map(serializeRock);
      msg.gems = gems
        .filter(g => torusDist(p.x, p.y, g.x, g.y) < VIEW_RANGE)
        .map(g => ({ id: g.id, x: g.x, y: g.y, r: g.r }));
      msg.xpDrops = xpDrops
        .filter(x => torusDist(p.x, p.y, x.x, x.y) < VIEW_RANGE)
        .map(x => ({ id: x.id, x: x.x, y: x.y, r: x.r }));
    }

    send(p.ws, msg);
  }
}

initRocks();
setInterval(tick, 1000 / TICK_RATE);

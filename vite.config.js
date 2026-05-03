import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 4000,
    allowedHosts: ['campus-growing-clarity.ngrok-free.dev'],
    proxy: {
      '/auth': { target: 'http://localhost:8080', changeOrigin: true },
      '/ws':   { target: 'ws://localhost:8080',   ws: true, changeOrigin: true },
    },
  },
});

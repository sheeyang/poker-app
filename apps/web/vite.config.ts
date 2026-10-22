import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react(), {
    name: 'participant-safe-browser',
    resolveId(source) {
      if (/^@poker\/(engine|strategies|solver|simulation|research|server)(\/|$)/.test(source)) throw new Error('Authoritative packages cannot enter the browser: ' + source);
      return null;
    },
    load(id) {
      if (/[\\/]packages[\\/](engine|strategies|solver|simulation|research)[\\/]/.test(id)) throw new Error('Authoritative implementation cannot enter the browser: ' + id);
      return null;
    },
  }],
  server: { port: 5174, strictPort: true, proxy: { '/api': { target: process.env.POKER_API_TARGET ?? 'http://127.0.0.1:3001', ws: true } } },
});

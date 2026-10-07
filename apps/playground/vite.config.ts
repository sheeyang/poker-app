import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  plugins: [
    react(), tailwindcss(),
    { name: 'participant-safe-browser', resolveId(source) {
      if (/^@poker\/(engine|strategies|solver|simulation|research|server)(\/|$)/.test(source)) throw new Error('Authoritative packages cannot enter the browser: ' + source);
      return null;
    }, load(id) {
      if (/[\\/]packages[\\/](engine|strategies|solver|simulation|research)[\\/]/.test(id)) throw new Error('Authoritative implementation cannot enter the browser: ' + id);
      return null;
    } },
  ],
  server: { port: 5173, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:3001', ws: true } } },
});

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Bibliotecas num arquivo separado: mudam pouco, então o navegador reaproveita do cache a cada atualização.
        manualChunks(id) {
          if (/node_modules[\\/](react|react-dom|scheduler|react-router|@tanstack)[\\/]/.test(id))
            return 'vendor';
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
      // Tempo real do WhatsApp (Socket.io).
      '/socket.io': { target: 'http://127.0.0.1:3000', ws: true, changeOrigin: false },
    },
  },
});

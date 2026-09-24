import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // Em desenvolvimento, o Vite repassa a API e o tempo real para o backend rodando no Docker.
    // changeOrigin: false mantém o endereço original, que o backend compara com a origem da página.
    proxy: {
      '/api': { target: 'http://localhost:3100', changeOrigin: false },
      '/socket.io': { target: 'http://localhost:3100', ws: true, changeOrigin: false },
    },
  },
});

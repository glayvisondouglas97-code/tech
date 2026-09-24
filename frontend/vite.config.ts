import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // Em desenvolvimento, o Vite repassa as chamadas /api para o backend rodando no Docker.
    proxy: { '/api': 'http://localhost:3100' },
  },
});

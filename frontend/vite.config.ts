import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:17890',
    },
  },
  build: {
    outDir: 'dist',
    cssMinify: false,
  },
});

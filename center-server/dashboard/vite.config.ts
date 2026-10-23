import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/dashboard/',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/admin': { target: process.env.CENTER_URL || 'http://127.0.0.1:8443', secure: false } } },
});

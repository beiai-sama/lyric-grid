import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: 'static', base: '/lyric-grid/', publicDir: '../public',
  plugins: [react()], css: { postcss: { plugins: [tailwindcss()] } },
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)), 'next/server': fileURLToPath(new URL('./static/response.ts', import.meta.url)) } },
  define: { 'import.meta.env.VITE_STATIC_SITE': 'true' },
  build: { outDir: '../out', emptyOutDir: true },
});

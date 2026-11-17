import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/web',
  base: './',
  plugins: [react()],
  build: { outDir: '../../dist/web', emptyOutDir: true, license: { fileName: 'THIRD_PARTY_NOTICES.md' } },
});

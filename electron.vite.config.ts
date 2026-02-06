import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    entry: 'src/main/index.ts',
  },
  preload: {
    input: {
      index: resolve(__dirname, 'src/preload/index.ts'),
    },
  },
  renderer: {
    root: 'src/renderer',
    build: {
      outDir: '../../dist/renderer',
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
      },
    },
    plugins: [react()],
  },
});

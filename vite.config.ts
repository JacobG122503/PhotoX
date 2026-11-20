import { defineConfig } from 'vite';
import { photosBridge } from './vite-photos-bridge';

export default defineConfig({
  plugins: [photosBridge()],
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  server: { port: 5179, open: true },
  preview: { port: 5179, open: true },
});

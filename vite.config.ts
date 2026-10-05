import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { chunkSizeWarningLimit: 700 }, // one ~145 kB gzip bundle, cached by the service worker
  test: {
    include: ['shared/**/*.test.ts', 'worker/**/*.test.ts', 'src/**/*.test.ts'],
  },
} as any);

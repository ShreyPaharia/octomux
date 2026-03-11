import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:7777',
      '/ws': {
        target: 'ws://localhost:7777',
        ws: true,
      },
    },
    watch: {
      // Ignore git worktrees so agent file changes don't trigger HMR/reloads
      ignored: ['**/.worktrees/**'],
    },
  },
  build: {
    outDir: 'dist',
  },
});

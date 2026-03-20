import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

const backendPort = process.env.PORT || 7777;

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
      '/api': `http://localhost:${backendPort}`,
      '/ws': {
        target: `ws://localhost:${backendPort}`,
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
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react-dom/') || id.includes('node_modules/react/')) {
            return 'vendor-react';
          }
          if (
            id.includes('node_modules/react-router/') ||
            id.includes('node_modules/react-router-dom/')
          ) {
            return 'vendor-router';
          }
          if (id.includes('node_modules/@xterm/')) {
            return 'vendor-xterm';
          }
          if (id.includes('node_modules/@base-ui/')) {
            return 'vendor-ui';
          }
        },
      },
    },
  },
});

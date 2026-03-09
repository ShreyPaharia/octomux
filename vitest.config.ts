import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    env: {
      NODE_ENV: 'test',
    },
    projects: [
      {
        test: {
          name: 'server',
          globals: true,
          environment: 'node',
          include: ['server/**/*.test.ts'],
        },
      },
      {
        resolve: {
          alias: {
            '@': path.resolve(__dirname, './src'),
          },
        },
        test: {
          name: 'ui',
          globals: true,
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
          setupFiles: ['src/test-setup.ts'],
        },
      },
    ],
  },
});

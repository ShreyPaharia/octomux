import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@octomux/api-client': path.resolve(__dirname, './packages/api-client/src/index.ts'),
      '@octomux/diff-engine': path.resolve(__dirname, './packages/diff-engine/src/index.ts'),
      '@octomux/test-fixtures': path.resolve(__dirname, './packages/test-fixtures/src/index.ts'),
      '@octomux/types': path.resolve(__dirname, './packages/types/src/index.ts'),
    },
  },
  test: {
    env: {
      NODE_ENV: 'test',
    },
    projects: [
      {
        test: {
          name: 'api-client',
          globals: true,
          environment: 'node',
          include: ['packages/api-client/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'diff-engine',
          globals: true,
          environment: 'node',
          include: ['packages/diff-engine/**/*.test.ts'],
        },
      },
      {
        resolve: {
          alias: {
            '@octomux/diff-engine': path.resolve(__dirname, './packages/diff-engine/src/index.ts'),
            '@octomux/test-fixtures': path.resolve(
              __dirname,
              './packages/test-fixtures/src/index.ts',
            ),
            '@octomux/types': path.resolve(__dirname, './packages/types/src/index.ts'),
          },
        },
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
            '@octomux/api-client': path.resolve(__dirname, './packages/api-client/src/index.ts'),
            '@octomux/test-fixtures': path.resolve(
              __dirname,
              './packages/test-fixtures/src/index.ts',
            ),
            '@octomux/types': path.resolve(__dirname, './packages/types/src/index.ts'),
          },
        },
        test: {
          name: 'ui',
          globals: true,
          environment: 'jsdom',
          include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
          setupFiles: ['src/test-setup.ts'],
        },
      },
      {
        resolve: {
          alias: {
            '@octomux/api-client': path.resolve(__dirname, './packages/api-client/src/index.ts'),
            '@octomux/types': path.resolve(__dirname, './packages/types/src/index.ts'),
          },
        },
        test: {
          name: 'cli',
          globals: true,
          environment: 'node',
          include: ['cli/src/**/*.test.ts'],
        },
      },
      {
        resolve: {
          alias: {
            '@octomux/diff-engine': path.resolve(__dirname, './packages/diff-engine/src/index.ts'),
            '@octomux/test-fixtures': path.resolve(
              __dirname,
              './packages/test-fixtures/src/index.ts',
            ),
            '@octomux/types': path.resolve(__dirname, './packages/types/src/index.ts'),
          },
        },
        test: {
          name: 'cli-review',
          globals: true,
          environment: 'node',
          include: ['cli/review/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'bin',
          globals: true,
          environment: 'node',
          include: ['bin/**/*.test.ts'],
        },
      },
    ],
  },
});

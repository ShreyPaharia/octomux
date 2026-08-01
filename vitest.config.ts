import { defineConfig, defaultExclude } from 'vitest/config';
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
          // diff-base.test.ts drives resolveDiffBase with mocked exec + fake
          // timers and asserts against the real ATTEMPT_TIMEOUT_MS default —
          // it must NOT get the test-env timeout override below.
          name: 'diff-engine-unit',
          globals: true,
          environment: 'node',
          include: ['packages/diff-engine/src/diff-base.test.ts'],
        },
      },
      {
        test: {
          name: 'diff-engine',
          globals: true,
          environment: 'node',
          include: ['packages/diff-engine/**/*.test.ts'],
          exclude: [...defaultExclude, 'packages/diff-engine/src/diff-base.test.ts'],
          // Real `git` subprocesses in beforeEach/tests can exceed the 5s
          // default under CPU contention (see diff-base.ts OCTOMUX_DIFF_TIMEOUT_MS).
          testTimeout: 20_000,
          hookTimeout: 20_000,
          env: {
            OCTOMUX_DIFF_TIMEOUT_MS: '30000',
          },
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
          testTimeout: 20_000,
          hookTimeout: 20_000,
          env: {
            OCTOMUX_DIFF_TIMEOUT_MS: '30000',
          },
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

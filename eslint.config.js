import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  // CLI needs console.log
  {
    files: ['cli/src/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  // Relax rules for test files
  {
    files: ['**/*.test.ts', '**/test-helpers.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      'no-console': 'off',
    },
  },
  // Guard: ban direct 'tmux' invocations in server source — use execTmux()/tmuxSpawnSpec() instead.
  {
    files: ['server/**/*.ts'],
    ignores: ['server/**/*.test.ts', 'server/tmux-bin.ts', 'server/test-helpers.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.name=/^(execFile|execFileSync|spawn)$/] Literal[value='tmux']",
          message:
            "Do not invoke 'tmux' directly — use execTmux()/tmuxSpawnSpec() from server/tmux-bin.ts.",
        },
      ],
    },
  },
  // Guard: ban direct DB access (getDb()/.prepare()) outside the repository layer.
  {
    files: ['server/**/*.ts'],
    ignores: [
      'server/**/*.test.ts',
      'server/tmux-bin.ts',
      'server/test-helpers.ts',
      'server/db.ts',
      'server/repositories/**',
      'server/orchestrator/**',
      'server/integrations/**',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.name=/^(execFile|execFileSync|spawn)$/] Literal[value='tmux']",
          message:
            "Do not invoke 'tmux' directly — use execTmux()/tmuxSpawnSpec() from server/tmux-bin.ts.",
        },
        {
          selector: "CallExpression[callee.name='getDb']",
          message:
            'Do not call getDb() outside the repository layer (server/repositories/). Add or use a repository function instead.',
        },
        {
          selector: "CallExpression[callee.property.name='prepare']",
          message:
            'Do not call .prepare() outside the repository layer (server/repositories/). Add or use a repository function instead.',
        },
      ],
    },
  },
  // Guard: ban express imports in the service layer — services must stay HTTP-agnostic.
  {
    files: ['server/services/**/*.ts'],
    ignores: ['server/services/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'express',
              message: 'Services must not import express — keep them HTTP-agnostic.',
            },
          ],
        },
      ],
    },
  },
  {
    ignores: [
      'dist/',
      'dist-server/',
      'cli/dist/',
      'node_modules/',
      'data/',
      'coverage/',
      '.worktrees/',
      '.claude/',
      // Workflow scripts run in the Workflow runtime with injected globals
      // (agent/parallel/pipeline/phase/log/args/budget) — not lintable as app code.
      'workflows/',
      '.local/',
      '.config/',
      '.remember/',
      '*.config.js',
      '*.config.ts',
      // Per-platform tmux packages are pure CJS modules published separately.
      'packages/',
      // electron/ has its own tsconfig and uses Electron types not in the main project.
      'electron/',
      'dist-electron/',
      // .cjs files are intentional CommonJS (build/electron hooks) — the ESM
      // TS rules (e.g. no-require-imports) don't apply to them.
      '**/*.cjs',
    ],
  },
);

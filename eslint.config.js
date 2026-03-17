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
  {
    ignores: [
      'dist/',
      'dist-server/',
      'cli/dist/',
      'node_modules/',
      'data/',
      'coverage/',
      '.worktrees/',
      '*.config.js',
      '*.config.ts',
    ],
  },
);

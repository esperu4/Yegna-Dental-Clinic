import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.astro/**',
      '**/.wrangler/**',
      '**/coverage/**',
      '**/worker-configuration.d.ts',
      'packages/db/migrations/**',
      // Agents' git worktrees: each is linted in its own checkout.
      '.claude/worktrees/**',
      '**/.lighthouseci/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Node-run files: config, scripts, hooks, tests.
    files: ['**/*.{js,mjs,cjs}', '**/scripts/**', '**/test/**', '**/*.config.ts', '.claude/**'],
    languageOptions: { globals: globals.node },
  },
  {
    // Command-line scripts report on stdout (no patient data: they run on fixtures and counts).
    files: ['**/scripts/**'],
    rules: { 'no-console': 'off' },
  },
);

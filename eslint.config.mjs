import eslint from '@eslint/js'
import regexp from 'eslint-plugin-regexp'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: { project: './tsconfig.json' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
    },
  },
  {
    files: ['tests/**/*.ts'],
    languageOptions: {
      parserOptions: { project: './tsconfig.test.json' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
    },
  },
  {
    files: ['vscode-extension/src/**/*.ts'],
    languageOptions: {
      parserOptions: { project: './vscode-extension/tsconfig.json' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
    },
  },
  {
    files: ['vscode-extension/tests/**/*.ts'],
    languageOptions: {
      parserOptions: { project: './vscode-extension/tsconfig.tests.json' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
    },
  },
  /**
   * Catastrophic-backtracking gate. Token-goat runs 2,307 regular expressions over command output,
   * fetched pages and extracted documents -- input it does not control -- so a pattern that
   * backtracks super-linearly is a denial-of-service reachable from ordinary use rather than a
   * style problem.
   *
   * `no-super-linear-backtracking` is the rule that matters: it does automaton analysis rather than
   * the star-height heuristic older tools use, and it distinguishes polynomial from exponential.
   * Turning it on found thirty-nine exponential cases. The worst was a flag-matching idiom in the
   * Bash command classifier whose runtime doubled per flag: a command line of `npm` plus 28 short
   * flags and a rejecting suffix took 1.6 seconds, and 40 flags would take roughly two hours. All
   * thirty-nine are fixed; the remaining reports are polynomial and are carried in
   * `eslint-suppressions.json` so they can only shrink, never grow.
   *
   * `no-super-linear-move` is off here as it is in the plugin's own recommended config: it reports
   * quadratic *move* cost, which for the line-at-a-time inputs these patterns see is not the same
   * class of risk, and enabling it would bury the backtracking reports it shares a file with.
   */
  {
    files: ['src/**/*.ts', 'vscode-extension/src/**/*.ts'],
    plugins: { regexp },
    rules: {
      'regexp/no-super-linear-backtracking': 'error',
      'regexp/no-empty-lookarounds-assertion': 'error',
      'regexp/no-useless-backreference': 'error',
      'regexp/no-potentially-useless-backreference': 'error',
      'regexp/no-misleading-capturing-group': 'error',
      'regexp/no-empty-character-class': 'error',
      'regexp/no-lazy-ends': 'error',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'vscode-extension/out/**', 'vscode-extension/node_modules/**', '*.mjs'],
  },
)

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
  /**
   * Repository tooling under `scripts/`: the fingerprint checker, the git-hook installer, the
   * Dependabot lock refresher, the harness-schema extractor, the model warm step, and the demo
   * generators. These run under Node with no bundler and no DOM, and every one of the 41 `no-undef`
   * errors this directory reported before it came under lint was a correct use of a Node runtime
   * global (`process` 39 times, `Buffer` once, `console` once) against a config that declared no
   * environment at all. Declaring the environment is the fix; switching `no-undef` off for the
   * directory would be the suppression, and would also stop catching a genuine typo.
   */
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        AbortController: 'readonly',
        Buffer: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        clearInterval: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        performance: 'readonly',
        process: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
        structuredClone: 'readonly',
      },
    },
  },
  {
    files: ['scripts/**/*.ts'],
    languageOptions: {
      parserOptions: { project: './tsconfig.tests.json' },
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

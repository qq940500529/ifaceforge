export default [
  {
    files: ['fixtures/**/*.mjs', 'scripts/**/*.mjs', '*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: Object.fromEntries(
        ['Buffer', 'console', 'URL', 'process', 'Response', 'Error', 'setTimeout', 'clearTimeout', 'fetch'].map(
          (key) => [key, 'readonly'],
        ),
      ),
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-unreachable': 'error',
      'no-constant-binary-expression': 'error',
      'no-dupe-keys': 'error',
    },
  },
];

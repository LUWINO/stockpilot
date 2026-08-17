import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

/**
 * Flat config. `eslint-config-next` v16 exports flat arrays directly, so no
 * `FlatCompat` shim is needed.
 */
const config = [
  {
    ignores: ['.next/**', 'node_modules/**', 'coverage/**', 'next-env.d.ts', 'drizzle/**'],
  },

  ...nextCoreWebVitals,
  ...nextTypescript,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Money and quantities are integers throughout; parsing a float is a
      // correctness hazard, not a style preference.
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'Use the Money and Quantity helpers in src/core instead.' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  {
    // The worker, the logger and scripts are the sanctioned places to write to stdout.
    files: ['src/worker/**/*.ts', 'src/server/logger.ts', 'scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },

  {
    // Tests assert on shapes that are deliberately partial or malformed.
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
];

export default config;

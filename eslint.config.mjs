// @ts-check

import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Linting covers src/ only: type-aware rules need the TypeScript project, which
// is src/. tsconfig.eslint.json is tsconfig.json with the test files included.
export default defineConfig(
  globalIgnores(['dist']),
  {
    files: ['src/**/*.ts'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strict,
      tseslint.configs.stylistic,
    ],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      complexity: ['warn', 10],
      'max-depth': ['error', 3],
      '@typescript-eslint/switch-exhaustiveness-check': 'error'
    },
  },
);

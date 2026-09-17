// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettierConfig,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // $queryRawUnsafe is banned project-wide (docs/ARCHITECTURE.md §29.6).
      'no-restricted-properties': [
        'error',
        {
          property: '$queryRawUnsafe',
          message: 'Use the tagged-template $queryRaw. $queryRawUnsafe is banned.',
        },
        {
          property: '$executeRawUnsafe',
          message: 'Use the tagged-template $executeRaw. $executeRawUnsafe is banned.',
        },
      ],
      'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
    },
  },
  {
    // Money is bigint and quantities are decimal strings; `Number(...)` on
    // either is the exact bug the type choice exists to prevent
    // (docs/ARCHITECTURE.md §34, risk 13). Scoped to the modules that actually
    // handle money — applied project-wide it fires on `Type(() => Number)` in
    // DTOs and on `Number.isSafeInteger`, and a rule that is mostly false
    // positives gets switched off wholesale.
    files: ['src/common/money/**/*.ts', 'src/**/pricing/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'Number', message: 'Do not convert money (bigint) or quantities to Number.' },
      ],
    },
  },
  {
    // Test files legitimately assert on `any`-shaped JSON response bodies.
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts', 'prisma/seed.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
);

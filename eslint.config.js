import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {ignores: ['dist/**', 'coverage*/**', 'node_modules/**', 'eslint.config.js']},
  eslint.configs.recommended,
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {globals: {process: 'readonly'}}
  },
  ...tseslint.configs.recommendedTypeChecked.map(config => ({...config, files: ['**/*.ts']})),
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error'
    }
  }
);

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /* Keep the example deliberately simple. These limits mirror the
         complexity checks a SonarQube quality gate would apply. */
      complexity: ["error", 15],
      "max-depth": ["error", 4],
      "max-lines": ["error", 600],
      "max-lines-per-function": ["error", 230],
      "max-params": ["error", 6],
      eqeqeq: ["error", "always"],
      "no-console": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["test/**/*.ts", "e2e/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "test-results/**", "playwright-report/**"],
  },
);

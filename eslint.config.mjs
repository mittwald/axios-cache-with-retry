import eslint from "@eslint/js";
import importPlugin from "eslint-plugin-import";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist", "**/*.cjs", "**/.vitest"],
  },
  importPlugin.flatConfigs.recommended,
  eslint.configs.recommended,
  eslintPluginPrettierRecommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.stylistic,
  {
    rules: {
      "linebreak-style": ["error", "unix"],
      quotes: [
        "error",
        "double",
        {
          avoidEscape: true,
        },
      ],
      semi: ["error", "always"],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          varsIgnorePattern: "[iI]gnored",
          argsIgnorePattern: "[iI]gnored",
          caughtErrorsIgnorePattern: "[iI]gnored",
        },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          fixStyle: "separate-type-imports",
        },
      ],
      "import/no-unresolved": ["off"],
      "import/no-named-as-default-member": ["off"],
      "import/extensions": [
        "error",
        "always",
        {
          ignorePackages: true,
          ts: "always",
          js: "always",
        },
      ],
    },
  },
);

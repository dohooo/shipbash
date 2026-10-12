import tseslint from "typescript-eslint";
import nextPlugin from "@next/eslint-plugin-next";

const disciplineRules = {
  complexity: ["warn", { max: 15 }],
  "max-lines": ["warn", { max: 400, skipBlankLines: true, skipComments: true }],
  "max-lines-per-function": [
    "warn",
    { max: 100, skipBlankLines: true, skipComments: true, IIFEs: true },
  ],
};

export default tseslint.config(
  {
    linterOptions: {
      noInlineConfig: true,
    },
    ignores: [
      "**/.next/**",
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "apps/console/app/.well-known/**",
      "apps/marketing/public/shipbash-brand/**",
      "brand/exports/**",
      "apps/console/components/ai-elements/**",
      "apps/console/public/shipbash-brand/**",
    ],
  },
  {
    files: ["**/*.{js,jsx,cjs,mjs}"],
    rules: disciplineRules,
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      "@next/next": nextPlugin,
    },
    rules: {
      ...disciplineRules,
      "@typescript-eslint/consistent-type-assertions": [
        "warn",
        { assertionStyle: "never" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
);

import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "apps/desktop/src-tauri/target/**",
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.base,
  {
    files: ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/exhaustive-deps": "off",
    },
  },
  {
    files: [
      "apps/**/*.{ts,tsx}",
      "packages/**/*.{ts,tsx}",
      "scripts/**/*.{mjs,ts}",
    ],
    rules: {
      "no-constant-binary-expression": "error",
      "no-debugger": "error",
      "no-duplicate-case": "error",
      "no-fallthrough": "error",
      "no-irregular-whitespace": "error",
      "no-obj-calls": "error",
      "no-sparse-arrays": "error",
      "no-unexpected-multiline": "error",
      "no-unreachable": "error",
      "valid-typeof": "error",
      "no-undef": "off",
      "no-unused-vars": "off",
      "no-useless-assignment": "off",
      "no-useless-escape": "off",
      "preserve-caught-error": "off",
      "prefer-const": "off",
    },
  },
);

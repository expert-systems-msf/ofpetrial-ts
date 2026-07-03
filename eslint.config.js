import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import unicorn from "eslint-plugin-unicorn";
import prettier from "eslint-config-prettier";

export default defineConfig(
  ...tseslint.configs.recommended,
  unicorn.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // --- unicorn: OFF (pure style/opinion, no correctness value) ---
      "unicorn/prevent-abbreviations": "off", // opinionated identifier renames
      "unicorn/name-replacements": "off", // Dir→Directory etc.
      "unicorn/no-null": "off", // GeoJSON/turf legitimately use null
      "unicorn/prefer-export-from": "off", // named re-exports are the lib's API surface
      "unicorn/import-style": "off",
      "unicorn/consistent-boolean-name": "off",
      "unicorn/no-break-in-nested-loop": "off",
      "unicorn/no-array-reduce": "off",
      "unicorn/no-for-each": "off",
      "unicorn/no-array-callback-reference": "off", // false-positives on point-in-polygon preds
      "unicorn/max-nested-calls": "off",
      "unicorn/consistent-function-scoping": "off",
      "unicorn/prefer-minimal-ternary": "off",
      "unicorn/no-negated-comparison": "off",
      "unicorn/prefer-single-array-predicate": "off",
      "unicorn/prefer-default-parameters": "off", // `?? "ls"` handles null too; default params only undefined
      "unicorn/no-chained-comparison": "off", // false-positive on intentional `(a === b) === flag`

      // --- unicorn: WARN (modernization backlog, non-blocking) ---
      "unicorn/no-array-sort": "warn",
      "unicorn/no-array-reverse": "warn",
      "unicorn/prefer-iterator-to-array": "warn",
      "unicorn/prefer-code-point": "warn",
      "unicorn/no-unreadable-for-of-expression": "warn",
      "unicorn/prefer-unicode-code-point-escapes": "warn",
      "unicorn/no-new-array": "warn",
      "unicorn/prefer-math-trunc": "warn",
      "unicorn/prefer-hoisting-branch-code": "warn",
      "unicorn/prefer-object-iterable-methods": "warn",

      // everything else in unicorn/recommended stays ERROR (correctness gate),
      // notably unicorn/require-array-sort-compare — numeric .sort() without a
      // comparator is a real lexicographic-ordering bug.
    },
  },
  // must be last: disables eslint rules that conflict with prettier formatting
  prettier
);

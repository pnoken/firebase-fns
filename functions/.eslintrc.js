module.exports = {
  root: true,
  env: {
    es2021: true,
    node: true,
  },
  extends: [
    "eslint:recommended",
    "plugin:import/errors",
    "plugin:import/warnings",
    "plugin:import/typescript",
    "google",
    "plugin:@typescript-eslint/recommended",
  ],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: ["tsconfig.json", "tsconfig.dev.json"],
    sourceType: "module",
  },
  ignorePatterns: [
    "/lib/**/*", // Ignore built files.
    "/generated/**/*", // Ignore generated files.
  ],
  plugins: [
    "@typescript-eslint",
    "import",
  ],
  rules: {
    "quotes": ["error", "double"],
    "import/no-unresolved": 0,

    // Team/dev-environment friendly defaults (Windows + TS).
    "linebreak-style": 0,
    "require-jsdoc": 0,
    "valid-jsdoc": 0,
    "max-len": ["error", { code: 120, ignoreStrings: true, ignoreTemplateLiterals: true, ignoreComments: true }],
    "object-curly-spacing": ["error", "always"],
    "indent": ["error", 4],
  },
};

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/generated/**",
      "index.html",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // Sovereignty barrier (CLAUDE.md rule #1): no direct LLM provider SDK from
    // business code — every model call goes through packages/classifier + LiteLLM.
    // No directory-wide exemption: @anthropic-ai/claude-agent-sdk (agent-runtime)
    // is NOT in this list, so it needs none. If a precise exemption is ever
    // required, re-declare the rule for that path minus one entry — never ignore
    // the whole directory.
    files: ["apps/**/*.ts", "apps/**/*.tsx", "mcp-servers/**/*.ts", "packages/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "openai", message: "Appel LLM direct interdit : passe par packages/classifier + LiteLLM." },
            { name: "@anthropic-ai/sdk", message: "Appel LLM direct interdit : passe par packages/classifier + LiteLLM." },
            { name: "cohere-ai", message: "Appel LLM direct interdit : passe par packages/classifier + LiteLLM." },
            { name: "groq-sdk", message: "Appel LLM direct interdit : passe par packages/classifier + LiteLLM." },
            { name: "replicate", message: "Appel LLM direct interdit : passe par packages/classifier + LiteLLM." },
            { name: "together-ai", message: "Appel LLM direct interdit : passe par packages/classifier + LiteLLM." },
            { name: "ollama", message: "Appel LLM direct interdit : passe par packages/classifier + LiteLLM." },
          ],
          patterns: [
            {
              group: [
                "openai/*",
                "@anthropic-ai/sdk/*",
                "@anthropic-ai/bedrock-sdk*",
                "@anthropic-ai/vertex-sdk*",
                "@mistralai/*",
                "@google/generative-ai*",
                "@google-cloud/vertexai*",
                "@azure/openai*",
                "@aws-sdk/client-bedrock*",
                "@huggingface/inference*",
              ],
              message: "Appel LLM direct interdit : passe par packages/classifier + LiteLLM.",
            },
          ],
        },
      ],
    },
  },
);

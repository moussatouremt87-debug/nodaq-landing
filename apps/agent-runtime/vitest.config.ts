import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@nodaq/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
      "@nodaq/classifier": fileURLToPath(
        new URL("../../packages/classifier/src/index.ts", import.meta.url),
      ),
      "@nodaq/llm": fileURLToPath(new URL("../../packages/llm/src/index.ts", import.meta.url)),
      "@nodaq/mcp-actions": fileURLToPath(
        new URL("../../mcp-servers/actions/src/index.ts", import.meta.url),
      ),
      "@nodaq/mcp-connectors": fileURLToPath(
        new URL("../../mcp-servers/connectors/src/index.ts", import.meta.url),
      ),
      "@nodaq/secrets": fileURLToPath(
        new URL("../../packages/secret-manager/src/index.ts", import.meta.url),
      ),
      "@nodaq/db/admin": fileURLToPath(new URL("../../packages/db/src/admin.ts", import.meta.url)),
      "@nodaq/db": fileURLToPath(new URL("../../packages/db/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // Real shared Postgres: no cross-file parallelism.
    fileParallelism: false,
  },
});

import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@nodaq/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
      "@nodaq/db/admin": fileURLToPath(new URL("../../packages/db/src/admin.ts", import.meta.url)),
      "@nodaq/db": fileURLToPath(new URL("../../packages/db/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    fileParallelism: false,
  },
});

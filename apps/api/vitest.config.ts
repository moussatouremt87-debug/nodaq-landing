import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@nodaq/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
      "@nodaq/db/admin": fileURLToPath(new URL("../../packages/db/src/admin.ts", import.meta.url)),
      "@nodaq/db": fileURLToPath(new URL("../../packages/db/src/index.ts", import.meta.url)),
      "@nodaq/agent-runtime": fileURLToPath(
        new URL("../agent-runtime/src/index.ts", import.meta.url),
      ),
      "@nodaq/llm": fileURLToPath(new URL("../../packages/llm/src/index.ts", import.meta.url)),
      "@nodaq/classifier": fileURLToPath(
        new URL("../../packages/classifier/src/index.ts", import.meta.url),
      ),
      "@nodaq/mcp-actions": fileURLToPath(
        new URL("../../mcp-servers/actions/src/index.ts", import.meta.url),
      ),
      "@nodaq/mcp-connectors": fileURLToPath(
        new URL("../../mcp-servers/connectors/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    fileParallelism: false,
    /*
     * Ouvre la porte du battement injectable — UNIQUEMENT ici.
     *
     * La route lit `ALLOW_TEST_HEARTBEAT`, jamais `NODE_ENV` : une garde dont
     * l'oubli ouvre est une garde à l'envers, et `NODE_ENV` n'est pas posé
     * partout (un `node dist/server.js` lancé à la main, une démo). Ici on
     * l'ouvre explicitement, dans le seul fichier qui décrit l'exécution des
     * tests.
     */
    env: { ALLOW_TEST_HEARTBEAT: "1" },
  },
});

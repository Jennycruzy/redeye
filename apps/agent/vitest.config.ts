import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Agent tests run against the clients package source, so they check the code in the repo
// rather than whatever build the running agent last loaded.
export default defineConfig({
  resolve: {
    alias: {
      "@redeye/clients": fileURLToPath(
        new URL("../packages/clients/src/index.ts", new URL("../", import.meta.url))
      )
    }
  },
  test: {
    environment: "node"
  }
});

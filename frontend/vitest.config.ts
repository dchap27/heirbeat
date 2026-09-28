import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Node's optional native package intentionally omits browser-only WASM
    // collection bindings. Exercise the same WASM primitives as the Vite app.
    alias: {
      "@miden-sdk/miden-sdk": resolve(import.meta.dirname, "test/web-sdk.ts"),
      "@miden-sdk/miden-wallet-adapter": resolve(import.meta.dirname, "test/wallet-adapter.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});

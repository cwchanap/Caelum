import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  server: {
    host: "127.0.0.1",
    port: 5173
  },
  resolve: {
    conditions: ["browser"]
  },
  test: {
    environment: "node",
    globals: true,
    exclude: ["tests/e2e/**", "node_modules/**", "dist/**"],
    environmentMatchGlobs: [
      ["tests/ui/**", "jsdom"]
    ]
  }
});

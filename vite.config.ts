import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  server: {
    host: "127.0.0.1",
    port: 5281,
  },
  resolve: {
    // Ensure Svelte uses browser exports (index-client.js) instead of server exports (index-server.js)
    // This is required for @testing-library/svelte to work correctly in jsdom environment
    conditions: ["browser"],
  },
  test: {
    globals: true,
    exclude: ["tests/e2e/**", "node_modules/**", "dist/**"],
    coverage: {
      provider: "v8",
      // Mirror codecov.yml `ignore`: build/entry side-effect modules that are
      // not unit-testable without contorting mocks around process spawns and
      // Svelte mounting. Excluding them here keeps local coverage reports
      // consistent with the Codecov patch status.
      exclude: [
        "scripts/ensure-wasm.mjs",
        "src/main.ts",
        "src-tauri/**",
        "crates/**",
        "tests/**",
        "vite.config.ts",
        "svelte.config.js",
        "eslint.config.js",
      ],
    },
    projects: [
      {
        extends: true,
        test: {
          name: "ui",
          include: ["tests/ui/**/*.test.ts", "tests/render/**/*.test.ts"],
          environment: "jsdom",
          setupFiles: ["./tests/ui/setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "runtime",
          include: ["tests/runtime/**/*.test.ts"],
          environment: "node",
        },
      },
    ],
  },
});

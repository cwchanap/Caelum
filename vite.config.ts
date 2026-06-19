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
    projects: [
      {
        extends: true,
        test: {
          name: "ui",
          include: ["tests/ui/**/*.test.ts", "tests/render/**/*.test.ts"],
          environment: "jsdom",
          setupFiles: ["@testing-library/jest-dom/vitest"],
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
      {
        extends: true,
        test: {
          name: "simulation",
          include: ["tests/simulation/**/*.test.ts"],
          environment: "node",
        },
      },
    ],
  },
});

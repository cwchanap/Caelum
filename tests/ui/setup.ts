// Loaded by the `ui` vitest project (see vite.config.ts setupFiles).
//
// We import the jest-dom matcher bundle from a local file rather than pointing
// setupFiles directly at "@testing-library/jest-dom/vitest". In a git worktree,
// vitest resolves a bare-specifier setup file via its own (vite-node) path,
// which can walk up to the main repo's node_modules and trip vite's fs.allow.
// Routing through a local file lets vite's own resolver handle the import,
// which correctly prefers this worktree's node_modules in every environment.
import "@testing-library/jest-dom/vitest";

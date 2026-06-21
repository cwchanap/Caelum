# Architecture

Caelum now runs as a shared browser + Tauri frontend with a Svelte shell around the existing TypeScript simulation and canvas renderer.

## Runtime boundary

`createGameRuntime()` is the single owner of mutable frontend state.

- It creates and stores the current `GameState` and `UiState`.
- It applies player intents such as tool changes, overlays, pause/speed toggles, selection, and UI reset.
- It advances the simulation through `tickSimulation`.
- It publishes runtime snapshots for the Svelte shell.
- It mounts the imperative canvas host and keeps rendering tied to runtime-owned state.

The simulation, routing, map growth, transit logic, and objective evaluation remain pure TypeScript and stay independent of Svelte and Tauri.

## Area zoning layer

`Tile.area` is an independent zoning layer held on each tile alongside the physical `kind`. It is retained across `kind` transitions (painting a road over a zoned tile, then bulldozing the road, leaves the area intact) and the renderer only honors it on `kind === "empty"` tiles. The player paints areas (residential / commercial / industrial / office / civic / park) via drag rectangles in the build panel; `src/simulation/areas.ts` owns the paintability gate and the immutable `paintAreaRectangle` writer. Buildings are gated by area: a housing or destination building may only be placed on a tile whose `area` matches the catalog entry's `allowedArea` (`src/simulation/buildings.ts` → `canPlaceBuilding`). Growth waves zone the `area` layer rather than overwriting the tile `kind`, so empty ground stays empty until the player builds on it. Shared tile-query helpers (`samePoint`, `isBuildingOccupied`, `isTransitNodeAt`) live in `src/simulation/tileQueries.ts`, and the building catalog (`BUILDING_CATALOG`) lives in `src/simulation/buildingCatalog.ts` to break the `buildings.ts ↔ buildingSelectors.ts ↔ map.ts` import cycle.

The Growing Suburb scenario ships as a sandbox: the map starts empty (no pre-seeded districts, no timed growth waves, no starting citizens), and growth is entirely player-driven through area painting and building placement. The growth-wave mechanism remains in place and tested for future scenarios.

## UI shell

The shell is fully Svelte-owned:

- `App.svelte` composes the runtime-backed shell and handles visible shell errors.
- `Topbar.svelte` renders live metrics and pause/speed controls from derived runtime state.
- `ControlTower.svelte` renders tools, overlays, and scenario brief data from runtime selectors.
- `GameCanvas.svelte` provides the Svelte host for the imperative canvas while leaving drawing inside the existing render modules.

Svelte consumes derived runtime snapshots and never becomes a second source of truth for gameplay state.

## Canvas rendering

Canvas rendering remains imperative for parity and performance.

- `GameCanvas.svelte` provides the board host element.
- `createGameRuntime()` attaches the real `<canvas>` to that host.
- `src/render/canvas.ts` still owns board sizing, coordinate mapping, and the render pass.
- The existing map, overlay, transit, and citizen renderers remain unchanged aside from runtime call-site integration.

## Hosts

Both hosts start the same frontend:

- **Browser host:** Vite serves the Svelte app for development, tests, and the web build.
- **Tauri host:** packages the same frontend into a macOS desktop app without moving gameplay logic into Rust.

Host bootstrap failures stay in the shell layer, while gameplay validation remains in the runtime and simulation code.

## Runtime flow

1. Svelte components emit user intents to the runtime.
2. The runtime validates and applies those intents through existing action helpers.
3. `tickSimulation` advances suburb growth, transit movement, and objectives.
4. The imperative canvas renderer draws from runtime-owned state.
5. Svelte rerenders from the latest runtime snapshot.

The Growing Suburb scenario remains deterministic for tests: initial state, growth thresholds, generated citizens, identifiers, and objective evaluation stay stable across repeated runs.

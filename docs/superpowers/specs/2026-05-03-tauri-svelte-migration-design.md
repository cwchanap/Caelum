# Tauri + Svelte Migration Design

## Summary

Migrate Caelum from a browser-only Vite TypeScript app to a shared **browser + Tauri desktop** app with a **Svelte UI shell**. The first pass should preserve gameplay parity, keep the simulation and canvas renderer in TypeScript, support the browser as a first-class target, and keep Tauri's responsibility narrow: desktop hosting and packaging for macOS.

This is an incremental host migration, not a full rewrite. The main architectural change is replacing the current imperative DOM shell with Svelte components and introducing a small runtime/controller layer that cleanly separates the engine from the UI host.

## Current State

Caelum currently has:

- A Vite TypeScript frontend.
- Pure TypeScript simulation, domain, and scenario modules.
- Imperative canvas rendering.
- Imperative DOM construction and panel updates in `src/main.ts` and `src/ui/panels.ts`.
- Browser-first tests focused on simulation correctness and smoke coverage.

This is a good starting point for an incremental migration because most gameplay logic is already isolated from the DOM.

## Goals

- Add Tauri as a desktop target for macOS without breaking the browser build.
- Move the app shell, HUD, and control panels to Svelte.
- Keep simulation, domain logic, and canvas rendering mostly unchanged in TypeScript.
- Preserve gameplay behavior with minimal disruption to the codebase.
- Create clean boundaries for future desktop features without taking them on in the first milestone.

## Non-Goals

- No major movement of gameplay logic into Rust in the first pass.
- No desktop-only fork of the game.
- No broad native feature scope such as saves, menus, auto-update, or file-system workflows in the first milestone.
- No rewrite of the core simulation architecture.
- No attempt to replace the canvas renderer with DOM or SVG rendering.

## Recommended Approach

Use a **shared engine + Svelte shell** architecture:

- Keep the engine in TypeScript.
- Introduce a runtime/controller layer between the engine and the UI.
- Replace imperative DOM panels with Svelte components.
- Keep the existing canvas rendering model.
- Add Tauri as a thin desktop host around the same frontend app.

This is the best fit for the desired outcome because it maximizes parity and minimizes churn while still delivering a real Svelte-based application shell.

## Architecture

The migrated app should have one shared frontend core and two hosts:

- **Browser host:** existing web target remains supported for development and verification.
- **Tauri host:** packages the same frontend into a desktop app for macOS.

The frontend core remains mostly TypeScript. Simulation, domain types, scenario data, and canvas rendering stay host-agnostic. Svelte owns the shell around the game surface: layout, HUD, control tower, overlay toggles, and other player-facing controls. Tauri should not own gameplay logic in the first milestone.

The key new boundary is a **runtime/controller** layer that owns mutable game state, UI state, the simulation tick, and player intents. Svelte interacts with that runtime through a narrow API and derived selectors instead of reaching directly into simulation internals.

## Component Boundaries

### 1. Engine Core

Owns:

- Domain types and identifiers
- Scenario setup
- Map, citizens, transit, routing, objectives, and simulation
- Canvas rendering internals

Constraints:

- Must remain independent of Svelte and Tauri
- Must remain directly testable from TypeScript tests

### 2. Runtime / Controller

Owns:

- Initializing game state and UI state
- Running the animation and simulation loop
- Dispatching user intents into existing action and simulation helpers
- Exposing derived snapshots and selectors for UI consumption

Responsibilities:

- Be the single owner of mutable frontend state
- Normalize the interface used by both browser and Tauri hosts
- Keep host concerns out of engine modules

### 3. Canvas Surface

Owns:

- Mounting the `<canvas>`
- Forwarding resize and pointer input to the runtime
- Triggering or participating in render scheduling

Constraints:

- Remains imperative for performance and simplicity
- Should not reimplement game logic

### 4. Svelte Shell

Owns:

- App layout
- Topbar and HUD readouts
- Control tower and tool selection
- Overlay toggles
- Scenario brief and selection details
- UI-only affordances such as visibility and panel composition

Constraints:

- Should read derived state from the runtime
- Should not duplicate simulation calculations
- Should not become a second source of truth for game state

### 5. Hosts

Own:

- App bootstrap
- Environment-specific configuration
- Desktop window lifecycle in Tauri

Constraints:

- Browser and Tauri hosts should start the same Svelte app
- Host bootstrap failures should be isolated from game logic

## Data Flow

The runtime is the single mutable owner of game and UI state.

Flow:

1. Svelte components emit user intents such as `setTool`, `toggleOverlay`, `togglePause`, `setSpeed`, `resetUi`, or canvas input events.
2. The runtime applies those intents through existing action helpers and state transitions.
3. The runtime advances simulation time on each frame.
4. The canvas renderer draws from runtime-owned state.
5. Svelte subscribes to runtime selectors and renders the current shell state.

Important rules:

- Svelte should consume selectors and derived summaries, not recalculate gameplay metrics itself.
- The engine should not know whether it is running in a browser tab or desktop window.
- Browser and Tauri should share the same gameplay flow and UI semantics.

## Error Handling

Preserve existing gameplay validation behavior and make host-level failures explicit.

- Invalid placements, broken routes, and other gameplay constraints should continue to be handled by engine and runtime logic.
- Bootstrap problems such as missing canvas mount points or failed host initialization should surface as visible shell-level errors.
- Tauri-specific failures must stay isolated from browser code paths.
- The migration should not introduce silent fallbacks that hide state or bootstrap errors.

Guiding rule:

- **Host errors stay in the host.**
- **Game errors stay in the runtime or engine.**

## Testing Strategy

Keep the current simulation-oriented testing emphasis and add coverage around migration seams.

### Engine tests

Continue testing simulation, routing, transport, placement, objectives, and deterministic scenario behavior directly from TypeScript.

### Runtime tests

Add tests for:

- Intent dispatch
- Tick progression
- UI-state transitions
- Selector output used by Svelte
- Coordination between canvas input and runtime actions

### UI tests

Add lightweight component tests for:

- Shell composition
- Topbar and control tower rendering
- Tool and overlay interactions against mocked runtime state

### End-to-end coverage

Keep browser e2e coverage as the baseline and add a narrow desktop smoke check for macOS once Tauri is present.

The first desktop smoke goal is limited:

- App boots
- Shared frontend loads
- Shell controls render
- Core interaction path still works

## Migration Principles

- Prefer incremental replacement over broad rewrites.
- Retire imperative DOM shell code only after equivalent Svelte surfaces exist.
- Keep browser support working throughout the migration.
- Keep Tauri thin until there is a concrete native feature to justify more host complexity.
- Preserve current simulation determinism and rendering behavior unless a change is explicitly required by the migration.

## Initial Implementation Shape

The first implementation plan should assume work in roughly this order:

1. Add Svelte and Tauri host scaffolding while keeping the existing browser entry working.
2. Extract a runtime/controller from `src/main.ts` so state ownership and actions no longer depend on direct DOM manipulation.
3. Introduce a Svelte app shell and migrate topbar/control-tower behavior out of `src/ui/panels.ts`.
4. Wrap the existing canvas in a Svelte component and connect it to the runtime.
5. Remove obsolete imperative shell wiring once parity is reached.
6. Add targeted runtime and shell tests plus macOS desktop smoke validation.

## Planning Notes

- The scope is intentionally narrow enough for a single implementation plan because it focuses on one migration track: **shared engine + Svelte shell + thin Tauri host**.
- Future native features such as saves, menus, and desktop integrations should be planned as follow-up specs after the host boundary is in place.

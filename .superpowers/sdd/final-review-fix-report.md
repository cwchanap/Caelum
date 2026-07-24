# HPA-309 Final Review Fix Wave

Date: 2026-07-23
Worktree: `/Users/chanwaichan/workspace/Caelum/.worktrees/hpa-309`
Fix commit: `d511296` (`fix: close HPA-309 final review findings`)

## Root Causes And Fixes

### Snapshot-load route staleness

`GameEngine::from_snapshot` normalized saved stop access and compiled the
non-serialized road topology, but exposed the snapshot's serialized route legs
unchanged. `transit::tick_vehicles` trusts `current_path`, so a stale access
tile or map could leave a vehicle ticking along removed road geometry.

The load path now keeps the normalized snapshot as the previous state, resolves
all saved bus and metro legs against the compiled candidate topology, and only
constructs the engine after that candidate succeeds. The existing route
lifecycle projection rebases vehicle cursors onto replacement paths, preserving
vehicle coordinates while retaining load atomicity.

The regression fixture stores a route on a y=2 road, removes those roads from
the serialized map, leaves a connected detour at y=4/y=5, and loads a moving
vehicle at a mid-path cursor. It asserts stop access moves to the surviving
road, the route uses the detour, and the vehicle cursor equals the projected
position on the new path.

### Tauri snapshot-load rejection shape

The Tauri command returned `Result<GameSnapshot, String>` and converted a
`GameplayRejection` to JSON text. Tauri then serialized that text as a JSON
string, unlike the WASM wrapper, which rejects with the structured object.

`game_load_snapshot` now uses `serde_json::Value` as its command error type.
Gameplay rejections are passed through with `serde_json::to_value`, while
poisoned-lock failures remain string-valued host errors. A mock-Tauri IPC
contract test invokes the real command handler and asserts
`unsupportedSnapshotSchema` plus both schema context fields as structured JSON.

### Bus-stop track hover validation

`canPlaceBusStop` checked that the anchor was empty and adjacent to a road but
did not check the track layer. Rust rejects tracked anchors, so the client
could show a valid hover that could not commit. The anchor now requires
`hasTrack !== true`, with a focused render validation regression test.

### Identical route-waypoint selection

`selectWaypoint` intentionally returns the same draft for both an invalid index
and an already-current selection. `selectRouteWaypoint` treated every identity
result as an error. The runtime now checks the index bounds only when the
identity result is unchanged: valid identical selections are silent no-ops and
out-of-range selections retain the existing typed
`invalidRouteDraftInteraction` rejection. The runtime regression test verifies
the no-op and the existing invalid-selection test remains green.

## Changed Files

- `crates/caelum-core/src/engine.rs`: re-resolve route legs during snapshot load.
- `crates/caelum-core/tests/stop_migration.rs`: stale-access route/path and vehicle projection regression.
- `src-tauri/Cargo.toml`: enable Tauri's test feature for the IPC contract test.
- `src-tauri/src/lib.rs`: preserve structured load rejections and add the Tauri IPC contract test.
- `src/render/placementValidation.ts`: reject bus-stop anchors on track tiles.
- `src/runtime/createGameRuntime.ts`: distinguish invalid selection from an identical selection no-op.
- `tests/render/placementValidation.test.ts`: tracked-anchor regression.
- `tests/runtime/gameRuntime.test.ts`: identical waypoint-selection regression.

## Red-Green Evidence

- `rtk cargo test -p caelum-core --test stop_migration from_snapshot_recomputes_stale_route_paths_after_access_normalization`: initially failed because the loaded route retained stale y=2 path state; passed after the load fix.
- `rtk cargo test -p caelum --lib snapshot_load_rejection_preserves_structured_code_and_context`: initially failed because the IPC error had no object `code`; passed after the Tauri boundary fix.
- `rtk bunx vitest run tests/render/placementValidation.test.ts -t "rejects a bus stop anchor on a track tile" --project ui`: initially received `true` instead of `false`; passed after the UI rule.
- `rtk bunx vitest run tests/runtime/gameRuntime.test.ts -t "silently ignores selecting the already-current waypoint interaction" --project runtime`: initially surfaced `invalidRouteDraftInteraction`; passed after the runtime distinction.

## Verification

- `rtk cargo test -p caelum-core --test stop_migration --test route_resilience --test engine_topology`: 32 passed.
- `rtk cargo test -p caelum --lib`: 1 passed.
- `rtk bunx vitest run --project runtime tests/runtime/gameRuntime.test.ts tests/runtime/tauriBackend.test.ts`: 141 passed.
- `rtk bunx vitest run --project ui tests/render/placementValidation.test.ts`: 7 passed.
- `rtk bun run check`: TypeScript and Svelte checks passed; 0 errors and 0 warnings.
- `rtk bun run lint`: ESLint and `cargo clippy --workspace --all-targets -- -D warnings` passed.
- `rtk bun run format:check`: Prettier and `cargo fmt --all --check` passed.
- `rtk bun run test:unit`: 35 test files and 584 tests passed.
- `rtk cargo test --workspace`: 383 tests passed across 34 suites.

## Concerns

- Snapshot load reuses the existing `recompute_all_routes` lifecycle, so metro derived legs are also deterministically refreshed on load. No metro routing implementation or assertion was changed.
- The Tauri `test` feature is enabled on the Tauri dependency solely to run the mock IPC contract test; production command behavior is otherwise unchanged.
- Playwright end-to-end tests were not run because the requested verification ladder specified unit, typecheck, lint, and format commands.
- Schema version remains `2`; no compatibility heuristics were added.

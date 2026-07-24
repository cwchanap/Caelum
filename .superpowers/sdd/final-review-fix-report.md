# HPA-309 Final Review Fix Wave

Date: 2026-07-23  
Worktree: `/Users/chanwaichan/workspace/Caelum/.worktrees/hpa-309`  
Fix commit: `c33a8d3` (`fix: close HPA-309 final review access findings`)

## Root Causes

### Broken-route parked bus access

Network mutations normalize stop access before `route_lifecycle::recompute_all_routes` runs. When a route was already broken, the lifecycle transition was `broken -> broken`; its only rebase path checked whether a missing waypoint had become live. A live stop changing from one valid road access tile to another therefore left a parked bus at the old coordinate, even after that road tile was demolished.

### Terminal hover validation

`canPlaceBuilding` validated every terminal footprint tile but did not validate any road relationship for the footprint. Rust requires a bus terminal to have a usable adjacent road, so an empty terminal footprint could show a green hover and then be rejected with `NoRoadAccess`.

### Malformed snapshot coordinates

Snapshot normalization called the unchecked cardinal `offset` helper while probing stop anchors and building footprint tiles. An extreme `i32` coordinate from a schema-v2 snapshot could overflow in debug builds before the map lookup rejected the candidate.

## Changes

- `crates/caelum-core/src/route_lifecycle.rs`
  - Added a bus-only parked-access rebase after route service transitions.
  - Compares authoritative previous and candidate access for route stop waypoints.
  - Rebases only parked buses whose coordinate exactly matches a changed previous live-stop access, then selects the deterministic nearest current live stop and resets the parked vehicle cursor.
  - Leaves arbitrary coordinates untouched, skips inactive/out-of-service routes, and never applies to metro vehicles or metro lines.
- `crates/caelum-core/src/stop_access.rs`
  - Replaced unchecked neighbor arithmetic with a local `checked_offset` helper in access derivation, access validation, and legacy anchor migration.
  - Overflowing candidates are ignored as non-neighbors; schema version remains v2 and migration ordering remains deterministic.
- `src/render/placementValidation.ts`
  - Added deterministic four-direction neighboring-road validation across the entire terminal footprint.
  - The client checks only optimistic road kind/structure ownership and does not attempt reciprocal topology; Rust remains authoritative.
- `crates/caelum-core/tests/route_resilience.rs`
  - Added an existing-broken-route regression covering access loss from the old road tile to a surviving alternate access.
- `crates/caelum-core/tests/stop_migration.rs`
  - Added a malformed extreme stop/footprint coordinate load regression.
- `tests/render/placementValidation.test.ts`
  - Added terminal no-road rejection and non-origin footprint adjacency coverage.
- `tests/render/canvas.test.ts`
  - Updated the green terminal preview fixture to include the now-required adjacent road.

## Red-Green Evidence

- `rtk cargo test -p caelum-core --test route_resilience already_broken_route_rebases_parked_bus_when_live_stop_access_is_demolished`: failed first with the bus still at `Point { x: 2, y: 5 }` instead of the new access at `Point { x: 2, y: 3 }`.
- `rtk cargo test -p caelum-core --test stop_migration from_snapshot_handles_extreme_stop_and_footprint_coordinates_without_overflow`: failed first with an overflow panic in `heading::offset` called by `stop_access::derive_stop_access_for_footprint`.
- `bunx vitest run tests/render/placementValidation.test.ts -t "bus terminal placement" --project ui`: failed first because a no-road terminal returned `true` instead of `false`.
- After implementation, the focused regressions passed: route 1/1, malformed snapshot 1/1, terminal placement 2/2.

## Verification

- `rtk cargo test -p caelum-core --test route_resilience --test stop_migration`: 28 passed.
- `bunx vitest run --project ui tests/render/placementValidation.test.ts`: 9 passed.
- `bunx vitest run --project runtime tests/runtime/gameRuntime.test.ts tests/runtime/tauriBackend.test.ts`: 141 passed.
- `rtk cargo test --workspace`: 385 passed across 34 suites.
- `bun run test:unit`: 35 test files and 586 tests passed.
- `bun run check`: passed; TypeScript and Svelte checks reported 0 errors and 0 warnings.
- `bun run lint`: passed; ESLint and `cargo clippy --workspace --all-targets -- -D warnings` passed.
- `bun run format:check`: passed; Prettier and `cargo fmt --all --check` passed.
- `rtk git diff --check`: passed before commit.

The first full `bun run test:unit` attempt exposed an existing canvas test fixture that expected a green terminal on an empty map. The fixture was corrected to place a road adjacent to the terminal footprint, and the complete suite then passed without weakening the new validation rule.

## Concerns

- Terminal hover validation is intentionally optimistic and does not mirror Rust reciprocal lane topology; a green hover can still be rejected by Rust for a topologically unusable road.
- If a live stop loses access and no other live route stop has usable access, the existing no-target parking policy preserves the vehicle's current coordinate rather than inventing a location. Arbitrary and inactive-route parking remains preserved by design.
- Metro routing and metro vehicle lifecycle behavior were not changed; the new lifecycle helper is explicitly bus-only.
- Playwright end-to-end tests were not run because the requested verification ladder specified covering Rust/UI/runtime tests, check, lint, and format.
- Snapshot schema remains `2`; no compatibility heuristics or schema migration changes were introduced.

# Task 13 report: Direction-specific Shuttle ride visits

## Status

Implemented and verified. Passenger route plans now identify the exact service direction and itinerary visits used for boarding and alighting. Shuttle interior stops remain distinct outbound/return visits, route estimates follow the explicit cyclic itinerary (including terminal reversals when an edge crosses one), and vehicle lifecycle matching uses completed itinerary indexes rather than only line and stop position.

## Implementation

- Extended Rust and TypeScript `RouteLeg` contracts with required nullable `serviceDirection`, `boardItineraryIndex`, and `alightItineraryIndex` fields.
- Kept walk-leg values explicitly `null` and added a required-option Serde deserializer so schema-v2 rejects missing visit fields instead of silently treating them as `None`.
- Added `ServiceVisit`, `RideEdge`, `service_visits`, and `enumerate_ride_edges` to enumerate the explicit cyclic service itinerary without collapsing equal waypoint IDs from different directions.
- Changed direct and transfer routing to build candidates from ride edges rather than physical-anchor indexes. Transit plans now carry the board visit direction/index and the service-leg completion index used to alight.
- Changed ride estimates to sum every explicit itinerary leg between the board departure and alight completion, including terminal-reversal legs.
- Changed boarding to require mode, line, platform position, and the exact `vehicle.itinerary_index` requested by the plan.
- Changed alighting to require the exact completed itinerary index requested by the plan.
- Changed vehicle advancement to report every completed itinerary leg in a tick. This preserves correct alighting when a zero-second Metro terminal reversal and its following service leg complete in the same tick.
- Preserved operational-route filtering, present-node/tombstone filtering, directional path resolution, existing duration estimates, terminal-reversal paths, and schema version 2.

## Files

Production contracts and behavior:

- `crates/caelum-core/src/model.rs`
- `crates/caelum-core/src/service_itinerary.rs`
- `crates/caelum-core/src/router.rs`
- `crates/caelum-core/src/transit.rs`
- `src/domain/types.ts`

New and updated Rust coverage/fixture literals:

- `crates/caelum-core/tests/shuttle_service.rs`
- `crates/caelum-core/tests/router_planning.rs`
- `crates/caelum-core/tests/trip_lifecycle.rs`
- `crates/caelum-core/tests/model_wire_format.rs`
- `crates/caelum-core/tests/platforms.rs`
- `crates/caelum-core/tests/transit_router.rs`
- `crates/caelum-core/tests/transit_build.rs`
- `crates/caelum-core/tests/route_resilience.rs`

Updated TypeScript route-plan fixtures:

- `tests/render/overlayRenderer.test.ts`
- `tests/runtime/platformOccupancy.test.ts`
- `tests/runtime/runtimeSelectors.test.ts`

`crates/caelum-core/src/trips.rs`, `tests/helpers/gameState.ts`, `tests/fixtures/rustSnapshot.ts`, and `tests/runtime/gameRuntime.test.ts` required no source edits: they do not construct `RouteLeg` values in the affected paths. Their relevant suites were still run.

## TDD evidence

Initial RED:

- Command: `rtk cargo test -p caelum-core --test shuttle_service`
- Result: failed with 7 expected compile errors: missing `ServiceVisit`/`service_visits` and missing `service_direction`, `board_itinerary_index`, and `alight_itinerary_index` on `RouteLeg`.

Primary GREEN:

- Command: `rtk cargo test -p caelum-core --test shuttle_service`
- Result after implementation: 6 passed.

Self-review RED:

- Command: `rtk cargo test -p caelum-core --test shuttle_service alighting_after_zero_second_reversal_uses_the_completed_service_index`
- Result: failed at the passenger-empty assertion, proving that the old single-cursor completion check missed the service leg completed after a zero-second Metro reversal.

Self-review GREEN:

- Same focused command: 1 passed, 6 filtered out.
- Full Shuttle suite after the correction: 7 passed.

Strict-wire RED/GREEN:

- The new required-field wire test initially failed because standard Serde `Option` deserialization accepts an absent field as `None`.
- Added `deserialize_required_option`; `model_wire_format` then passed all 26 tests and now proves explicit `null` is accepted while a missing field is rejected.

## Final verification

Fresh final verification on the completed diff:

- `rtk cargo fmt --all --check` — passed.
- `rtk cargo clippy --workspace --all-targets -- -D warnings` — no issues found.
- `rtk cargo test -p caelum-core` — 258 passed across 22 suites.
- `rtk cargo test -p caelum-core --test shuttle_service` — 7 passed.
- `rtk cargo test -p caelum-core --test router_planning` — 7 passed.
- `rtk cargo test -p caelum-core --test trip_lifecycle` — 38 passed.
- `rtk cargo test -p caelum-core --test model_wire_format` — 26 passed.
- `rtk bunx vitest run --project runtime tests/runtime/gameRuntime.test.ts tests/runtime/platformOccupancy.test.ts tests/runtime/runtimeSelectors.test.ts` — 121 passed across 3 files.
- `rtk bunx vitest run --project ui tests/render/overlayRenderer.test.ts` — 29 passed.
- `rtk bun run check` — TypeScript and Svelte checks passed with 0 errors and 0 warnings; WASM rebuilt successfully.
- `rtk bun run test` — 363 passed across 29 files.
- `rtk git diff --check` — passed.
- Additional gates run during finalization: `rtk bun run format:check` passed; `rtk bun run lint` passed (ESLint clean and Rust Clippy clean).

## Self-review

- Verified that each interior Shuttle waypoint produces separate outbound and return visits with distinct departing indexes.
- Verified that a return-direction passenger does not board the outbound vehicle visit at the same physical stop.
- Verified that a rider does not alight when the same physical stop is reached by the wrong service-leg completion.
- Verified paired one-way outbound/return paths remain independently resolved and obey lane direction.
- Verified Loop closure, Bus U-turn reversal, disconnected one-way terminal reversal, and zero-second Metro reversal semantics.
- Verified walk legs serialize the three new fields as explicit `null`, transit legs serialize populated values, and missing fields fail schema-v2 deserialization.
- Verified broken/inactive route guards and missing-node filtering remain in the router/vehicle data paths.
- Reviewed the exhaustive transfer-edge enumeration. It is more complete than the former nearest-anchor shortcut and is deterministic; its cost grows with the product of ride-edge counts for a pair of services, which is acceptable for the currently bounded authored route sizes.

## Concerns

- No known functional blockers.
- Local `wasm-pack` emitted its existing non-blocking warnings about falling back from a prebuilt `wasm-bindgen` binary and about a newer `wasm-pack` version; the WASM build completed successfully.

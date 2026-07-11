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

## Review fix: terminal Shuttle boarding after reversal

### Finding and root cause

Review found that a terminal-origin Shuttle rider could miss departure. A Metro vehicle begins at the terminal's zero-duration `TerminalReversal`, while the plan correctly names the following service leg as `boardItineraryIndex`. `tick_vehicles_without_context` attempted boarding only once at the pre-advance reversal cursor. `advance_vehicle_by_seconds` then completed the reversal and consumed positive travel on the following service leg without exposing a boarding event at the newly entered visit.

### TDD evidence

RED regressions were added for both terminal directions:

- `outbound_terminal_waiter_boards_after_zero_second_reversal`
- `return_terminal_waiter_boards_after_zero_second_reversal`

Command:

```sh
rtk proxy cargo test -p caelum-core --test shuttle_service terminal_waiter_boards_after_zero_second_reversal -- --nocapture
```

RED result: 0 passed, 2 failed, 7 filtered out. Both failures reached the planned following service index with half-step progress, but the vehicle passenger list was `[]` instead of `["trip-001"]`.

After the event-order fix:

```sh
rtk cargo test -p caelum-core --test shuttle_service terminal_waiter_boards_after_zero_second_reversal -- --nocapture
rtk cargo test -p caelum-core --test shuttle_service
```

GREEN result: focused regressions 2 passed/7 filtered; full Shuttle suite 9 passed.

### Implementation and files

- `crates/caelum-core/src/transit.rs`
  - Initial boarding now occurs only at an actual service-leg departure.
  - Vehicle advancement emits each itinerary-leg completion synchronously.
  - Each completion is processed in physical event order: exact-index alighting at the completed leg, exact-index boarding at the newly entered service departure, then consumption of remaining positive travel.
  - Service legs entered after zero-duration Metro reversal legs therefore board before their first positive path step.
  - Direct Loop transitions and multi-leg remainder ticks use the same ordered completion path without duplicate initial boarding.
- `crates/caelum-core/tests/shuttle_service.rs`
  - Added outbound- and return-terminal waiting regressions.
  - Added a shared Metro Shuttle fixture and reused it in the zero-reversal alighting regression.
- `.superpowers/sdd/task-13-report.md`
  - Appended this review-fix evidence.

### Verification

Fresh post-fix verification:

- `rtk cargo fmt --all --check` — passed.
- `rtk cargo clippy --workspace --all-targets -- -D warnings` — no issues found.
- `rtk cargo test --workspace` — 260 passed across 27 suites.
- `rtk cargo test -p caelum-core --test shuttle_service` — 9 passed.
- `rtk cargo test -p caelum-core --test router_planning` — 7 passed.
- `rtk cargo test -p caelum-core --test trip_lifecycle` — 38 passed.
- `rtk cargo test -p caelum-core --test model_wire_format` — 26 passed.
- `rtk bun run format:check` — passed.
- `rtk bun run lint` — ESLint passed and strict workspace Clippy passed.
- `rtk bun run check` — TypeScript and Svelte checks passed with 0 errors and 0 warnings.
- `rtk bun run test` — 363 passed across 29 files.
- `rtk git diff --check` — passed before the report append; the staged diff is checked again before commit.

`rtk bun run build` reached release WASM optimization but failed because sandboxed `wasm-opt` returned `Operation not permitted`. The required outside-sandbox rerun was requested and rejected by the execution environment because its escalation usage limit had been reached. No workaround was attempted. Rust workspace compilation/tests, dev WASM-backed checks, frontend tests, lint, and type checks all completed successfully.

### Self-review

- Confirmed terminal riders remain waiting while the cursor is still on reversal index 5 (outbound) or 2 (return).
- Confirmed each rider boards only after the cursor enters planned service index 0 (outbound) or 3 (return), and is aboard before the first positive step finishes.
- Confirmed initial service-leg zero-delta boarding remains covered by the existing direction-specific boarding regression.
- Confirmed alighting still uses every exact completed itinerary index, including a service completion after a zero-second reversal.
- Confirmed completion processing alights before boarding, so intermediate-stop seat capacity is released before new riders board during a multi-leg remainder tick.
- Confirmed boarding still requires exact mode, line, platform position, and itinerary index; operational-route and present-node guards are unchanged.
- Confirmed callbacks occur only when the itinerary index changes, while initial boarding is handled once before advancement, avoiding duplicate departure events.

### Review-fix concerns

- No known functional concerns.
- Production `bun run build` remains unverified in this environment solely because `wasm-opt` was sandbox-blocked and escalation was unavailable due the execution usage limit. The failure occurred after release Rust/WASM compilation, at the optimizer process boundary.

## Review fix: retain exact-full-cycle completion changes

### Finding and root cause

Review found that completion callbacks could mutate passengers and active trips during a large tick, yet `tick_vehicles_without_context` committed those local mutations only when boarding set `changed` or the final vehicle cursor differed from its initial tuple. A delta equal to one complete itinerary cycle returns the cursor to the same itinerary index, path-step index, and progress. When a rider alighted during that cycle and nobody boarded, both existing change signals stayed false, so the function returned the original snapshot and discarded the alighting event.

### TDD evidence

Added `full_cycle_alighting_is_committed_when_vehicle_cursor_wraps_to_start`, which starts a rider aboard at Metro Shuttle reversal index 2, advances by the sum of every itinerary-leg duration, and proves the final cursor exactly equals the initial cursor while the rider must be alighted at the planned service completion.

RED command:

```sh
rtk proxy cargo test -p caelum-core --test shuttle_service full_cycle_alighting_is_committed_when_vehicle_cursor_wraps_to_start -- --nocapture
```

RED result: 0 passed, 1 failed, 9 filtered out. The failure was the expected passenger-list assertion: the returned snapshot still contained the rider because the callback mutation was discarded.

GREEN commands:

```sh
rtk cargo test -p caelum-core --test shuttle_service full_cycle_alighting_is_committed_when_vehicle_cursor_wraps_to_start -- --nocapture
rtk cargo test -p caelum-core --test shuttle_service
```

GREEN result: focused regression 1 passed/9 filtered; the then-current full Shuttle suite passed 10 tests. A preservation regression, `full_cycle_without_passenger_events_remains_a_no_op`, was then added and passed; the final Shuttle suite contains 11 passing tests.

### Implementation and files

- `crates/caelum-core/src/transit.rs`
  - `disembark_vehicle` now explicitly returns both the updated vehicle and whether any passenger/trip state changed.
  - The itinerary-completion callback returns an event-change boolean that combines exact-index alighting and exact-index boarding mutations.
  - `advance_vehicle_by_seconds` aggregates completion-event changes across every completed leg and returns that signal to the tick.
  - `tick_vehicles_without_context` folds the completion-event signal into `changed` independently of final cursor equality.
  - Cursor inequality remains a separate movement-state signal; a completion with no alighting or boarding returns false and does not force a commit.
- `crates/caelum-core/tests/shuttle_service.rs`
  - Added the exact-full-cycle alighting regression.
  - Added the exact-full-cycle no-event/no-op preservation regression.
- `.superpowers/sdd/task-13-report.md`
  - Appended this review-fix evidence.

### Verification

Fresh post-fix verification:

- `rtk cargo fmt --all --check` — passed.
- `rtk cargo clippy --workspace --all-targets -- -D warnings` — no issues found.
- `rtk cargo test --workspace` — 262 passed across 27 suites.
- `rtk cargo test -p caelum-core --test shuttle_service` — 11 passed.
- `rtk cargo test -p caelum-core --test router_planning` — 7 passed.
- `rtk cargo test -p caelum-core --test trip_lifecycle` — 38 passed.
- `rtk cargo test -p caelum-core --test model_wire_format` — 26 passed.
- `rtk bun run format:check` — passed.
- `rtk bun run lint` — ESLint passed and strict workspace Clippy passed.
- `rtk bun run check` — TypeScript and Svelte checks passed with 0 errors and 0 warnings.
- `rtk bun run test` — 363 passed across 29 files.
- `rtk git diff --check` — passed before the report append and is checked again before commit.

The previously documented final-gate environment note remains unchanged: production `bun run build` cannot complete in this sandbox because `wasm-opt` is denied and escalation is unavailable. No new build attempt or workaround was made for this review-only fix.

### Self-review

- Confirmed the exact-full-cycle rider alights at service index 3, advances to walking/current leg 1 at the correct position, and remains committed even though the final cursor tuple equals the initial tuple.
- Confirmed a passenger-free, waiter-free exact full cycle returns a snapshot equal to the input, so no-op completions are not falsely marked changed.
- Confirmed completion-event signals are OR-aggregated across the whole large tick; a later no-op completion cannot erase an earlier alighting or boarding change.
- Confirmed alighting still occurs before boarding at each completion, and terminal boarding after zero-duration reversals remains in the same callback order.
- Confirmed exact mode/line/platform/visit-index matching, multi-leg remainder processing, operational guards, and present-node/tombstone filtering are unchanged.
- Confirmed final cursor inequality still commits partial movement independently of event mutations.

### Exact-full-cycle review-fix concerns

- No known functional concerns.
- The existing production-build environment restriction described above remains the only final-gate limitation.

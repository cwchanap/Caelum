# HPA-622 Task 1 Report

## Implementation summary

- Bumped the disposable snapshot contract from schema v5 to v6 in Rust and TypeScript.
- Added the nullable `PrivateCarTrip` wire payload and the `Driving` trip status, with explicit `None`/`null` values in existing Rust and TypeScript fixtures.
- Added persistence validation for Driving payload presence, route-plan/current-leg invariants, road-path shape and bounds, finite non-negative arrival time, non-driving payload rejection, and transit-vehicle membership rejection.
- Cleared captured car payloads at arrival, unserved, and destination-retarget reset exits.
- Moved browser and native save namespaces to v6 and updated active documentation/fixtures.
- No traffic calculation, routing, bus timing, or overlay behavior was added.

## Files changed

Rust core model, persistence, lifecycle, and tests:

- `crates/caelum-core/src/engine.rs`
- `crates/caelum-core/src/model.rs`
- `crates/caelum-core/src/persistence/error.rs`
- `crates/caelum-core/src/persistence/trips.rs`
- `crates/caelum-core/src/stop_access.rs`
- `crates/caelum-core/src/transit.rs`
- `crates/caelum-core/src/trips.rs`
- `crates/caelum-core/tests/areas_buildings.rs`
- `crates/caelum-core/tests/fixtures/sandbox_templates.json`
- `crates/caelum-core/tests/model_wire_format.rs`
- `crates/caelum-core/tests/persistence_construction.rs`
- `crates/caelum-core/tests/platforms.rs`
- `crates/caelum-core/tests/route_editing.rs`
- `crates/caelum-core/tests/route_resilience.rs`
- `crates/caelum-core/tests/router_estimate_branches.rs`
- `crates/caelum-core/tests/shuttle_service.rs`
- `crates/caelum-core/tests/stop_migration.rs`
- `crates/caelum-core/tests/transit_build.rs`
- `crates/caelum-core/tests/transit_router.rs`
- `crates/caelum-core/tests/trip_lifecycle.rs`

Host, persistence, documentation, and TypeScript fixtures:

- `docs/architecture.md`
- `src-tauri/src/city_store.rs`
- `src/domain/types.ts`
- `src/persistence/indexedDbCitySaveStore.ts`
- `src/runtime/backend/types.ts`
- `src/runtime/snapshotView.ts`
- `tests/e2e/newCity.spec.ts`
- `tests/render/citizenRenderer.test.ts`
- `tests/render/overlayRenderer.test.ts`
- `tests/runtime/persistence/indexedDbCitySaveStore.test.ts`
- `tests/runtime/platformOccupancy.test.ts`
- `tests/runtime/runtimeSelectors.test.ts`
- `tests/runtime/snapshotView.test.ts`
- this report

## Verification

All commands were run from `/Users/chanwaichan/workspace/Caelum/.worktrees/hpa-622`.

| Command | Outcome |
| --- | --- |
| `rtk cargo test -p caelum-core --test model_wire_format` | PASS; 46 tests |
| `rtk cargo test -p caelum-core persistence` | PASS; 4 matched tests |
| `rtk cargo test -p caelum-core --test transit_build --test trip_lifecycle` | PASS; 105 tests |
| `rtk bun run test:unit` | PASS; 53 files, 695 tests |
| `rtk bun run check` | PASS; TypeScript and svelte-check, 0 errors/warnings |
| `rtk cargo clippy -p caelum-core --all-targets -- -D warnings` | PASS; no issues |
| `rtk cargo fmt --all --check` | PASS |
| `rtk cargo test -p caelum-core` | PASS; 551 tests |
| `rtk cargo test --manifest-path src-tauri/Cargo.toml` | PASS; 25 tests |
| `rtk git diff --check` | PASS |

## Required RED/GREEN evidence

- Wire RED: before the model change, `rtk cargo test -p caelum-core --test model_wire_format` failed at compile time because `PrivateCarTrip`, `TripStatus::Driving`, and `ActiveTrip.private_car_trip` did not exist. After the implementation, the same command passed all 46 tests.
- Persistence RED: before the validator change, the new focused `persistence_construction` cases reported 17 passing and 6 failing: valid Driving snapshots were rejected as ordinary planless trips, the non-Driving payload was accepted, and the new payload/path/arrival diagnostics were absent. After the validator change, the suite passed all 18 tests.
- Lifecycle RED: before payload-clear changes, `rtk cargo test -p caelum-core --lib private_car_payload` failed both new tests (`score_arrival` and `mark_unserved` retained the payload). After the changes, both tests passed.

## Self-review

- The wire break is direct: no `serde(default)`, migration reader, legacy namespace fallback, or compatibility alias was introduced.
- Validation is performed before legacy route-plan validation, so each new invariant has a stable field diagnostic while captured road steps remain saveable even when their current map tiles are no longer roads.
- Existing ActiveTrip construction sites are explicit about the new nullable field; the WASM-facing TypeScript raw type allows host omission and normalizes it to `null` at the existing snapshot view boundary.
- Payload clearing is limited to the three required lifecycle/reset exits. No new manager, cache, queue, or traffic subsystem was introduced.
- The full diff contains no traffic assignment, router, bus-clock, or overlay behavior.

## Concerns

- The requested old-schema grep still reports v5 strings in immutable historical planning documents under `docs/superpowers/plans/`; no active code, current fixture, or `docs/architecture.md` v5 contract remains.
- Browser Playwright was not run because Task 1 specifies unit/check verification; browser persistence coverage remains represented by the existing unit suite and updated e2e fixture namespace.

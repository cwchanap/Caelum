# HPA-622 Task 1 report

## Status

Complete. Task 1 now has one explicit borrowed `RoadFlow` shared by private-car choice, router ETA, bus timing, vehicle-stop boundaries, and trip scheduling. `trips::tick_trips_substepped` is the only production owner that derives the map; same-time admitted cars update that local map before later planning and timing work.

## Commit SHA(s)

- `f075c84` — `refactor(core): share HPA-622 road flow timing`

## Changed files

- `crates/caelum-core/src/commute.rs`
- `crates/caelum-core/src/traffic.rs`
- `crates/caelum-core/src/router.rs`
- `crates/caelum-core/src/transit.rs`
- `crates/caelum-core/src/trips.rs`
- `crates/caelum-core/tests/traffic.rs`
- `crates/caelum-core/tests/router_planning.rs`
- `crates/caelum-core/tests/router_estimate_branches.rs`
- `crates/caelum-core/tests/transit_router.rs`
- `crates/caelum-core/tests/transit_build.rs`
- `crates/caelum-core/tests/shuttle_service.rs`
- `crates/caelum-core/tests/golden_sequences.rs`
- `crates/caelum-core/tests/trip_lifecycle.rs`

## Red/green evidence

- RED: `cargo test -p caelum-core --test traffic` failed to compile because the new `RoadFlow`, derivation/mutation helpers, shared constants, and explicit-flow function arities were absent.
- GREEN: the same focused traffic target passed with 15 tests after the primitives were implemented.
- GREEN: the final Task 1-focused target passed with 169 tests across all eight requested integration targets.

## Test commands and results

- `cargo test -p caelum-core --test traffic` — expected RED compile failure, then GREEN (15 passed).
- `cargo test -p caelum-core --test traffic --test router_planning --test router_estimate_branches --test transit_router --test transit_build --test shuttle_service --test golden_sequences --test trip_lifecycle` — 169 passed, 0 failed.
- `cargo test -p caelum-core` — full core unit/integration/doc-test suite passed.
- `cargo clippy -p caelum-core --all-targets -- -D warnings` — passed.
- `cargo fmt --all --check` — passed.
- `git diff --check` — passed before commit.

## Self-review

- `RoadFlow` remains ephemeral and borrowed; it is not serialized, stored on the engine, or exposed through host/UI layers.
- Flow derivation counts only driving private-car trips and deduplicates each car’s road positions before saturating increments.
- Car ETA includes both endpoint walks, `CAR_ACCESS_SECONDS`, and candidate-inclusive road timing. Bus road ETA and movement consume the same passed map; metro and frozen car timers retain their existing timing behavior.
- Fractional vehicle progress math and route-path storage were left unchanged.
- No old snapshot-rescanning road timing helper remains in production.

## Deviations / concerns

- The prior synthetic bus-vs-car detour test and its fixture were removed because the new fixed generalized car cost makes that stale captured-bus shortcut an invalid mode-choice contract; this is the obsolete test called out for replacement by the next HPA-622 acceptance slice.
- The car lifecycle fixture was lengthened so its existing car-flow boundary assertions remain a topology-valid long-commute case under the new fixed access cost. No production behavior was added for that test adjustment.

# HPA-622 Task 4 Report

## Implementation summary

- Made bus route-plan ETA derive live road time from `traffic::effective_road_path_seconds` while preserving captured path structure and metro/free-flow timing.
- Added one `vehicle_step_seconds` helper over `TransitPathStepRef` and reused it for bus movement and next-stop boundary estimation.
- Kept normalized `step_progress` unchanged across flow changes; the effective duration applies only to remaining time. Added an epsilon-safe exact-step completion guard.
- Preserved vehicle-before-trip ordering: arriving cars contribute to the bus substep, then trip resolution clears the car payload and subsequent boundaries use reduced flow.
- Added static bus/metro timing, fractional departure, arrival ordering, coarse/fine equivalence, route ETA/path-preservation, and strict mode-choice regressions.

## Files changed

- `crates/caelum-core/src/router.rs`
- `crates/caelum-core/src/transit.rs`
- `crates/caelum-core/src/trips.rs`
- `crates/caelum-core/tests/router_planning.rs`
- `crates/caelum-core/tests/transit_router.rs`
- `crates/caelum-core/tests/trip_lifecycle.rs`
- `.superpowers/sdd/2026-08-14-phase3-aggregate-private-car-congestion/task-4-report.md`

## Verification

All commands ran from `/Users/chanwaichan/workspace/Caelum/.worktrees/hpa-622`.

| Command | Outcome |
| --- | --- |
| `rtk proxy cargo test -p caelum-core --test traffic --test router_planning --test transit_router --test trip_lifecycle --test shuttle_service` | PASS; 90 tests |
| `rtk proxy cargo test -p caelum-core trips::tests::strict_car_choice_switches_when_live_non_car_eta_becomes_slower -- --exact --nocapture` | PASS; 1 matched unit test |
| `rtk proxy cargo test --workspace` | PASS; all workspace tests and doctests |
| `rtk proxy cargo clippy --workspace --all-targets -- -D warnings` | PASS; no warnings |
| `rtk cargo fmt --all --check` | PASS |
| `rtk git diff --check` | PASS |

## Required RED/GREEN evidence

- Static timing RED: `bus_vehicle_uses_congested_road_time_for_boundary_and_motion` reported `seconds=1.25` instead of `1.875`; GREEN passed with live road timing. The equivalent metro regression stayed unchanged and passed.
- Router ETA RED: `bus_route_plan_eta_reflects_current_car_flow_without_rebuilding_path` reported `142.5` instead of `148.75`; GREEN passed and confirmed the stored path duration was unchanged.
- Fractional-progress RED: `fractional_bus_progress_rescales_only_remaining_time_at_car_departure` crossed the bus step under free-flow and reported progress `0.019999...` instead of the congested partial cursor; GREEN matched coarse and split ticks with progress in the same normalized step.
- Arrival-order RED: `arriving_car_contributes_to_bus_step_before_payload_is_cleared` completed the bus step (`path_step_index=1`) instead of retaining `0.8` progress; GREEN confirmed flow 5 during movement, car removal/payload clearing afterward, reduced-flow boundary timing, and coarse/split equality.

## Self-review

- The only production timing source added is `vehicle_step_seconds`; no stored congestion clock, remaining-seconds field, path rebuild, cache, or second path-step enum was introduced.
- Router uses live state only for Bus + Road paths; Metro and non-road/fallback timing remain stored/free-flow. Empty synthetic road paths retain their stored total duration for terminal/reversal plan compatibility.
- `tick_vehicles` receives the immutable substep snapshot, so all vehicles in that substep see the same derived flow; trip resolution remains after vehicle movement as required.
- Private-car captured paths and arrival timestamps are untouched. Active flow remains derived from current Driving trips only.

## Concerns

- No known implementation concerns. Task 5 UI/overlay work was intentionally not started.

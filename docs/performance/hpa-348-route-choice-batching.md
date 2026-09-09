# HPA-348 Route-Choice Batching — Pre-Batching Baseline

Baseline recorded before the HPA-348 route-choice batching refactor, on the
same reference machine as the HPA-347 ECS population and HPA-544 presentation
baselines.

## Commands

```bash
uname -a
rustc --version
cargo test --release -p caelum-core --test route_choice_scale -- --ignored --nocapture
```

The workload is the shared `mixed_peak_snapshot(count, bus_route_count)`
fixture (`crates/caelum-core/tests/common/route_choice_fixture.rs`): a Standard
blank grid with a two-way road corridor, a metro track corridor, four Small
Houses, one Supermarket, one Factory, `bus_route_count` four-stop bus loops
plus one four-station metro loop, and exactly `count` same-time canonical
Workers on real building tiles. The harness resumes the engine, drains exactly
`count` demands at t=301, times `spawn_drained_demands_for_scale_harness`
(route choice + private-car candidacy + road-flow feedback per row), derives
the mode/OD counts from the post-spawn snapshot, then times one
`engine.tick(1.0)` after spawn.

## Reference environment

### OS

Darwin Chans-MacBook-Pro-3.local 25.6.0 Darwin Kernel Version 25.6.0: Fri Jul 31 19:18:49 PDT 2026; root:xnu-12377.161.14~5/RELEASE_ARM64_T6000 arm64

### CPU

Apple M1 Pro, 32 GB RAM

### Rust

rustc 1.96.0 (ac68faa20 2026-05-25)

### Build

`--release` for the `route_choice_scale` integration test.

## Baseline table

| Row                  |   Due | Services | Distinct tile OD | Route spawn µs | Post-spawn tick µs | Walk |  Car | Bus | Metro | Planless |
| -------------------- | ----: | -------: | ---------------: | -------------: | -----------------: | ---: | ---: | --: | ----: | -------: |
| mixed-wave-1000      |  1000 |        2 |               40 |         133653 |               3045 |  425 |  426 | 125 |    24 |        0 |
| mixed-wave-5000      |  5000 |        2 |               40 |         677708 |              33213 | 2125 | 2126 | 625 |   124 |        0 |
| mixed-wave-20000     | 20000 |        2 |               40 |        2728805 |             343065 | 8500 | 8501 | 2500 |   499 |        0 |
| transit-stress-20000 | 20000 |        8 |               40 |       74640685 |             336532 | 8500 | 8501 | 250 |   499 |        0 |

`Due` is the drained demand count, asserted equal to `count`. Mode counts are
per active trip: car = `private_car_trip` present; bus/metro = the route plan
contains that mode; walk = plan without transit legs; planless = no plan and no
car. Bus+metro transfer plans are counted under bus.

## Notes

- HPA-347's old wave row (small-town template, `wave-*` rows in
  `hpa-347-ecs-population.md`) was walking-heavy and is not the HPA-348
  baseline. The HPA-348 fixture produces a genuine mixed outcome — walk / car
  / bus / metro all present, zero planless — so batching must preserve a real
  four-way route-choice distribution.
- `transit-stress-20000` exists to exercise the `O(S² × E1 × E2)`
  service/ride-edge shape term: raising services from 2 to 8 at the same
  20000-demand wave multiplies route spawning by ~27× (2.73 s → 74.64 s) while
  the post-spawn tick is unchanged (~0.34 s). That spawn term is what HPA-348
  batching owns.
- Wall-clock values are reference evidence only, never CI thresholds.

# HPA-348 Route-Choice Batching — Baseline and Final Evidence

Recorded on the same reference machine as the HPA-347 ECS population and
HPA-544 presentation baselines: a pre-batching baseline, then the final
post-batching measurements with the batch planner's structural stats.

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
(route choice + private-car candidacy + road-flow feedback per row) and keeps
its final `RouteChoiceBatchStats`, derives the mode/OD counts from the
post-spawn snapshot, then times one `engine.tick(1.0)` after spawn. The test
also asserts the structural invariants listed with the final table (service
counts, demand-independent shape cardinality, access-pair-bounded car
preparation) and asserts no timing threshold.

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

| Row                  |   Due | Services | Distinct tile OD | Route spawn µs | Post-spawn tick µs | Walk |  Car |  Bus | Metro | Planless |
| -------------------- | ----: | -------: | ---------------: | -------------: | -----------------: | ---: | ---: | ---: | ----: | -------: |
| mixed-wave-1000      |  1000 |        2 |               40 |         133653 |               3045 |  425 |  426 |  125 |    24 |        0 |
| mixed-wave-5000      |  5000 |        2 |               40 |         677708 |              33213 | 2125 | 2126 |  625 |   124 |        0 |
| mixed-wave-20000     | 20000 |        2 |               40 |        2728805 |             343065 | 8500 | 8501 | 2500 |   499 |        0 |
| transit-stress-20000 | 20000 |        8 |               40 |       74640685 |             336532 | 8500 | 8501 | 2500 |   499 |        0 |

`Due` is the drained demand count, asserted equal to `count`. Mode counts are
per active trip: car = `private_car_trip` present; bus/metro = the route plan
contains that mode; walk = plan without transit legs; planless = no plan and no
car. Bus+metro transfer plans are counted under bus.

## Final results (post-batching)

Same machine and toolchain as above (`uname -a` / `rustc --version` in
Reference environment; both re-verified identical for the final run), with the
`DemandBatchPlanner` batch route choice from HPA-348 Tasks 1–3 in place.

| Row                  |   Due | Services | Distinct tile OD | Route spawn µs | Post-spawn tick µs | Transit shapes | Flow refreshes | Car access paths | Walk |  Car |  Bus | Metro | Planless |
| -------------------- | ----: | -------: | ---------------: | -------------: | -----------------: | -------------: | -------------: | ---------------: | ---: | ---: | ---: | ----: | -------: |
| mixed-wave-1000      |  1000 |        2 |               40 |          2,871 |              3,315 |            312 |            426 |                8 |  425 |  426 |  125 |    24 |        0 |
| mixed-wave-5000      |  5000 |        2 |               40 |         12,495 |             35,147 |            312 |          2,126 |                8 | 2125 | 2126 |  625 |   124 |        0 |
| mixed-wave-20000     | 20000 |        2 |               40 |         49,922 |            351,257 |            312 |          8,501 |                8 | 8500 | 8501 | 2500 |   499 |        0 |
| transit-stress-20000 | 20000 |        8 |               40 |        669,431 |            349,030 |          8,160 |          8,501 |                8 | 8500 | 8501 | 2500 |   499 |        0 |

Mode/OD distributions are identical to the baseline in every row — batching
preserved route choice exactly. Against the baseline table: route spawn fell
~47× / ~54× / ~55× on the base rows and ~111× on the stress row (74.64 s →
0.67 s), while the post-spawn tick is unchanged (within ~2–9% of baseline at
every count).

Conclusions supported by these numbers:

1. The 8-service row still materially exposes transit enumeration cost, now
   bounded: at the same 20000 demands, raising services 2 → 8 still raises
   route spawn 13.4× (49,922 → 669,431 µs) as shapes grow 26× (312 → 8,160,
   the service-pair S² term), but the absolute cost dropped from the
   baseline's 74.64 s to 0.67 s (~111×) and the stress/base spawn ratio fell
   from ~27× to ~13×.
2. Route-shape cardinality is batch-bound, not citizen-bound: 312 shapes at
   1000, 5000, and 20000 demands for the same 2-service fixture, and 8160 for
   the 8-service fixture — invariant under demand count (asserted by the
   test).
3. Car Dijkstra preparation follows access-pair cardinality: exactly 8
   prepared access paths in every row — the 4 home × 2 job building access
   pairs — constant from 1000 to 20000 demands and across service counts,
   against 40 distinct tile ODs (asserted: ≤ distinct OD, strictly lower in
   every row).
4. Route spawn vs post-spawn trip progression: in the base rows spawn is now
   the smaller phase (49,922 vs 351,257 µs at 20000, ~7× smaller); in the
   8-service stress row spawn is the larger phase (669,431 vs 349,030 µs,
   ~1.9× larger).
5. Dominant remaining measured phase: the 8-service route spawn (669 ms) is
   the largest single measured phase, driven by the 8160-shape enumeration.
   In the base workload the post-spawn tick dominates (~351 ms at 20000, ~7×
   spawn, unchanged from baseline). The current data proves only that the
   tick's cost is unaffected by batching; it does not attribute the tick's
   cost to repeated routing — normal planned Walking/Waiting trips reuse
   their stored plan and on-vehicle riders return early from boundary
   replanning, so a focused profile would be needed before claiming routing
   is the cause. As a side datum, `transit_flow_refreshes` equals the car
   count in each row (426 / 2,126 / 8,501): every registered car bumps the
   batch flow generation so the next demand re-scores Bus ride durations —
   the sequential-congestion contract, paid inside spawn, not the tick.

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

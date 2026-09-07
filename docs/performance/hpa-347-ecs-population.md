# HPA-347 ECS Latent Population — Pre-ECS Baseline

Baseline recorded before the HPA-347 ECS-backed latent population cutover, on
the same reference machine as the HPA-544 presentation baseline.

## Commands

```bash
bun run wasm:build:release
wc -c src/generated/caelum_wasm/caelum_wasm_bg.wasm
uname -a
rustc --version
cargo run --release -p caelum-core --example presentation_scale
```

## Reference environment

### OS

Darwin Chans-MacBook-Pro-3.local 25.6.0 Darwin Kernel Version 25.6.0: Fri Jul 31 19:18:49 PDT 2026; root:xnu-12377.161.14~5/RELEASE_ARM64_T6000 arm64

### CPU

Apple M1 Pro, 32 GB RAM

### Rust

rustc 1.96.0 (ac68faa20 2026-05-25)

### Build

`--release` for both the WASM artifact (`wasm-pack --release`, wasm-opt enabled)
and the `presentation_scale` example run.

## Population quiet-tick (current runtime, pre-ECS)

`measure_population_tick` compiles the road topology, unpauses a clone of the
fixture, and times one `trips::tick_trips` call with a 0.5 s delta that does
not intentionally cross a commute departure. The fixtures are the same
synthetic 10k/50k/200k sims matrices as HPA-544 (no active trips, no
buildings, no vehicles), so these rows isolate the per-tick cost of a latent
population under the current snapshot-per-step runtime.

| Fixture     |   Sims | population_tick_us | advanced_time |
| ----------- | -----: | -----------------: | ------------: |
| sims-10000  |  10000 |               4654 |           0.5 |
| sims-50000  |  50000 |              23081 |           0.5 |
| sims-200000 | 200000 |              95295 |           0.5 |

## Release WASM artifact size

**Before HPA-347 release WASM bytes:** 1313885
(`src/generated/caelum_wasm/caelum_wasm_bg.wasm`, measured with `wc -c` after
`bun run wasm:build:release`; the dev artifact was not reused).

Wall-clock and artifact-size values are reference evidence, not CI thresholds.

## Population quiet-tick (Stage A: ECS-owned Worker population)

After HPA-347 Task 5, the live Worker population is owned by the Bevy ECS
world: the shell snapshot carries no population mirror, and a quiet tick only
peeks the exact-time scheduler instead of scanning every sim. The same
worker-only 200k fixture is now measured through the engine
(`GameEngine::from_snapshot`, resumed via `SetPaused`, then one `GameEngine::tick`
with the same 0.5 s delta that does not cross a commute departure; the fixture
workers are dormant, so the tick exercises the scheduler path without emitting
trips). Row recorded on the same reference machine (Apple M1 Pro, rustc 1.96.0,
`--release`):

| Fixture     |   Sims | population_tick_us | advanced_time | applied |
| ----------- | -----: | -----------------: | ------------- | ------- |
| sims-200000 | 200000 |                156 | 0.5           | true    |

For comparison, the pre-ECS snapshot-per-step runtime measured the same
quiet tick at 95295 us (see the baseline section above). Wall-clock values are
reference evidence, not CI thresholds.

## Final evidence (Task 8: schema v10, Stage B enabled)

Recorded on the same reference machine (Apple M1 Pro, 32 GB RAM, rustc 1.96.0,
`--release`) at the completed HPA-347 state (schema v10, Student/day-off/
optional-outing behavior enabled), with:

```bash
cargo run --release -p caelum-core --example presentation_scale
cargo test --release -p caelum-core --test population_scale -- --ignored --nocapture
bun run wasm:build:release && wc -c src/generated/caelum_wasm/caelum_wasm_bg.wasm
```

### Runtime build / quiet tick / runtime presentation / full snapshot

`runtime_build_us` is the candidate-first `GameEngine::from_snapshot` build
(shell validation, topology compile, ECS world/schedule construction, shell
population-mirror clear). `quiet_tick_us` is one resumed `engine.tick(0.5)`
that crosses no wake. `runtime_presentation_us` is `engine.presentation()`
(ECS-built `PopulationAggregates` through the one projector).
`full_snapshot_us` is the explicit durable reconstruction `engine.snapshot()`
(O(population) — ordinary ticks never call it).

`runtime_build_us` was re-measured after a harness correction (the O(population)
`fixture.clone()` moved outside the timed window, so the figure covers only the
engine build); the other columns are from the original Task-8 pass above.

| Row        |   Sims | runtime_build_us | quiet_tick_us | runtime_presentation_us | full_snapshot_us |
| ---------- | -----: | ---------------: | ------------: | ----------------------: | ---------------: |
| ecs-10000  |  10000 |            12379 |           170 |                      19 |             1595 |
| ecs-50000  |  50000 |            69152 |           138 |                      19 |             8029 |
| ecs-200000 | 200000 |           292989 |           138 |                      20 |            35573 |

The dormant-population quiet tick is flat from 10k through 200k sims (~140 us,
versus 95295 us pre-ECS): an ordinary tick costs O(1) in latent population.
The linear costs are the two explicitly O(population) operations — building
the runtime once (load/New City/restore) and the explicit durable snapshot
reconstruction (save/debug) — neither of which is on the tick path.

### Scheduler emission vs route spawning

One wave of same-time due Workers on the small-town template (day-0 day-off
citizens excluded, so exactly N demands emit). `schedule_emit_us` covers the
exact-time scheduler emission — the due `run_due` pass (collect, canonicalize,
apply, emit) plus the demand drain — without route spawning.
`route_spawn_us` covers `spawn_pending_trip_demands` over the drained demands
(batch road-flow derivation plus route choice and private-car candidacy per
row, the O(due demand) bridge).

| Row        | Due demands | schedule_emit_us | route_spawn_us |
| ---------- | ----------: | ---------------: | -------------: |
| wave-1000  |        1000 |              370 |            243 |
| wave-5000  |        5000 |             1626 |           1272 |
| wave-20000 |       20000 |             6175 |           4784 |

Both phases are linear in wave size. **The dominant due-wave cost is scheduler
emission** (CollectDue/ApplyDue/EmitTripDemand plus the canonical demand
drain) — the larger half at every measured wave size, so the next bottleneck
is inside the population schedule's per-event work. Route spawning is a close
second and grows the same O(due demand) way; HPA-348 owns route-choice
batching and owns that term.

### Release WASM bytes

**After HPA-347 release WASM bytes:** 1849300
(`src/generated/caelum_wasm/caelum_wasm_bg.wasm`, measured with `wc -c` after
`bun run wasm:build:release`).

Before: 1313885. Delta: +535415 bytes (+40.8%) for the standalone
`bevy_ecs` dependency with default features off (no full `bevy`, no
reflection, no multithreaded schedule, no `rand`). Size is evidence, not a
threshold.

### HPA-544 presentation-cardinality rows (retained, final v10 run)

The Task 0 matrix re-run at the final schema-v10 state (durable `Sim` shrank
with the v10 scheduled-activity shape, so `sims-*` snapshot bytes differ from
the v9 baseline above; presentation behavior is unchanged).

| Fixture         |   Sims | Active trips | Buildings | Vehicles | Snapshot bytes | Serialize µs |
| --------------- | -----: | -----------: | --------: | -------: | -------------: | -----------: |
| current         |      0 |            0 |         0 |        0 |          39741 |           84 |
| sims-10000      |  10000 |            0 |         0 |        0 |        2041392 |         2524 |
| sims-50000      |  50000 |            0 |         0 |        0 |       10048372 |        15420 |
| sims-200000     | 200000 |            0 |         0 |        0 |       40074560 |        52978 |
| trips-1000      |      0 |         1000 |         0 |        0 |         339820 |          423 |
| trips-5000      |      0 |         5000 |         0 |        0 |        1540150 |         1940 |
| trips-20000     |      0 |        20000 |         0 |        0 |        6041392 |         7648 |
| buildings-1000  |      0 |            0 |      1000 |        0 |         169900 |          187 |
| buildings-5000  |      0 |            0 |      5000 |        0 |         690560 |          738 |
| buildings-20000 |      0 |            0 |     20000 |        0 |        2643044 |         3156 |
| vehicles-1000   |      0 |            0 |         0 |     1000 |         224720 |          311 |
| vehicles-5000   |      0 |            0 |         0 |     5000 |         964650 |         1354 |

Presentation projection stays flat in latent population (200k sims still
project in 29 us into a 302-byte frame) and O(presented rows) elsewhere;
HPA-640 owns WebGPU/viewport/LOD/cadence work beyond this contract.

All wall-clock and byte values in this document are reference evidence, not CI
thresholds.

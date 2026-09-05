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

| Fixture     |    Sims | population_tick_us | advanced_time |
| ----------- | ------: | -----------------: | ------------: |
| sims-10000  |   10000 |               4654 |           0.5 |
| sims-50000  |   50000 |              23081 |           0.5 |
| sims-200000 |  200000 |              95295 |           0.5 |

## Release WASM artifact size

**Before HPA-347 release WASM bytes:** 1313885
(`src/generated/caelum_wasm/caelum_wasm_bg.wasm`, measured with `wc -c` after
`bun run wasm:build:release`; the dev artifact was not reused).

Wall-clock and artifact-size values are reference evidence, not CI thresholds.

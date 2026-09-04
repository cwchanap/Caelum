# HPA-544 Presentation Baseline

## Command

`cargo run --release -p caelum-core --example presentation_scale`

## Reference environment

### OS

Darwin Chans-MacBook-Pro-3.local 25.6.0 Darwin Kernel Version 25.6.0: Fri Jul 31 19:18:49 PDT 2026; root:xnu-12377.161.14~5/RELEASE_ARM64_T6000 arm64

### CPU

Apple M1 Pro

### Rust

rustc 1.96.0 (ac68faa20 2026-05-25)

### Build

`--release`

## Before presentation cutover

| Fixture | Sims | Active trips | Buildings | Vehicles | Snapshot bytes | Serialize µs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| current | 0 | 0 | 0 | 0 | 39740 | 81 |
| sims-10000 | 10000 | 0 | 0 | 0 | 2791391 | 2757 |
| sims-50000 | 50000 | 0 | 0 | 0 | 13798371 | 14069 |
| sims-200000 | 200000 | 0 | 0 | 0 | 55074559 | 51395 |
| trips-1000 | 0 | 1000 | 0 | 0 | 339819 | 408 |
| trips-5000 | 0 | 5000 | 0 | 0 | 1540149 | 1803 |
| trips-20000 | 0 | 20000 | 0 | 0 | 6041391 | 7300 |
| buildings-1000 | 0 | 0 | 1000 | 0 | 169899 | 187 |
| buildings-5000 | 0 | 0 | 5000 | 0 | 690559 | 731 |
| buildings-20000 | 0 | 0 | 20000 | 0 | 2643043 | 3001 |

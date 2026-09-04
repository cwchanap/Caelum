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

| Fixture         |   Sims | Active trips | Buildings | Vehicles | Snapshot bytes | Serialize µs |
| --------------- | -----: | -----------: | --------: | -------: | -------------: | -----------: |
| current         |      0 |            0 |         0 |        0 |          39740 |           81 |
| sims-10000      |  10000 |            0 |         0 |        0 |        2791391 |         2757 |
| sims-50000      |  50000 |            0 |         0 |        0 |       13798371 |        14069 |
| sims-200000     | 200000 |            0 |         0 |        0 |       55074559 |        51395 |
| trips-1000      |      0 |         1000 |         0 |        0 |         339819 |          408 |
| trips-5000      |      0 |         5000 |         0 |        0 |        1540149 |         1803 |
| trips-20000     |      0 |        20000 |         0 |        0 |        6041391 |         7300 |
| buildings-1000  |      0 |            0 |      1000 |        0 |         169899 |          187 |
| buildings-5000  |      0 |            0 |      5000 |        0 |         690559 |          731 |
| buildings-20000 |      0 |            0 |     20000 |        0 |        2643043 |         3001 |

## After presentation cutover

Same command and reference machine as the before-cutover table. The
`current` through `buildings-20000` fixtures reuse the Task 0 matrix (so their
Snapshot bytes reproduce the rows above); `vehicles-1000`/`vehicles-5000` are
new projection fixtures.

| Fixture         | Snapshot bytes | Scene+frame bytes | Frame-only bytes | Presentation / snapshot | Projection µs | Presentation serialize µs |
| --------------- | -------------: | ----------------: | ---------------: | ----------------------: | ------------: | ------------------------: |
| current         |          39740 |             39614 |              297 |                   0.997 |            23 |                        55 |
| sims-10000      |        2791391 |             39618 |              301 |                   0.014 |            35 |                        59 |
| sims-50000      |       13798371 |             39618 |              301 |                   0.003 |            61 |                        71 |
| sims-200000     |       55074559 |             39619 |              302 |                   0.001 |            32 |                        56 |
| trips-1000      |         339819 |             57297 |            17980 |                   0.169 |            84 |                        97 |
| trips-5000      |        1540149 |             57761 |            18444 |                   0.038 |           210 |                        72 |
| trips-20000     |        6041391 |             57801 |            18484 |                   0.010 |           648 |                        75 |
| buildings-1000  |         169899 |            216772 |            47296 |                   1.276 |           106 |                       223 |
| buildings-5000  |         690559 |            925432 |           235296 |                   1.340 |           384 |                      1758 |
| buildings-20000 |        2643043 |           3582916 |           940296 |                   1.356 |          1488 |                      3882 |
| vehicles-1000   |         224719 |            192593 |           153276 |                   0.857 |            58 |                       268 |
| vehicles-5000   |         964649 |            804523 |           765206 |                   0.834 |           496 |                      1203 |

## Contract interpretation

- Latent sims no longer create one ordinary wire row per sim.
- Active-trip demand rows are bounded by distinct destination tiles rather than trip count.
- Building occupancy remains O(occupancy-capable buildings) and is measured at 1k/5k/20k.
- Transit vehicle presentation remains O(presented vehicles) and is measured at 1k/5k; HPA-640 owns viewport/LOD extraction and GPU batching.
- Wall-clock values are reference evidence, not CI thresholds.

Reading the measured rows (Presentation / snapshot = scene+frame bytes ÷ snapshot
bytes): latent population is the headline win — scene+frame stays at ~39.6 KB
(39,618–39,619 bytes) from 10k through 200k sims while snapshots grow from 2.79
MB to 55.07 MB, so the ratio falls from 0.014 to 0.001 and projection stays
under 61 µs. Active trips compress the hardest per row: 20k trips over the full
504-tile destination map serialize to an 18,484-byte frame (57,801 bytes with
scene) against a 6,041,391-byte snapshot, a 0.010 ratio. Building occupancy is
the honest exception: `include_scene` re-ships the placed buildings, so at 20k
buildings scene+frame (3,582,916 bytes) exceeds the snapshot (ratio 1.356) even
though frame-only occupancy rows stay far smaller (940,296 bytes). Vehicle
presentation is proportional but smaller than the snapshot (0.857 at 1k, 0.834
at 5k) because cursor rows drop passenger/capacity payloads. Projection cost
across the whole matrix stays between 23 and 1,488 µs, and presentation
serialization between 55 and 3,882 µs — reference evidence only, not CI
thresholds.

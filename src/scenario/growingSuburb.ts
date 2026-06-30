// Authoritative Growing Suburb map dimensions. These mirror the Rust
// constants in `crates/caelum-core/src/scenario.rs` (MAP_WIDTH / MAP_HEIGHT)
// and are exported so e2e helpers and tests can reference the source of truth
// instead of duplicating magic numbers. The authoritative map layout, scenario,
// objectives, and clock all live in `crates/caelum-core`; this module retains
// only the dimension constants the TS e2e layer needs for board geometry.
//
// TODO(HPA-118): if timed growth waves return as a real scenario mechanic,
// implement scheduling, zoning, and citizen spawning in `crates/caelum-core`.
// https://linear.app/cwchanap/issue/HPA-118
export const MAP_WIDTH = 28;
export const MAP_HEIGHT = 18;

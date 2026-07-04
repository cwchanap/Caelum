// Authoritative Growing Suburb map dimensions. These mirror the Rust
// constants in `crates/caelum-core/src/scenario.rs` (MAP_WIDTH / MAP_HEIGHT)
// and are exported so e2e helpers and tests can reference the source of truth
// instead of duplicating magic numbers. The authoritative map layout, scenario,
// objectives, and clock all live in `crates/caelum-core`; this module retains
// only the dimension constants the TS e2e layer needs for board geometry.
//
// Growth waves now live in `crates/caelum-core` (ScenarioConfig.growth_waves);
// the shell reads `snapshot.scenario.growthWaves` read-only. The Growing Suburb
// seed wave is implemented (`growing_suburb_growth_waves`) but not yet wired.
export const MAP_WIDTH = 28;
export const MAP_HEIGHT = 18;

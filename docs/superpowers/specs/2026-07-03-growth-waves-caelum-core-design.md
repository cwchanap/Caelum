# Own growth waves (zoning + citizen spawning) in `caelum-core`

**Linear:** [HPA-118](https://linear.app/cwchanap/issue/HPA-118/own-growth-waves-zoning-citizen-spawning-in-caelum-core)
**Date:** 2026-07-03
**Status:** Approved design

## Summary

Move the **growth wave** gameplay concept (timed zoning of tiles + spawning of
citizens + intro copy) into the authoritative Rust core `crates/caelum-core`, so
it is owned and applied by the tick pipeline rather than synthesized on the
TypeScript side. This is the one remaining piece of *gameplay* state not owned by
Rust.

**Scope for this change is infrastructure only.** Growing Suburb ships today as a
deliberate empty sandbox (`676ed1b` "start from empty zonable map", `3861657`
"remove TS-side growth wave synthesis") — no timed waves, no starting citizens.
We keep that: the wave mechanic is built, tested, and emitted by the core, but the
Growing Suburb wave list stays **empty**. Result: **zero runtime behavior change**
for Growing Suburb, the TS shim is removed, browser (WASM) and Tauri hosts become
symmetric by construction, and the mechanic is ready + unit-tested for future
scenarios.

### Context correction

The ticket states "the Rust core does not yet model citizen spawning or
zoning/area assignment." That framing is now **stale**:

- The core already spawns `Sim`s via **housing buildings**
  (`buildings::place_building`, `effect == "housing"` → `assign_workplaces`).
- The core already zones `area` on tiles via the **`PaintAreaRectangle`** intent
  (`areas::paint_area_rectangle`).

Both are *player-driven*. The genuinely missing piece — and what this change adds
— is **scenario-authored, timed, automatic** zoning + spawning: growth *waves*
applied by the tick pipeline. The implementation therefore **reuses** the existing
sim-spawning and workplace-assignment machinery rather than introducing a parallel
path.

## Non-goals

- No new scenarios beyond Growing Suburb.
- No change to objective thresholds or win/loss logic.
- No non-empty Growing Suburb wave schedule (sandbox stays empty by decision).

## Current architecture (relevant pieces)

- `crates/caelum-core/src/state.rs` — `create_initial_snapshot()`: empty `sims`,
  empty map areas, `scenario = growing_suburb_scenario()`.
- `crates/caelum-core/src/scenario.rs` — `growing_suburb_scenario()` returns
  `ScenarioConfig { name, objectives }` (no waves).
- `crates/caelum-core/src/model.rs` — `ScenarioConfig`, `GameSnapshot`, `Sim`.
- `crates/caelum-core/src/buildings.rs` — housing spawns `Sim`s (home = footprint
  tile, `worker_profile`/`shift_template` derived from id via
  `commute::worker_profile_for_id`/`shift_template_for_id`, `workplace: None`),
  then `assign_workplaces()` + `trips::retarget_home_fallback_trips()`.
- `crates/caelum-core/src/trips.rs` — `tick_trips_substepped()` breaks each tick
  at meaningful boundaries (`next_boundary_after`, bounded by `max_tick_substeps`)
  and runs `spawn_due_commute_trips()` at each boundary.
- `src/runtime/snapshotView.ts` — `normalizeRustSnapshot()` currently hardcodes
  `scenario.growthWaves = []`.
- `src/domain/types.ts` — `Scenario`, `GrowthWave`, `GrowthWaveTile` (the wire
  format, retained unchanged).
- Read-only wave consumers already exist: `runtimeSelectors.ts:268` (Brief panel
  shows the first unapplied wave's `message`) and `overlayRenderer.ts:372` (growth
  overlay paints wave tiles). Both stay dormant while the core emits `[]` and light
  up automatically when a real wave ships.

## Design

### 1. Data model & wire format

Add to `crates/caelum-core/src/model.rs`, mirroring the existing TS
`Scenario`/`GrowthWave`/`GrowthWaveTile` types (camelCase serde for wire parity):

```rust
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrowthWave {
    pub id: String,
    pub trigger_time: f64,
    pub tiles: Vec<GrowthWaveTile>,
    pub message: String,
    pub applied: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrowthWaveTile {
    pub id: String,
    pub x: i32,
    pub y: i32,
    pub area: String,        // must be one of areas::AREAS
    pub creates_citizens: u16,
}
```

**Decision A — waves live in `ScenarioConfig`.** Add
`growth_waves: Vec<GrowthWave>` to `ScenarioConfig`. It serializes to
`scenario.growthWaves`, which is exactly the TS `Scenario.growthWaves` wire shape,
so `normalizeRustSnapshot` becomes a pure pass-through and both existing consumers
work unchanged.

- *Rejected alternative:* a separate top-level `GameSnapshot.growth_waves` field
  (as the ticket literally phrases it) with TS reassembling `scenario.growthWaves`
  — extra TS glue, no wire parity.
- `growing_suburb_scenario()` seeds `growth_waves: vec![]`.
- The doc comment on the `scenario` field currently says "Static scenario
  identity + objective thresholds"; update it to note that `growth_waves[].applied`
  mutates over the run.
- Serde `#[serde(default)]` on the new `ScenarioConfig` field so older
  serialized snapshots (without waves) still deserialize.

### 2. `tick_growth` step & timing

New module `crates/caelum-core/src/growth.rs` exposing
`apply_due_growth_waves(&mut GameSnapshot)`.

Wire it into `trips::tick_trips_substepped`:

- Call `apply_due_growth_waves(&mut next)` at the **top of each substep
  iteration**, before `reset_daily_commute_flags` / `spawn_due_commute_trips`, and
  again in the **final flush block**. This lets a wave that fires at time `T` seed
  sims whose commute departures are then picked up by `spawn_due_commute_trips` in
  the same tick.
- Early-return guard inside `apply_due_growth_waves` when there are no
  unapplied-due waves (the shipped Growing Suburb path is a cheap no-op).

**Decision B — trigger times are substep boundaries.** Add each unapplied wave's
`trigger_time` (when `> state.time` and `<= final_time`) to the boundary set in
`next_boundary_after`, and extend the `max_tick_substeps` upper bound by
`state.scenario.growth_waves.len()`. This preserves the
**granularity-independence / determinism contract**: one coarse tick and many fine
ticks produce identical spawns because no substep straddles a trigger.

- *Rejected alternative:* apply once at tick start (coarse), like the old TS
  `applyDueGrowthWaves`. A large resume-tick could overshoot a trigger and desync
  spawn timing/IDs relative to a stepped run.

### 3. Zoning + spawning semantics (reuse, no new gameplay paths)

`apply_due_growth_waves` iterates due waves (`!applied && trigger_time <=
state.time`) in **deterministic order** — wave order, then tile order, then
citizen index:

1. **Zone.** For each wave tile, set `tile.area = Some(area)` **only** on bare
   empty ground (reuse the `areas::is_area_paintable` / `isBareGround` guard: skip
   tiles the player already built road/track/building/stop on — they are left as
   the player left them; growth only touches the `area` layer of bare tiles).
2. **Spawn.** For `creates_citizens` per still-bare tile, push a `Sim`:
   - `home = position`, `position = home`,
   - `worker_profile = commute::worker_profile_for_id(&id)`,
   - `shift_template = commute::shift_template_for_id(&id).map(str::to_string)`,
   - `workplace: None`, `commute_day: 0`, daily flags `false`,
   - `id = ids::next_entity_id("sim", existing sim ids)`.
3. After spawning, call `buildings::assign_workplaces(&mut state)` and
   `trips::retarget_home_fallback_trips(&mut state)` — the exact housing-building
   post-spawn path. With no destination buildings present, wave sims are dormant
   home-fallback (`workplace == home`) until the player builds a destination, which
   promotes and activates them. This matches the old "seed demand" semantics.
4. Set `wave.applied = true` on the snapshot's `scenario.growth_waves`.

Validation: a wave tile whose `area` is not in `areas::AREAS` is skipped (not
zoned, no spawn) rather than panicking.

Reused, no duplicated logic: `commute::worker_profile_for_id` /
`shift_template_for_id`, `ids::next_entity_id`, `buildings::assign_workplaces`,
`trips::retarget_home_fallback_trips`.

### 4. TS shim removal & host symmetry

- `src/runtime/snapshotView.ts`: replace `growthWaves: []` with
  `growthWaves: snapshot.scenario.growthWaves` (pass-through); drop the HPA-118
  TODO block.
- `src/scenario/growingSuburb.ts`: update the stale HPA-118 TODO comment (the file
  already holds only `MAP_WIDTH`/`MAP_HEIGHT`).
- TS `GrowthWave` / `GrowthWaveTile` / `Scenario` types unchanged (wire format).
- Browser (WASM) and Tauri both serialize `scenario.growthWaves` from the same
  `caelum-core` snapshot → symmetric by construction.

### 5. Testing

**Rust** (unit tests in `growth.rs` / crate tests):

- **Application:** a synthetic single-wave snapshot, ticked past `trigger_time`,
  yields the expected zoned tiles and `creates_citizens` sims with the expected
  deterministic IDs, and `applied == true`.
- **Idempotency:** a second tick does not re-spawn or re-zone (the `applied` guard
  holds).
- **Granularity determinism:** one coarse tick vs many fine ticks across the
  trigger produce identical `sims` (IDs, homes, profiles) and identical zoning.
- **Bare-ground guard:** a wave tile already occupied by road/track/building/stop
  is neither zoned nor spawned onto.
- **Empty list:** the Growing Suburb scenario ticks with no waves applied and no
  sims spawned (no-op).
- **Workplace hand-off:** after a wave spawns dormant home-fallback sims,
  placing a destination building promotes them to a real workplace (reuses
  existing `assign_workplaces` behavior; a light assertion that wave sims
  integrate with it).

**TypeScript** (`tests/runtime/backendContract.test.ts`):

- Keep `expect(snapshot.scenario.growthWaves).toEqual([])` for the real
  (now Rust-sourced) Growing Suburb snapshot.
- Add a case proving `normalizeRustSnapshot` **passes through** a non-empty
  `scenario.growthWaves` from the Rust snapshot (i.e. it is no longer a hardcoded
  `[]`).

Existing `overlayRenderer` and `runtimeSelectors` tests already exercise rendering
from `scenario.growthWaves`.

## Acceptance criteria (from HPA-118)

- [x] `crates/caelum-core` owns wave scheduling, zoning, and citizen spawning; the
      tick pipeline applies them deterministically. *(§2, §3)*
- [x] `src/runtime/snapshotView.ts` no longer injects growth waves — it reads them
      from the Rust snapshot. *(§4)*
- [x] `src/scenario/growingSuburb.ts` no longer defines wave gameplay. *(§4)*
- [x] Browser and Tauri hosts produce identical wave/citizen sequences for the same
      tick count. *(§4 — single core source)*
- [x] Determinism preserved: identical inputs → identical spawn IDs/counts/timing.
      *(§2 Decision B, §3 deterministic order, §5 granularity test)*
- [x] New Rust + TS tests cover wave timing, application idempotency (`applied`),
      and the determinism contract. *(§5)*

> Note on the "identical sequences" criterion: for the shipped Growing Suburb
> scenario the sequence is the empty sequence (no waves). The mechanic that would
> produce a non-empty sequence is fully implemented and unit-tested; wiring a live
> Growing Suburb wave schedule is intentionally out of scope per the agreed
> "infra only, keep sandbox empty" decision.

## Files touched

- `crates/caelum-core/src/model.rs` — `GrowthWave`, `GrowthWaveTile`,
  `ScenarioConfig.growth_waves`; doc comment update.
- `crates/caelum-core/src/scenario.rs` — seed `growth_waves: vec![]`.
- `crates/caelum-core/src/growth.rs` — **new**: `apply_due_growth_waves`.
- `crates/caelum-core/src/lib.rs` — register `growth` module.
- `crates/caelum-core/src/trips.rs` — call `apply_due_growth_waves`; add trigger
  times to `next_boundary_after`; extend `max_tick_substeps`.
- `src/runtime/snapshotView.ts` — pass-through waves.
- `src/scenario/growingSuburb.ts` — update stale TODO.
- Tests: `crates/caelum-core` growth tests, `tests/runtime/backendContract.test.ts`.

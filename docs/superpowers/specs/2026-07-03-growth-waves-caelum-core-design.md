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

**Runtime model:** a growth wave is a batch of **scheduled scenario intents** —
the same gameplay mutations the player already performs (`PaintAreaRectangle`,
`PlaceBuilding`) — applied at a trigger time through the **existing** engine
handlers. Sims and workplaces then arise through the normal
zone → build → spawn coupling. There is no parallel spawn path and no
"bodiless citizen" concept; when a wave fires, the world visibly grows (zones are
painted, housing appears, and that housing spawns sims exactly as a player's
placement would).

**Authoring model (grid-derived magnitude):** Growing Suburb ships a single
**seed wave** whose *size* is deduced from the grid — the scenario places
`f(MAP_WIDTH × MAP_HEIGHT)` housing units at authored anchor positions, rather than
a magic hardcoded citizen count. Grid-scaling therefore lives entirely at
**scenario-authoring time** (a pure function in `scenario.rs`); the runtime is
unchanged and simply replays the authored intents. Bigger maps seed proportionally
more housing without re-authoring coordinates.

This **replaces** the previous "ship empty" decision: Growing Suburb now grows on
its own again (a small residential seed on the first tick), but the schedule is
authored and its magnitude is grid-derived. Browser (WASM) and Tauri hosts stay
symmetric by construction, and the TS-side `growthWaves` shim is removed.

### Why "scheduled intents" and not the ticket's port

The ticket proposes porting the retired TS wave: zone bare tiles and spawn
citizens *directly on unbuilt ground*. In the **current** codebase that bypasses
the mechanic the rest of the game is built on:

- **Zoning gates placement.** `buildings::place_building` enforces
  `definition.allowed_area` (`"area mismatch"`): housing requires a `residential`
  tile, destinations require `commercial`/`industrial`/`office`, etc.
- **Buildings are the sole sim source.** `place_building` (`effect == "housing"`)
  is the only path that pushes `Sim`s, and it runs `assign_workplaces` +
  `retarget_home_fallback_trips` for both housing and destination placements.

So the real growth loop is **zone → place building → (housing) spawn sims /
(destination) create workplaces**, all expressed as `GameIntent`s. Modelling a
wave as scheduled intents reuses that loop verbatim; porting the old
bodiless-citizen path would reintroduce a second spawn mechanism that sidesteps
zoning and buildings.

## Non-goals

- No new scenarios beyond Growing Suburb.
- No change to objective thresholds or win/loss logic.
- No **runtime** procedural site-selection: waves apply authored actions; the core
  does not decide *where* to grow based on live player state. (Grid-scaling is a
  pure authoring-time computation.)
- No new gameplay mutation types — waves may only issue mutations the player can
  already perform.

## Current architecture (relevant pieces)

- `crates/caelum-core/src/state.rs` — `create_initial_snapshot()`: empty `sims`,
  empty map areas, `scenario = growing_suburb_scenario()`.
- `crates/caelum-core/src/scenario.rs` — `growing_suburb_scenario()` returns
  `ScenarioConfig { name, objectives }`; `MAP_WIDTH = 28`, `MAP_HEIGHT = 18`; the
  starter arterial cross occupies `y ∈ {8, 9}` and `x ∈ {14, 15}`.
- `crates/caelum-core/src/model.rs` — `ScenarioConfig`, `GameSnapshot`, `Sim`,
  `Point`.
- `crates/caelum-core/src/areas.rs` — `paint_area_rectangle(state, area, start,
  end) -> Option<GameSnapshot>` (clips to map, zones bare tiles).
- `crates/caelum-core/src/buildings.rs` — `place_building(...) -> Result<
  GameSnapshot, String>`: budget check + deduct, `can_place_building` (enforces
  `allowed_area`, occupancy, track rules), transit-node creation, housing spawns
  `Sim`s (worker profile / shift from `commute::*_for_id`), then
  `assign_workplaces` + `trips::retarget_home_fallback_trips`.
- `crates/caelum-core/src/building_catalog.rs` — per building: `width`/`height`
  footprint, `cost`, `allowed_area`, `effect`, `citizen_count`. Seed-relevant:
  `smallHouse` (2×1, residential, housing, 4 citizens, cost 4 000);
  `largeHouse` (3×2, residential, housing, 10 citizens).
- `crates/caelum-core/src/trips.rs` — `tick_trips_substepped()` breaks each tick
  at meaningful boundaries (`next_boundary_after`, bounded by `max_tick_substeps`)
  and runs `spawn_due_commute_trips()` at each boundary.
- `src/runtime/snapshotView.ts` — `normalizeRustSnapshot()` currently hardcodes
  `scenario.growthWaves = []`.
- `src/domain/types.ts` — `Scenario`, `GrowthWave`, `GrowthWaveTile` (wire types;
  reshaped below).
- Read-only wave consumers: `runtimeSelectors.ts:268` (Brief panel shows the first
  unapplied wave's `message`) and `overlayRenderer.ts:372` (growth overlay
  telegraphs upcoming wave tiles).

## Design

### 1. Data model & wire format

Add to `crates/caelum-core/src/model.rs`:

```rust
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrowthWave {
    pub id: String,
    pub trigger_time: f64,
    pub message: String,
    pub applied: bool,
    pub actions: Vec<GrowthAction>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum GrowthAction {
    PaintAreaRectangle { area: String, start: Point, end: Point },
    PlaceBuilding { building_type: String, origin: Point, rotation: u16 },
}
```

`GrowthAction` mirrors the corresponding `GameIntent` variants and serializes as a
`type`-tagged discriminated union (`{ "type": "paintAreaRectangle", ... }` /
`{ "type": "placeBuilding", "buildingType": ..., "origin": ..., "rotation": ... }`)
for a clean TS union.

**Decision A — waves live in `ScenarioConfig`.** Add
`growth_waves: Vec<GrowthWave>` (with `#[serde(default)]`) to `ScenarioConfig`. It
serializes to `scenario.growthWaves`, exactly the TS `Scenario.growthWaves` wire
shape, so `normalizeRustSnapshot` becomes a pure pass-through.

- *Rejected alternative:* a separate top-level `GameSnapshot.growth_waves` field
  (as the ticket literally phrases it) with TS reassembling `scenario.growthWaves`
  — extra TS glue, no wire parity.
- Update the `scenario`-field doc comment (currently "Static scenario identity +
  objective thresholds") to note `growth_waves[].applied` mutates over the run.

### 2. Growing Suburb seed wave (grid-derived authoring)

In `scenario.rs`, `growing_suburb_scenario()` seeds `growth_waves` from a new pure
helper `growing_suburb_growth_waves() -> Vec<GrowthWave>` that computes a single
seed wave from the map dimensions:

- **Unit count from grid:**
  `n_units = max(1, (MAP_WIDTH as i32 * MAP_HEIGHT as i32) / GRID_CELLS_PER_HOUSING_UNIT)`,
  with `GRID_CELLS_PER_HOUSING_UNIT = 100` (tunable). For the shipped 28×18 map:
  `504 / 100 = 5` units → `5 × 4 = 20` seed citizens.
- **Seed unit:** `smallHouse` (2×1 footprint, 4 citizens) — the smallest housing
  footprint, simplest to pack.
- **Deterministic packing:** lay units row-major from `SEED_ANCHOR = (2, 3)`,
  `SEED_UNITS_PER_ROW = 6` per row; unit *k* origin =
  `(2 + (k % 6) * 2, 3 + (k / 6))`. The anchor/stride keep every footprint on bare
  ground **west of the `x = 14` vertical arterial** and clear of the `y ∈ {8, 9}`
  horizontal arterial and the map bounds. For the shipped map this is one row of 5
  small houses occupying `x ∈ [2, 11]`, `y = 3`.
- **Actions (order matters — zone precedes build):**
  1. `PaintAreaRectangle { area: "residential", start: (2, 3), end: (max_x, max_y) }`
     over the units' bounding rectangle, and
  2. one `PlaceBuilding { building_type: "smallHouse", origin, rotation: 0 }` per
     unit.
- **Wave:** `GrowthWave { id: "wave-seed-residential", trigger_time: 0.0,
  message: "First residents arrive — build destinations so they can commute.",
  applied: false, actions }`.

`trigger_time = 0.0` fires on the first unpaused tick (matching the retired seed
wave). With no destination buildings present, the spawned sims are dormant
(`workplace == None`, held by `has_valid_workplace_destination`) until the player
zones commercial/etc. and builds a destination — preserving the "must build
destinations and serve a trip to win" gate. The `Vec` and trigger-time boundaries
(§3) already support additional or later-triggering authored waves if the schedule
is extended in future.

### 3. `tick_growth` step & timing

New module `crates/caelum-core/src/growth.rs` exposing
`apply_due_growth_waves(&mut GameSnapshot)`.

Wire it into `trips::tick_trips_substepped`:

- Call `apply_due_growth_waves(&mut next)` at the **top of each substep
  iteration**, before `reset_daily_commute_flags` / `spawn_due_commute_trips`, and
  again in the **final flush block**. This lets a wave that fires at time `T` seed
  sims whose commute departures are then picked up by `spawn_due_commute_trips` in
  the same tick.
- Early-return guard when no wave is unapplied-and-due (cheap once the seed wave is
  applied).

**Decision B — trigger times are substep boundaries.** Add each unapplied wave's
`trigger_time` (when `> state.time` and `<= final_time`) to the boundary set in
`next_boundary_after`, and extend `max_tick_substeps` by
`state.scenario.growth_waves.len()`. This preserves the **granularity-independence
/ determinism contract**: one coarse tick and many fine ticks produce identical
results because no substep straddles a trigger.

- *Rejected alternative:* apply once at tick start (coarse) — a large resume-tick
  could overshoot a trigger and desync timing/IDs relative to a stepped run.

### 4. Applying a wave (reuse the engine's own handlers)

`apply_due_growth_waves` selects due waves (`!applied && trigger_time <=
state.time`) and applies them **in declared order** (waves, then actions within a
wave). Each action is threaded through the existing handler:

- `PaintAreaRectangle` → `areas::paint_area_rectangle(&state, area, start, end)`;
  take the returned snapshot when `Some`, else keep the current one (a no-op paint
  is a deterministic skip).
- `PlaceBuilding` → `buildings::place_building_core(&state, building_type, origin,
  rotation)`; take the returned snapshot when `Ok`, else keep the current one (an
  invalid placement — wrong zone, occupied, off-map — is a deterministic skip, as a
  player's invalid click is a no-op).

Because these are the player's own handlers, everything follows automatically:
zoning gates, footprint/occupancy validation, housing sim spawning with
deterministic IDs (`next_entity_id`), and `assign_workplaces` +
`retarget_home_fallback_trips`. After all actions apply, set `applied = true` on
the snapshot's `scenario.growth_waves`.

**Budget exemption (a wave is the world growing, not the player spending).** Factor
`buildings::place_building` into:

- `place_building_core(state, type, origin, rotation) -> Result<GameSnapshot,
  String>` — everything except the budget check and `next.budget -= cost`.
- `place_building(state, ...)` — budget check → `place_building_core` → deduct
  `cost` (unchanged public behavior; the `PlaceBuilding` intent path is
  byte-for-byte identical).

Waves call `place_building_core`, so world growth does not charge or gate on the
player's budget. `paint_area_rectangle` has no budget dimension and is reused
directly.

Determinism: action order is fixed; grid-derived authoring is a pure function of
map constants; all ID allocation is `next_entity_id` over existing IDs; no
wall-clock or RNG. Identical map + tick counts produce identical snapshots.

### 5. TS shim removal, consumers & host symmetry

- `src/runtime/snapshotView.ts`: replace `growthWaves: []` with
  `growthWaves: snapshot.scenario.growthWaves` (pass-through); drop the HPA-118
  TODO block.
- `src/domain/types.ts`: reshape `GrowthWave` to `{ id, triggerTime, message,
  applied, actions: GrowthAction[] }` and add the `GrowthAction` union
  (`{ type: "paintAreaRectangle"; area; start; end }` |
  `{ type: "placeBuilding"; buildingType; origin; rotation }`). Remove the now-unused
  `GrowthWaveTile`.
- `src/render/overlayRenderer.ts`: the growth overlay telegraphs upcoming growth by
  deriving tiles from each unapplied wave's `paintAreaRectangle` actions (expand
  each rectangle to its tiles, tint by `area`) instead of reading `wave.tiles`.
- `src/runtime/runtimeSelectors.ts`: Brief panel is unchanged (still
  `message` + `applied`); it now shows the seed wave's copy until the wave applies.
- `src/scenario/growingSuburb.ts`: update the stale HPA-118 TODO comment (the file
  already holds only `MAP_WIDTH`/`MAP_HEIGHT`).
- Browser (WASM) and Tauri both serialize `scenario.growthWaves` from the same
  `caelum-core` snapshot → symmetric by construction.

### 6. Testing

**Rust** — scenario authoring (`scenario.rs` tests):

- `n_units == grid_count / GRID_CELLS_PER_HOUSING_UNIT` (5 for 28×18), and scales
  with dimensions (assert with a couple of synthetic sizes via the helper).
- The seed wave is well-formed: first action is the residential
  `PaintAreaRectangle`; the remaining are `n_units` `smallHouse` placements; every
  footprint tile is on the map, bare (not on the arterial cross), and inside the
  zoned rectangle (paint-before-build ordering holds).

**Rust** — wave application (`growth.rs` tests) with the seed wave and synthetic
waves:

- **Application:** ticking Growing Suburb past `trigger_time` zones the block,
  places the `n_units` houses, and spawns `n_units × 4` sims with deterministic
  IDs; `applied == true`; **player budget unchanged** (exemption).
- **Zone→build coupling:** a synthetic `placeBuilding(housing)` whose tile the wave
  did not zone is a deterministic skip (`"area mismatch"`); paint-before-build in
  the same wave makes it succeed.
- **Idempotency:** a second tick does not re-apply (no duplicate houses/sims).
- **Granularity determinism:** one coarse tick vs many fine ticks across the
  trigger produce identical `map` (areas), `buildings`, and `sims`.
- **Commute hand-off (light integration):** after the seed wave, placing a
  destination (zone commercial + supermarket) assigns workplaces via
  `assign_workplaces` and the seed sims commute deterministically.

**TypeScript** (`tests/runtime/backendContract.test.ts`):

- Replace the `toEqual([])` assertion: the Growing Suburb snapshot now carries the
  seed wave (`id: "wave-seed-residential"`, `triggerTime: 0`, actions = one
  `paintAreaRectangle` + `n_units` `placeBuilding`), and after ticking it reports
  `applied: true` with sims present.
- Add/keep a case proving `normalizeRustSnapshot` **passes through**
  `scenario.growthWaves` from the Rust snapshot (no hardcoded value).
- Update `tests/render/overlayRenderer.test.ts` to build waves in the new `actions`
  shape and assert the telegraph derives tiles from `paintAreaRectangle` actions.

## Acceptance criteria (from HPA-118)

- [x] `crates/caelum-core` owns wave scheduling, zoning, and citizen spawning; the
      tick pipeline applies them deterministically. *(§3, §4)*
- [x] `src/runtime/snapshotView.ts` no longer injects growth waves — it reads them
      from the Rust snapshot. *(§5)*
- [x] `src/scenario/growingSuburb.ts` no longer defines wave gameplay. *(§5)*
- [x] Browser and Tauri hosts produce identical wave/citizen sequences for the same
      tick count. *(§5 — single core source; §4 determinism)*
- [x] Determinism preserved: identical inputs → identical spawn IDs/counts/timing.
      *(§2 pure authoring, §3 Decision B, §4 fixed order + `next_entity_id`, §6)*
- [x] New Rust + TS tests cover wave timing, application idempotency (`applied`),
      and the determinism contract. *(§6)*

> Departures from the ticket's proposed approach (both to fit the current
> codebase): (1) a wave is modelled as scheduled `PaintAreaRectangle`/
> `PlaceBuilding` intents applied through the existing engine handlers, rather than
> a bespoke zone-tiles-and-spawn-bodiless-citizens step, because zoning gates
> placement and buildings are the sole sim source; (2) the Growing Suburb seed
> wave's magnitude is **grid-derived** (`f(MAP_WIDTH × MAP_HEIGHT)` housing units)
> at authoring time rather than a hardcoded citizen count, so it scales with map
> size. This restores autonomous seed growth (superseding the earlier interim
> "ship empty" decision).

## Files touched

- `crates/caelum-core/src/model.rs` — `GrowthWave`, `GrowthAction`,
  `ScenarioConfig.growth_waves`; doc comment update.
- `crates/caelum-core/src/scenario.rs` — `growing_suburb_growth_waves()` +
  `GRID_CELLS_PER_HOUSING_UNIT` / packing constants; seed into
  `growing_suburb_scenario()`.
- `crates/caelum-core/src/growth.rs` — **new**: `apply_due_growth_waves`.
- `crates/caelum-core/src/buildings.rs` — extract `place_building_core`
  (budget-exempt); `place_building` wraps it.
- `crates/caelum-core/src/lib.rs` — register `growth` module.
- `crates/caelum-core/src/trips.rs` — call `apply_due_growth_waves`; add trigger
  times to `next_boundary_after`; extend `max_tick_substeps`.
- `src/runtime/snapshotView.ts` — pass-through waves.
- `src/domain/types.ts` — reshape `GrowthWave`, add `GrowthAction`, remove
  `GrowthWaveTile`.
- `src/render/overlayRenderer.ts` — telegraph derives tiles from wave actions.
- `src/scenario/growingSuburb.ts` — update stale TODO.
- Tests: `crates/caelum-core` scenario + growth tests,
  `tests/runtime/backendContract.test.ts`, `tests/render/overlayRenderer.test.ts`.

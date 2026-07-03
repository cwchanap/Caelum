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

**Authoring model (grid-derived magnitude):** the scenario module provides a pure
helper that computes a **seed wave** whose *size* is deduced from the grid — it
places `f(MAP_WIDTH × MAP_HEIGHT)` housing units at authored anchor positions,
rather than a magic hardcoded citizen count. Grid-scaling therefore lives entirely
at **scenario-authoring time**; the runtime is unchanged and simply replays the
authored intents.

**Scope — infra only; the seed is implemented and unit-tested but NOT wired into
the shipped scenario.** Wiring the live seed wave would change what the shared base
scenario (`GameEngine::new()` / `create_initial_snapshot()`) does on the first
unpaused tick, and that base is the substrate for nearly the entire `caelum-core`
test suite — including hand-captured **golden sequences** whose baked-in constants
exist precisely to catch behavioural regressions. Auto-firing the seed would inject
5 houses + 20 sims into all of them, forcing a large, low-value rebaseline. So:

- The full mechanism (model, `tick_growth`, budget-exempt placement, substep-
  boundary timing) is built and exercised with **synthetic** waves + the seed
  helper's output.
- The grid-scaled seed helper is implemented and **unit-tested** (formula + packing
  + well-formedness).
- `growing_suburb_scenario()` ships `growth_waves: vec![]` — **zero runtime
  behavior change** for Growing Suburb, deterministic suite and golden traces
  untouched.
- Wiring the live seed (calling the helper from `growing_suburb_scenario()`) is a
  small, deliberate follow-up that owns its own test-substrate migration.

Browser (WASM) and Tauri hosts read `scenario.growthWaves` from the same core
snapshot → symmetric by construction; the TS-side `growthWaves` shim is removed.

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
- **Not wiring the seed wave into the shipped scenario** (kept `[]` to avoid
  rebaselining the golden/lifecycle suite); the grid-scaled helper is implemented +
  tested and ready to wire in a follow-up.
- No **runtime** procedural site-selection: waves apply authored actions; the core
  does not decide *where* to grow based on live player state.
- No new gameplay mutation types — waves may only issue mutations the player can
  already perform.

## Current architecture (relevant pieces)

- `crates/caelum-core/src/state.rs` — `create_initial_snapshot()`: `paused: true`,
  empty `sims`, empty map areas, `scenario = growing_suburb_scenario()`.
- `crates/caelum-core/src/scenario.rs` — `growing_suburb_scenario()` returns
  `ScenarioConfig { name, objectives }`; `MAP_WIDTH = 28`, `MAP_HEIGHT = 18`; the
  starter arterial cross occupies `y ∈ {8, 9}` and `x ∈ {14, 15}`.
- `crates/caelum-core/src/model.rs` — `ScenarioConfig`, `GameSnapshot`, `Sim`,
  `Point`. `ScenarioConfig` currently `{ name, objectives }`.
- `crates/caelum-core/src/intent.rs` — `GameIntent` is a `#[serde(tag = "type",
  rename_all = "camelCase", rename_all_fields = "camelCase")]` enum with variants
  `PaintAreaRectangle { area, start, end }` and `PlaceBuilding { building_type,
  origin, rotation }`. `GrowthAction` mirrors these two variants and their serde
  attributes exactly.
- `crates/caelum-core/src/areas.rs` — `paint_area_rectangle(state, area, start,
  end) -> Option<GameSnapshot>` (clips to map, zones bare tiles).
- `crates/caelum-core/src/buildings.rs` — `place_building(...) -> Result<
  GameSnapshot, String>`: budget check + deduct, `can_place_building` (enforces
  `allowed_area`, occupancy, track rules), transit-node creation, housing spawns
  `Sim`s (worker profile / shift from `commute::*_for_id`), then
  `assign_workplaces` + `trips::retarget_home_fallback_trips`.
- `crates/caelum-core/src/building_catalog.rs` — per building: `width`/`height`,
  `cost`, `allowed_area`, `effect`, `citizen_count`. Seed-relevant: `smallHouse`
  (2×1, residential, housing, 4 citizens, cost 4 000).
- `crates/caelum-core/src/trips.rs` — `tick_trips_substepped()` returns early when
  `paused`/won/lost/speed 0; otherwise loops substeps, each broken at
  `next_boundary_after` (bounded by `max_tick_substeps`), running
  `reset_daily_commute_flags` + `spawn_due_commute_trips` at the top of each and in
  a final flush. `track_next_boundary(&mut opt, candidate, after)` records the
  earliest future boundary.
- `src/runtime/snapshotView.ts` — `normalizeRustSnapshot()` hardcodes
  `scenario.growthWaves = []`.
- `src/runtime/backend/types.ts` — `RustScenarioConfig { name, objectives }`
  (no waves).
- `src/domain/types.ts` — `Scenario`, `GrowthWave`, `GrowthWaveTile` (wire types;
  reshaped below).
- `tests/fixtures/rustSnapshot.ts` — `createRustSnapshot()` default `scenario`
  (name + objectives, no waves).
- Read-only wave consumers: `runtimeSelectors.ts:268` (Brief panel shows the first
  unapplied wave's `message`) and `overlayRenderer.ts:372` (growth overlay
  telegraphs upcoming wave tiles from `wave.tiles`).

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
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum GrowthAction {
    PaintAreaRectangle { area: String, start: Point, end: Point },
    PlaceBuilding { building_type: String, origin: Point, rotation: u16 },
}
```

Serializes as a `type`-tagged union (`{ "type": "paintAreaRectangle", "area", "start",
"end" }` / `{ "type": "placeBuilding", "buildingType", "origin", "rotation" }`),
matching the `GameIntent` wire format.

**Decision A — waves live in `ScenarioConfig`.** Add
`growth_waves: Vec<GrowthWave>` to `ScenarioConfig`, annotated `#[serde(default)]`
(so older payloads deserialize) and **always serialized** (no `skip_serializing_if`)
so the TS side always receives `growthWaves` — `[]` for the shipped scenario. This
maps 1:1 to the TS `Scenario.growthWaves` wire shape, so `normalizeRustSnapshot`
becomes a pure pass-through.

- *Rejected alternative:* a separate top-level `GameSnapshot.growth_waves` field
  (ticket phrasing) with TS reassembling `scenario.growthWaves` — extra glue, no
  wire parity.
- Update the `scenario`-field doc comment to note `growth_waves[].applied` mutates
  over the run.

### 2. Grid-derived seed helper (implemented, unit-tested, NOT wired)

In `scenario.rs`, add a pure `pub fn growing_suburb_growth_waves() -> Vec<GrowthWave>`
that computes a single seed wave from the map dimensions. `growing_suburb_scenario()`
continues to ship `growth_waves: vec![]` and carries a doc comment explaining the
helper is validated but intentionally unwired (see Scope).

- **Unit count from grid:**
  `n_units = max(1, (MAP_WIDTH as i32 * MAP_HEIGHT as i32) / GRID_CELLS_PER_HOUSING_UNIT)`,
  `GRID_CELLS_PER_HOUSING_UNIT = 100` (tunable). For 28×18: `504 / 100 = 5` units →
  `5 × 4 = 20` seed citizens.
- **Seed unit:** `smallHouse` (2×1 footprint, 4 citizens).
- **Deterministic packing:** row-major from `SEED_ANCHOR = (2, 3)`,
  `SEED_UNITS_PER_ROW = 6`; unit *k* origin = `(2 + (k % 6) * 2, 3 + (k / 6))`. Keeps
  every footprint on bare ground west of the `x = 14` arterial and clear of the
  `y ∈ {8, 9}` arterial and map bounds. For 28×18: one row of 5 houses, `x ∈ [2, 11]`,
  `y = 3`.
- **Actions (order matters — zone precedes build):**
  1. `PaintAreaRectangle { area: "residential", start: (2, 3), end: (max_x, max_y) }`
     over the units' bounding rectangle, then
  2. one `PlaceBuilding { building_type: "smallHouse", origin, rotation: 0 }` per unit.
- **Wave:** `GrowthWave { id: "wave-seed-residential", trigger_time: 0.0,
  message: "First residents arrive — build destinations so they can commute.",
  applied: false, actions }`.

The helper is public and validated by unit tests; wiring it into the shipped
scenario is the deliberate follow-up.

### 3. `tick_growth` step & timing

New module `crates/caelum-core/src/growth.rs` exposing
`pub fn apply_due_growth_waves(state: &mut GameSnapshot)`.

Wire it into `trips::tick_trips_substepped`:

- Call `apply_due_growth_waves(&mut next)` as the **first statement of each substep
  iteration** (before `reset_daily_commute_flags` / `spawn_due_commute_trips`) and
  again in the **final flush block**, so a wave firing at time `T` seeds sims whose
  commute departures are picked up the same tick.
- Early-return when no wave is unapplied-and-due (a no-op for the shipped empty
  scenario, so untouched existing tests keep passing).

**Decision B — trigger times are substep boundaries.** In `next_boundary_after`,
for each unapplied wave call `track_next_boundary(&mut next, wave.trigger_time,
after)`. Extend `max_tick_substeps` by `state.scenario.growth_waves.len()`. Preserves
the **granularity-independence / determinism contract**: no substep straddles a
trigger.

- *Rejected alternative:* apply once at tick start (coarse) — a large resume-tick
  could overshoot a trigger and desync timing/IDs.

### 4. Applying a wave (reuse the engine's own handlers)

`apply_due_growth_waves` selects due waves (`!applied && trigger_time <= state.time`)
and applies them **in declared order** (waves, then actions within a wave), threading
the snapshot through the existing handlers:

- `PaintAreaRectangle` → `areas::paint_area_rectangle(&state, area, start, end)`;
  adopt the returned snapshot when `Some`, else keep current (no-op paint = skip).
- `PlaceBuilding` → `buildings::place_building_core(&state, building_type, origin,
  rotation)`; adopt when `Ok`, else keep current (invalid placement = skip, as a
  player's invalid click is a no-op).

Then set `applied = true` on the snapshot's `scenario.growth_waves`. Because these
are the player's own handlers, zoning gates, occupancy validation, housing sim
spawning with deterministic IDs (`next_entity_id`), and `assign_workplaces` +
`retarget_home_fallback_trips` all follow automatically.

**Budget exemption (a wave is the world growing, not the player spending).** Factor
`buildings::place_building` into:

- `place_building_core(state, type, origin, rotation) -> Result<GameSnapshot, String>`
  — everything except the budget check and `next.budget -= cost`.
- `place_building(state, ...)` — budget check → `place_building_core` → deduct `cost`
  (public behavior unchanged; the `PlaceBuilding` intent path is byte-for-byte
  identical).

Waves call `place_building_core`, so world growth neither charges nor gates on the
player's budget. `paint_area_rectangle` has no budget dimension and is reused
directly.

Determinism: action order is fixed; grid-derived authoring is a pure function of map
constants; all ID allocation is `next_entity_id`; no wall-clock or RNG.

### 5. TS shim removal, consumers & host symmetry

- `src/runtime/backend/types.ts`: add `growthWaves: GrowthWave[]` to
  `RustScenarioConfig` (import the reshaped `GrowthWave`/`GrowthAction` from
  `domain/types`); update the doc comment.
- `src/domain/types.ts`: reshape `GrowthWave` to `{ id, triggerTime, message,
  applied, actions: GrowthAction[] }` and add the `GrowthAction` union
  (`{ type: "paintAreaRectangle"; area; start; end }` |
  `{ type: "placeBuilding"; buildingType; origin; rotation }`). Remove the unused
  `GrowthWaveTile`.
- `src/runtime/snapshotView.ts`: replace `growthWaves: []` with
  `growthWaves: snapshot.scenario.growthWaves` (pass-through); drop the HPA-118 TODO.
- `src/render/overlayRenderer.ts`: the growth overlay derives telegraph tiles from
  each unapplied wave's `paintAreaRectangle` actions (expand each rectangle to its
  tiles) instead of reading `wave.tiles`.
- `src/runtime/runtimeSelectors.ts`: unchanged (Brief still reads `message`).
- `tests/fixtures/rustSnapshot.ts`: add `growthWaves: []` to the default scenario.
- `src/scenario/growingSuburb.ts`: update the stale HPA-118 TODO comment.
- Browser (WASM) and Tauri both serialize `scenario.growthWaves` from the same core
  snapshot → symmetric by construction.

### 6. Testing

**Rust — model wire format** (`tests/model_wire_format.rs`): a `GrowthAction`
serializes to the tagged camelCase shape (`type: "placeBuilding"`, `buildingType`,
…); the shipped `scenario.growthWaves` serializes to `[]`.

**Rust — scenario authoring** (`scenario.rs` unit tests): `growing_suburb_growth_waves()`
returns one wave whose first action is the residential `PaintAreaRectangle` and whose
remaining `n_units` actions are `smallHouse` placements; `n_units == grid_count / 100`
(5 for 28×18); every placement footprint is on-map, off the arterial cross, and inside
the zoned rectangle; and `growing_suburb_scenario().growth_waves` is empty (unwired).

**Rust — wave application** (`growth.rs` unit tests + synthetic/seed waves):

- **Application:** a snapshot seeded with `growing_suburb_growth_waves()`, unpaused
  and ticked past `trigger_time`, zones the block, places `n_units` houses, and spawns
  `n_units × 4` sims with deterministic IDs; `applied == true`; **budget unchanged**.
- **Zone→build coupling:** a synthetic `placeBuilding(housing)` whose tile the wave
  did not zone is skipped (`"area mismatch"`); paint-before-build makes it succeed.
- **Idempotency:** a second tick does not re-apply (no duplicate houses/sims).
- **Granularity determinism:** one coarse tick vs many fine ticks across the trigger
  produce identical `map` areas, `buildings`, and `sims`.
- **Empty is a no-op:** ticking the shipped Growing Suburb scenario spawns no
  wave houses/sims (guards the untouched suite).

**TypeScript** (`tests/runtime/backendContract.test.ts`): keep the `toEqual([])`
assertions (now satisfied by Rust pass-through, not a hardcoded shim), and add a case
where `createRustSnapshot` carries a non-empty `scenario.growthWaves` (one
`paintAreaRectangle` + one `placeBuilding` action) and `normalizeRustSnapshot` passes
it through unchanged. Update `tests/render/overlayRenderer.test.ts` to build waves in
the `actions` shape and assert the telegraph derives tiles from `paintAreaRectangle`
actions.

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

> Departures from the ticket's proposed approach, both to fit the current codebase:
> (1) a wave is modelled as scheduled `PaintAreaRectangle`/`PlaceBuilding` intents
> applied through the existing engine handlers, because zoning gates placement and
> buildings are the sole sim source; (2) the seed wave's magnitude is grid-derived at
> authoring time. Scope note: the mechanism + grid-scaled helper are implemented and
> unit-tested, but the seed is **not wired** into the shipped scenario — that keeps
> the deterministic core suite and golden traces untouched, and is a deliberate
> follow-up.

## Files touched

- `crates/caelum-core/src/model.rs` — `GrowthWave`, `GrowthAction`,
  `ScenarioConfig.growth_waves`; doc comment update.
- `crates/caelum-core/src/scenario.rs` — `growing_suburb_growth_waves()` +
  `GRID_CELLS_PER_HOUSING_UNIT` / packing constants; `growing_suburb_scenario()`
  ships `growth_waves: vec![]` with an explanatory comment.
- `crates/caelum-core/src/growth.rs` — **new**: `apply_due_growth_waves`.
- `crates/caelum-core/src/buildings.rs` — extract `place_building_core`
  (budget-exempt); `place_building` wraps it.
- `crates/caelum-core/src/lib.rs` — register `growth` module.
- `crates/caelum-core/src/trips.rs` — call `apply_due_growth_waves`; add trigger
  times to `next_boundary_after`; extend `max_tick_substeps`.
- `src/runtime/backend/types.ts` — add `growthWaves` to `RustScenarioConfig`.
- `src/domain/types.ts` — reshape `GrowthWave`, add `GrowthAction`, remove
  `GrowthWaveTile`.
- `src/runtime/snapshotView.ts` — pass-through waves.
- `src/render/overlayRenderer.ts` — telegraph derives tiles from wave actions.
- `src/scenario/growingSuburb.ts` — update stale TODO.
- Tests: `crates/caelum-core/tests/model_wire_format.rs`, `scenario.rs` +
  `growth.rs` unit tests, `tests/runtime/backendContract.test.ts`,
  `tests/render/overlayRenderer.test.ts`, `tests/fixtures/rustSnapshot.ts`.

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

**Model:** a growth wave is a batch of **scheduled scenario intents** — the same
gameplay mutations the player already performs (`PaintAreaRectangle`,
`PlaceBuilding`) — applied at a trigger time through the **existing** engine
handlers. Sims and workplaces then arise through the normal
zone → build → spawn coupling. There is no parallel spawn path and no
"bodiless citizen" concept; when a wave fires, the world visibly grows (zones are
painted, buildings appear, and their housing spawns sims exactly as a player's
placement would).

**Scope is infrastructure only.** Growing Suburb ships today as a deliberate empty
sandbox (`676ed1b` "start from empty zonable map", `3861657` "remove TS-side
growth wave synthesis") — no timed waves, no starting citizens. We keep that: the
wave mechanic is built, tested, and emitted by the core, but the Growing Suburb
wave list stays **empty**. Result: **zero runtime behavior change** for Growing
Suburb, the TS shim is removed, browser (WASM) and Tauri hosts become symmetric by
construction, and the mechanic is ready + unit-tested for future scenarios.

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

The ticket's own framing ("the Rust core does not yet model citizen spawning or
zoning") is stale: the core already models both, player-driven. The genuinely
missing piece is **scenario-authored, timed, automatic** application of those
same mutations.

## Non-goals

- No new scenarios beyond Growing Suburb.
- No change to objective thresholds or win/loss logic.
- No non-empty Growing Suburb wave schedule (sandbox stays empty by decision).
- No new gameplay mutation types — waves may only issue mutations the player can
  already perform.

## Current architecture (relevant pieces)

- `crates/caelum-core/src/state.rs` — `create_initial_snapshot()`: empty `sims`,
  empty map areas, `scenario = growing_suburb_scenario()`.
- `crates/caelum-core/src/scenario.rs` — `growing_suburb_scenario()` returns
  `ScenarioConfig { name, objectives }` (no waves).
- `crates/caelum-core/src/model.rs` — `ScenarioConfig`, `GameSnapshot`, `Sim`,
  `Point`.
- `crates/caelum-core/src/areas.rs` — `paint_area_rectangle(state, area, start,
  end) -> Option<GameSnapshot>` (clips to map, zones bare tiles).
- `crates/caelum-core/src/buildings.rs` — `place_building(...) -> Result<
  GameSnapshot, String>`: budget check + deduct, `can_place_building` (enforces
  `allowed_area`, occupancy, track rules), transit-node creation, housing spawns
  `Sim`s (worker profile / shift from `commute::*_for_id`), then
  `assign_workplaces` + `trips::retarget_home_fallback_trips`.
- `crates/caelum-core/src/building_catalog.rs` — `allowed_area`, `effect`,
  `citizen_count`, `cost` per building.
- `crates/caelum-core/src/trips.rs` — `tick_trips_substepped()` breaks each tick
  at meaningful boundaries (`next_boundary_after`, bounded by `max_tick_substeps`)
  and runs `spawn_due_commute_trips()` at each boundary.
- `crates/caelum-core/src/engine.rs` — `GameEngine::tick` calls
  `trips::tick_trips_with_objectives`; `dispatch` routes `GameIntent`s to
  `areas` / `buildings` / `transit`.
- `src/runtime/snapshotView.ts` — `normalizeRustSnapshot()` currently hardcodes
  `scenario.growthWaves = []`.
- `src/domain/types.ts` — `Scenario`, `GrowthWave`, `GrowthWaveTile` (wire types;
  reshaped below).
- Read-only wave consumers: `runtimeSelectors.ts:268` (Brief panel shows the first
  unapplied wave's `message`) and `overlayRenderer.ts:372` (growth overlay
  telegraphs upcoming wave tiles). Both stay dormant while the core emits `[]`.

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
- `growing_suburb_scenario()` seeds `growth_waves: vec![]`.
- Update the `scenario`-field doc comment (currently "Static scenario identity +
  objective thresholds") to note `growth_waves[].applied` mutates over the run.

### 2. `tick_growth` step & timing

New module `crates/caelum-core/src/growth.rs` exposing
`apply_due_growth_waves(&mut GameSnapshot)`.

Wire it into `trips::tick_trips_substepped`:

- Call `apply_due_growth_waves(&mut next)` at the **top of each substep
  iteration**, before `reset_daily_commute_flags` / `spawn_due_commute_trips`, and
  again in the **final flush block**. This lets a wave that fires at time `T` seed
  sims whose commute departures are then picked up by `spawn_due_commute_trips` in
  the same tick.
- Early-return guard when no wave is unapplied-and-due (the shipped Growing Suburb
  path is a cheap no-op).

**Decision B — trigger times are substep boundaries.** Add each unapplied wave's
`trigger_time` (when `> state.time` and `<= final_time`) to the boundary set in
`next_boundary_after`, and extend `max_tick_substeps` by
`state.scenario.growth_waves.len()`. This preserves the **granularity-independence
/ determinism contract**: one coarse tick and many fine ticks produce identical
results because no substep straddles a trigger.

- *Rejected alternative:* apply once at tick start (coarse), like the old TS
  `applyDueGrowthWaves` — a large resume-tick could overshoot a trigger and desync
  timing/IDs relative to a stepped run.

### 3. Applying a wave (reuse the engine's own handlers)

`apply_due_growth_waves` selects due waves (`!applied && trigger_time <=
state.time`) and applies them **in declared order** (waves, then actions within a
wave). Each action is threaded through the existing handler:

- `PaintAreaRectangle` → `areas::paint_area_rectangle(&state, area, start, end)`;
  take the returned snapshot when `Some`, else keep the current one (a no-op paint
  is a deterministic skip, exactly as a player's redundant paint).
- `PlaceBuilding` → `buildings::place_building_core(&state, building_type, origin,
  rotation)`; take the returned snapshot when `Ok`, else keep the current one (an
  invalid placement — wrong zone, occupied, off-map — is a deterministic skip, as
  a player's invalid click is a no-op).

Because these are the player's own handlers, everything follows automatically:
zoning gates, footprint/occupancy validation, transit-node creation, housing sim
spawning with deterministic IDs (`next_entity_id`), and `assign_workplaces` +
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

Determinism: action order is fixed; all ID allocation is `next_entity_id` over
existing IDs; no wall-clock or RNG. Identical wave definitions + tick counts
produce identical snapshots.

### 4. TS shim removal, consumers & host symmetry

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
  `message` + `applied`).
- `src/scenario/growingSuburb.ts`: update the stale HPA-118 TODO comment (the file
  already holds only `MAP_WIDTH`/`MAP_HEIGHT`).
- Browser (WASM) and Tauri both serialize `scenario.growthWaves` from the same
  `caelum-core` snapshot → symmetric by construction.

### 5. Testing

**Rust** (unit tests in `growth.rs` / crate tests) using synthetic waves:

- **Application:** a wave with `[paintAreaRectangle(residential, …),
  placeBuilding(housing, …)]`, ticked past `trigger_time`, yields the zoned tiles,
  the placed housing building, and its `citizen_count` sims with the expected
  deterministic IDs; `applied == true`; **budget unchanged** (exemption).
- **Zone→build coupling:** a `placeBuilding(housing)` whose tile the wave did not
  zone is a deterministic skip (`"area mismatch"`); ordering paint-before-build in
  the same wave makes it succeed.
- **Idempotency:** a second tick does not re-apply (the `applied` guard holds — no
  duplicate buildings/sims).
- **Granularity determinism:** one coarse tick vs many fine ticks across the
  trigger produce identical `map` (areas), `buildings`, and `sims`.
- **Commute hand-off (light integration):** a wave that zones+builds both housing
  and a destination produces sims that receive workplaces via `assign_workplaces`
  and go on to commute deterministically.
- **Empty list:** the Growing Suburb scenario ticks with no waves applied and no
  buildings/sims spawned (no-op).

**TypeScript** (`tests/runtime/backendContract.test.ts`):

- Keep `expect(snapshot.scenario.growthWaves).toEqual([])` for the real
  (now Rust-sourced) Growing Suburb snapshot.
- Add a case proving `normalizeRustSnapshot` **passes through** a non-empty
  `scenario.growthWaves` from the Rust snapshot (no longer a hardcoded `[]`).
- Update `tests/render/overlayRenderer.test.ts` to build waves in the new
  `actions` shape and assert the telegraph derives tiles from `paintAreaRectangle`
  actions.

## Acceptance criteria (from HPA-118)

- [x] `crates/caelum-core` owns wave scheduling, zoning, and citizen spawning; the
      tick pipeline applies them deterministically. *(§2, §3)*
- [x] `src/runtime/snapshotView.ts` no longer injects growth waves — it reads them
      from the Rust snapshot. *(§4)*
- [x] `src/scenario/growingSuburb.ts` no longer defines wave gameplay. *(§4)*
- [x] Browser and Tauri hosts produce identical wave/citizen sequences for the same
      tick count. *(§4 — single core source)*
- [x] Determinism preserved: identical inputs → identical spawn IDs/counts/timing.
      *(§2 Decision B, §3 fixed order + `next_entity_id`, §5 granularity test)*
- [x] New Rust + TS tests cover wave timing, application idempotency (`applied`),
      and the determinism contract. *(§5)*

> Note on the "identical sequences" criterion: for the shipped Growing Suburb
> scenario the sequence is the empty sequence (no waves). The mechanic that would
> produce a non-empty sequence is fully implemented and unit-tested; wiring a live
> Growing Suburb wave schedule is intentionally out of scope per the agreed
> "infra only, keep sandbox empty" decision.
>
> Departure from the ticket's proposed approach: a wave is modelled as scheduled
> `PaintAreaRectangle`/`PlaceBuilding` intents applied through the existing engine
> handlers, rather than a bespoke zone-tiles-and-spawn-bodiless-citizens step. This
> was chosen to fit the current codebase, where zoning gates placement and
> buildings are the sole sim source.

## Files touched

- `crates/caelum-core/src/model.rs` — `GrowthWave`, `GrowthAction`,
  `ScenarioConfig.growth_waves`; doc comment update.
- `crates/caelum-core/src/scenario.rs` — seed `growth_waves: vec![]`.
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
- Tests: `crates/caelum-core` growth tests, `tests/runtime/backendContract.test.ts`,
  `tests/render/overlayRenderer.test.ts`.

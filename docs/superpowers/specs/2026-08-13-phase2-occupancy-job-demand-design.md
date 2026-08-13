# Phase 2 Occupancy and Job Demand Design

**Linear:** HPA-332

## Goal

Deliver one Phase 2 vertical slice in the real sandbox UI:

> Build a Small House and Supermarket → Resume → the house fills deterministically → workers occupy finite supermarket jobs → the existing commute engine produces trips → Select shows building occupancy.

Keep the slice player-controlled and intentionally small. Do not create a general city-simulation layer.

## Current seams that matter

- `building_catalog.rs` has `citizen_count`; `buildings.rs` uses it to create all residents immediately.
- `destination_points()` still defines workplaces from catalog `effect == "destination"`; `assign_workplaces`, commute validity, and demolition therefore do not yet share a capacity-based workplace definition.
- `Sim.home` and `Sim.workplace` are already the point-based inputs consumed by `trips.rs`.
- `trips.rs` has six current-time/substep sites that call `apply_due_growth_waves`; `track_next_boundary` intentionally rejects candidates `<= state.time`, so already-due move-ins must run in every current-time pass.
- `growth.rs` reuses `place_building_core`, so campaign growth currently shares player placement behavior.
- housing demolition currently leaves sims behind; the home-fallback/retarget machinery exists to keep those orphaned sims from producing zero-distance commutes.
- the current Select inspector already stores a clicked tile but only renders transit nodes.

Reuse these seams. Remove obsolete special cases when the new lifecycle makes them unreachable.

## Alternatives

### Keep point-based sims and add placed-building capacity data — chosen

Keep `Sim.home: Point` and `Sim.workplace: Option<Point>`. Building footprints already answer resident/job ownership, and the commute router already consumes points directly.

### Add home/workplace building IDs — defer

Explicit relationship IDs would fan out through routing, demolition, persistence validation, fixtures, and UI without a second current consumer.

### General population/job framework — reject

No capacity registry, household model, scheduler service, ECS, rules engine, event bus, or job entity is needed. The existing tick pipeline already owns deterministic event boundaries.

## Schema v5 and placement authority

Bump the disposable development snapshot schema from 4 to 5 and add to `PlacedBuilding`:

```rust
pub placed_at: f64,
pub resident_capacity: u16,
pub job_capacity: u16,
```

Replace `BuildingDefinition.citizen_count` with `resident_capacity` and `job_capacity`.

| Building | Player residents | Player jobs |
| --- | ---: | ---: |
| Small House | 4 | 0 |
| Supermarket | 0 | 4 |
| all other current buildings | 0 | 0 |

The Rust catalog remains gameplay authority. The placed instance stores the actual capacities used by simulation and UI.

Do not add a `playerBuilt` flag and do not mint a world-specific placement API. Change the existing internal placement seam to accept the capacities that should be stored:

```rust
pub fn place_building_core(
    state: &GameSnapshot,
    building_type: &str,
    origin: &Point,
    rotation: u16,
    resident_capacity: u16,
    job_capacity: u16,
) -> GameplayResult<GameSnapshot>
```

- player/costed placement passes the two catalog capacities;
- `growth.rs` calls the same function with `0, 0`;
- the construction site always writes `placed_at = state.time` and the two supplied capacities.

Task 1 must update this construction site and every current `PlacedBuilding { ... }` fixture literal at the same time as the model fields. There must not be an intermediate commit where the crate or TypeScript fixtures cannot compile.

Remove the dormant single-value `moveInRate: "paused"` contract in the same schema break. Remove `citizenCount` rather than retaining aliases. Old development saves may be cleared; no migration or dual reader.

## One workplace definition

Stop using catalog `effect == "destination"` as commute authority.

Rename `destination_points` to a workplace helper whose membership rule is exactly:

> a placed building is a workplace only when `job_capacity > 0`.

The helper returns the footprints of those placed buildings. Use that same placed-instance authority for:

- `assign_workplaces`;
- `trips.rs::has_valid_workplace_destination`;
- the removed-workplace tile set used by demolition cleanup.

Catalog `effect` may continue to describe non-commute building behavior, but no commute/workplace path should consult it. This guarantees that world-growth buildings recorded with `job_capacity == 0`, and every other zero-capacity building in this slice, cannot silently act as unlimited jobs.

## Deterministic move-in

Create `crates/caelum-core/src/population.rs` with:

```rust
pub const MOVE_IN_INTERVAL_SECONDS: f64 = GAME_DAY_SECONDS / 24.0;
```

That is 50 simulation seconds per in-game hour today.

For a player Small House with occupancy `n`, the next slot is due at:

```text
placed_at + n * MOVE_IN_INTERVAL_SECONDS
```

A paused new Small House remains `0 / 4`. The first running tick must process the slot due at `placed_at`; later residents arrive one in-game hour apart. Progress is derived from sims whose `home` lies inside the footprint, so no timer/counter state is persisted.

`apply_due_move_ins` must use the same due rule as growth:

```text
due_time <= state.time
```

Using `<` would miss the first resident at `placed_at`. Future-boundary tracking is only for timestamps greater than the current time because `track_next_boundary` deliberately drops already-due candidates.

New residents use stable building-ID order plus the existing deterministic sim ID, worker-profile, shift-template, and home-tile rules.

## Reuse every tick current-time pass

Do not add a scheduler service. Add a tiny helper in `trips.rs`:

```rust
fn apply_due_world_events(state: &mut GameSnapshot) {
    crate::growth::apply_due_growth_waves(state);
    crate::population::apply_due_move_ins(state);
}
```

Replace **all six** existing `apply_due_growth_waves(&mut next)` calls inside `tick_trips_substepped` with this helper:

1. initial current-time preprocessing;
2. normal-loop preprocessing;
3. normal-loop post-substep processing;
4. fallback-loop preprocessing;
5. fallback-loop post-substep processing;
6. final current-time pass.

Also add the next future move-in boundary to `next_boundary_after`, add remaining resident slots to `max_tick_substeps`, and keep the existing sim-count cap widening so newly moved-in workers contribute commute boundaries.

This is what makes one coarse tick equivalent to fine ticks.

## Finite workplace assignment

Keep `buildings.rs::assign_workplaces` as the assignment seam.

- only placed buildings with `job_capacity > 0` are candidates;
- process workplace buildings in stable ID order;
- preserve an existing assignment only while its workplace still exists and has remaining capacity;
- clear over-capacity/stale assignments deterministically, then fill open slots in stable sim order;
- map slot `n` to `occupied_tiles[n % occupied_tiles.len()]` so `Sim.workplace` remains directly routable;
- excess workers remain unassigned.

No job records, job categories, wages, preferences, or labor-market abstraction.

## Demolition retires home-fallback state

Occupied Small House demolition now removes residents whose `home` is in its footprint and removes their active trips plus matching vehicle passenger trip IDs. Once that is true, the old supported path that produced `workplace == home` disappears: the resident no longer survives the demolition that freed the home tile for a destination.

Delete the home-fallback contract in the same implementation story:

- remove the `workplace == home` special case from `assign_workplaces`;
- remove `is_home_fallback_trip` and `retarget_home_fallback_trips` if no supported caller remains;
- remove their calls/comments from building placement and destination/workplace demolition;
- replace/delete the regression tests that only pin orphaned-resident behavior.

Do not keep dormant fallback machinery for schema-v4 saves; schema v5 is a breaking development format.

For Supermarket removal, keep the **one existing reassignment inside the current cleanup function** after affected workplaces are cleared. Update that cleanup to use the job-capacity workplace authority. Do not add a second `assign_workplaces` call around it.

## UI

Make `ShellInspectorState` a small discriminated union with existing transit fields under `kind: "transit"` and this building branch:

```ts
{
  kind: "building";
  buildingId: string;
  buildingLabel: string;
  metricLabel: "Residents" | "Jobs";
  occupancy: number;
  capacity: number;
}
```

Transit inspection keeps priority. Otherwise find the selected placed building and return a building inspector only for nonzero resident/job capacity.

Derive display occupancy from the authoritative snapshot:

- Residents: sims whose `home` is in the building footprint.
- Jobs: sims whose `workplace` is in the building footprint.

No backend query, snapshot occupancy field, presenter layer, modal, citywide control, or occupancy overlay.

## Verification ownership

Rust coverage must prove:

1. Task 1 compiles after adding required placed-building fields and removing `citizen_count`/`moveInRate`.
2. player Small House placement while paused creates zero sims after the move-in task.
3. the first running tick creates one resident because `placed_at <= state.time` is processed in the initial pass.
4. hourly boundaries fill to four and stop; coarse/fine ticks match.
5. one player Supermarket accepts four workers and no more.
6. `sim-001` reaches the existing outbound commute spawn path at its deterministic departure time.
7. growth-wave Small Houses/Supermarkets are recorded with zero capacities and do not create population/jobs.
8. workplace demolition reassigns at most once through the existing cleanup.
9. housing demolition leaves no sim/trip/passenger reference and the home-fallback code is gone.

Update all current `PlacedBuilding` fixture literals for schema v5, including Rust commute/transit fixtures and `tests/helpers/gameState.ts` / `tests/fixtures/rustSnapshot.ts`.

Update `golden_sequences.rs` explicitly: the no-tick placement count changes from four sims to zero; the existing 900-second commute golden must still prove that four residents have moved in and received jobs before the first standard departure.

Splice the UI assertions into the existing `tests/e2e/smoke.spec.ts` after the house placement. Replace its current immediate population `4` assertion with paused `0`, inspect `Residents 0 / 4` and `Jobs 0 / 4`, then Resume and observe the first move-in. Keep the existing road, bus-terminal, and clock tail; do not replace the smoke with an occupancy-only journey.

## Non-goals

Additional building capacities, configurable/random move-in, households, building relationship IDs, job entities/categories, shopping/school/leisure/visitor trips, citywide growth controls, new overlays, cars/congestion, service/headway planning, campaign redesign, save migration, compatibility layers, and pre-release hardening are outside this slice.

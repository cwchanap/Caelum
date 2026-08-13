# Phase 2 Occupancy and Job Demand Design

**Linear:** HPA-332

## Goal

Deliver one Phase 2 vertical slice in the real sandbox UI:

> Build housing and workplaces → Resume → housing fills deterministically → workers occupy finite jobs → the existing commute engine produces trips → Select shows occupancy.

Keep the slice player-controlled and small. Preserve the current usefulness of every existing housing/destination building while replacing unlimited destinations with finite jobs.

## Current seams that matter

- `building_catalog.rs` has `citizen_count`; `buildings.rs` creates those residents immediately.
- `destination_points()` defines workplaces from catalog `effect == "destination"`; assignment, commute validity, and demolition therefore use a content tag rather than finite capacity.
- `Sim.home` and `Sim.workplace` are already the point-based inputs consumed by `trips.rs`.
- `trips.rs` has six current-time/substep sites that call `apply_due_growth_waves`; `track_next_boundary` rejects candidates `<= state.time`, so already-due move-ins must run in every current-time pass.
- `growth.rs` is campaign-only and the shipped sandbox constructs no campaign/growth path. Keep it untouched; do not add persisted source state merely to distinguish an unreachable player path.
- housing demolition currently leaves sims behind; the home-fallback/retarget machinery exists to keep those orphaned sims from producing zero-distance commutes.
- the current Select inspector already stores a clicked tile but only renders transit nodes.

Reuse these seams. Remove obsolete special cases when the new lifecycle makes them unreachable.

## Alternatives

### Keep point-based sims and type-owned capacity — chosen

Keep `Sim.home: Point` and `Sim.workplace: Option<Point>`. Building footprints already answer resident/job ownership, and the commute router already consumes points directly. Capacity is stable per building type, so it belongs in the existing building catalog rather than every placed instance.

### Persist capacity on `PlacedBuilding` — reject for now

Per-instance resident/job fields would duplicate the catalog and expand every Rust/TypeScript fixture. Their only proposed use was distinguishing player placement from dormant campaign growth. The released workflow creates Sandbox snapshots only, while current campaign/growth constructors are not wired into the player path. Do not pay a permanent schema cost for that unreachable distinction.

### Add home/workplace building IDs — defer

Explicit relationship IDs would fan out through routing, demolition, persistence validation, fixtures, and UI without a second current consumer.

### General population/job framework — reject

No capacity registry, household model, scheduler service, ECS, rules engine, event bus, or job entity is needed. The existing tick pipeline already owns deterministic event boundaries.

## Schema v5: placement time only

Bump the disposable development snapshot schema from 4 to 5 and add only:

```rust
pub placed_at: f64,
```

to `PlacedBuilding`.

`placed_at` is genuinely instance-specific and cannot be derived after save/load. Resident/job capacity is type metadata and remains outside the snapshot.

Replace `BuildingDefinition.citizen_count` with:

```rust
pub resident_capacity: u16,
pub job_capacity: u16,
```

Keep the TypeScript `BUILDING_CATALOG` as the existing UI metadata mirror: replace `citizenCount` with `residentCapacity` / `jobCapacity` so the Select inspector can display capacity without a backend query or persisted capacity field. Rust remains gameplay authority; TypeScript consumes the mirrored metadata for presentation only.

Remove the dormant single-value `moveInRate: "paused"` contract in the same schema break. Old development saves may be cleared; no migration or dual reader.

## Preserve current building content

Do not make existing buildings inert merely to keep the first vertical slice small.

Residential capacity preserves today's authored resident counts:

| Building | Resident capacity | Job capacity |
| --- | ---: | ---: |
| Small House | 4 | 0 |
| Large House | 10 | 0 |

Every current `effect == "destination"` building remains a workplace. Give it one job per footprint tile, matching the existing destination-footprint concept while making capacity finite:

| Building | Footprint | Job capacity |
| --- | ---: | ---: |
| Supermarket | 2×2 | 4 |
| Cinema | 3×2 | 6 |
| Factory | 3×2 | 6 |
| Warehouse | 3×2 | 6 |
| Office Tower | 2×2 | 4 |
| Business Park | 3×2 | 6 |
| Clinic | 2×2 | 4 |
| School | 3×2 | 6 |
| Park Plaza | 2×2 | 4 |

Transit buildings remain `0 / 0`.

This is content preservation, not a new simulation subsystem: the finite-assignment code is generic already, and the only extra work is the catalog data table.

## One workplace definition

Stop using catalog `effect == "destination"` as commute authority.

A placed building is a workplace when its `building_definition(building_type).job_capacity > 0`.

A focused helper returns those workplace footprints. Use that same authority for:

- `assign_workplaces`;
- `trips.rs::has_valid_workplace_destination`;
- removed-workplace tile collection in demolition cleanup.

Catalog `effect` may continue to describe non-commute building behavior, but no commute/workplace path should consult it after this change.

## Deterministic move-in

Create `crates/caelum-core/src/population.rs` with:

```rust
pub const MOVE_IN_INTERVAL_SECONDS: f64 = GAME_DAY_SECONDS / 24.0;
```

That is 50 simulation seconds per in-game hour today.

For a housing building with current occupancy `n`, the next slot is due at:

```text
placed_at + n * MOVE_IN_INTERVAL_SECONDS
```

Capacity comes from `building_definition(&building.building_type).resident_capacity`.

A paused newly placed house remains empty. The first running tick processes the slot due at `placed_at`; later residents arrive one in-game hour apart. Progress is derived from sims whose `home` lies inside the footprint, so no timer/counter state is persisted.

`apply_due_move_ins` uses:

```text
due_time <= state.time
```

Using `<` would miss the first resident at `placed_at`. Future-boundary tracking is only for timestamps greater than current time because `track_next_boundary` deliberately drops already-due candidates.

The shipped/player workflow is Sandbox. Keep dormant campaign growth out of this slice with a cheap mode guard in the population helpers: campaign snapshots do not schedule or apply move-ins. Do not modify `growth.rs` or add placement-source state.

New residents use stable building-ID order plus the existing deterministic sim ID, worker-profile, shift-template, and home-tile rules.

### Residents moving in after today's commute window

Do not create a retroactive morning commute when a worker moves in after their deterministic outbound departure.

When constructing a new worker:

- set `commute_day = state.day`;
- if `state.clock_minutes` is already past that worker's outbound departure minute, initialize `outbound_resolved_today = true` and `outbound_arrived_today = false`;
- otherwise leave today's outbound flags unresolved;
- leave return flags unresolved.

The worker then begins the normal commute cycle on the next day reset. Add a focused mid-day move-in test so this rule cannot drift.

## Reuse every tick current-time pass

Do not add a scheduler service. Add a tiny helper in `trips.rs`:

```rust
fn apply_due_world_events(state: &mut GameSnapshot) {
    crate::growth::apply_due_growth_waves(state);
    crate::population::apply_due_move_ins(state);
}
```

Replace all six existing `apply_due_growth_waves(&mut next)` calls inside `tick_trips_substepped` with this helper:

1. initial current-time preprocessing;
2. normal-loop preprocessing;
3. normal-loop post-substep processing;
4. fallback-loop preprocessing;
5. fallback-loop post-substep processing;
6. final current-time pass.

Also add the next future move-in boundary to `next_boundary_after`, add remaining resident slots to `max_tick_substeps`, and keep existing sim-count cap widening so newly moved-in workers contribute commute boundaries.

This is what makes one coarse tick equivalent to fine ticks.

## Finite workplace assignment

Keep `buildings.rs::assign_workplaces` as the assignment seam.

- resolve workplace capacity from each placed building's catalog definition;
- process workplace buildings in stable ID order;
- preserve an existing assignment only while its workplace still exists and has remaining capacity;
- clear over-capacity/stale assignments deterministically, then fill open slots in stable sim order;
- map slot `n` to `occupied_tiles[n % occupied_tiles.len()]` so `Sim.workplace` remains directly routable;
- excess workers remain unassigned.

No job records, job categories, wages, preferences, or labor-market abstraction.

## Demolition retires home-fallback state

Occupied housing demolition removes residents whose `home` is in its footprint and removes their active trips plus matching vehicle passenger trip IDs.

After resident removal, call `assign_workplaces(state)` exactly once so jobs freed by deleted workers are immediately offered to surviving unemployed workers. This is necessary for a two-house/one-workplace case; otherwise a fully staffed workplace can become empty even though surviving workers remain.

Once housing demolition removes its residents, the old supported path that produced `workplace == home` disappears. Delete the home-fallback contract in the same implementation story:

- remove the `workplace == home` special case from `assign_workplaces`;
- remove `is_home_fallback_trip` and `retarget_home_fallback_trips` when no supported caller remains;
- remove their calls/comments from building placement and workplace demolition;
- replace/delete regression tests that only pin orphaned-resident behavior.

Do not keep dormant fallback machinery for schema-v4 saves; schema v5 is a breaking development format.

For workplace demolition, keep the one existing reassignment inside the current cleanup function after affected workplaces are cleared. Do not add a second `assign_workplaces` call around it.

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

Transit inspection keeps priority. Otherwise find the selected placed building, read its mirrored TS catalog capacity, and derive occupancy from the authoritative snapshot:

- Residents: sims whose `home` is in the building footprint.
- Jobs: sims whose `workplace` is in the building footprint.

No backend query, persisted occupancy/capacity field, presenter layer, modal, citywide control, or occupancy overlay.

## Verification ownership

Rust coverage must prove:

1. Task 1 compiles after schema v5 adds only `placed_at`, removes `citizen_count`/`moveInRate`, and updates every current Rust/TS placed-building literal.
2. Small House and Large House keep resident capacities 4 and 10.
3. every current destination building remains a workplace with footprint-area job capacity.
4. player housing placement while paused creates zero sims after the move-in task.
5. the first running tick creates one resident because `placed_at <= state.time` is processed in the initial pass.
6. hourly boundaries fill to capacity and stop; coarse/fine population/assignment outcomes match.
7. one Supermarket caps at four workers while other current workplace types remain functional.
8. a resident moving in after today's outbound departure does not spawn a retroactive outbound trip and begins normal commuting after the next day reset.
9. occupied-house demolition removes sim/trip/passenger references and immediately reassigns newly freed jobs once.
10. workplace demolition reassigns at most once through the existing cleanup.
11. home-fallback production code/tests are gone.

Task 1 inventory must cover both languages:

```bash
rg -n 'PlacedBuilding \{' crates/caelum-core
rg -n 'occupiedTiles' src tests
```

At minimum include the direct TS literals in `tests/runtime/gameRuntime.test.ts` and `tests/render/overlayRenderer.test.ts` as well as shared fixture builders.

Update `golden_sequences.rs`: the no-tick placement count changes from four sims to zero. For the long commute trace, protect the behavioral invariant—coarse and fine ticks produce equivalent population/trip outcomes and the same commute set is served. Exact floating metrics may be refreshed with a short note if the added 50/100/150-second boundaries change only floating-point partitioning.

Splice UI assertions into the existing `tests/e2e/smoke.spec.ts` after house placement. Replace immediate population `4` with paused `0`, inspect the two representative buildings, Resume and poll for the first resident, then **Pause immediately** before asserting `Residents 1 / 4` / `Jobs 1 / 4`. Keep the existing road, bus-terminal, and clock tail.

## Non-goals

Configurable/random move-in, households, building relationship IDs, job entities/categories, shopping/school/leisure/visitor trips, citywide growth controls, new overlays, cars/congestion, service/headway planning, campaign redesign, save migration, compatibility layers, and pre-release hardening are outside this slice.

# Phase 2 Occupancy and Job Demand Design

**Linear:** HPA-332

## Goal

Deliver one Phase 2 vertical slice in the real sandbox UI:

> Build a Small House and Supermarket → Resume → the house fills deterministically → workers occupy finite supermarket jobs → the existing commute engine produces trips → Select shows building occupancy.

Phase 1 is complete in GitHub, and HPA-332 explicitly calls for one vertical child before wider demand work.

## Current seams

- `building_catalog.rs` has `citizen_count`; `buildings.rs` uses it to create all residents immediately.
- `assign_workplaces` treats destination footprint tiles as unlimited workplaces.
- `Sim.home` and `Sim.workplace` are already the point-based inputs used by `trips.rs`.
- `growth.rs` reuses `place_building_core`, so campaign growth currently creates the same immediate residents as player placement.
- `transit.rs` already owns building demolition and destination cleanup.
- the current Select inspector already stores a clicked tile but only renders transit nodes.

Reuse those seams. Do not add another demand system.

## Alternatives

### Keep point-based sims and add placed-building capacity data — chosen

Keep `Sim.home: Point` and `Sim.workplace: Option<Point>`. Building footprints are enough to derive current resident/job ownership, while the existing commute router can keep consuming points directly.

### Add home/workplace building IDs — defer

Explicit IDs would add relationship validation and point resolution across routing, demolition, persistence, and fixtures before there is a second consumer. Add them only if point ownership becomes a measured maintenance problem.

### General population/job framework — reject for this phase

A capacity registry, household model, scheduler service, ECS, rules engine, or event bus is not needed. The tick engine already schedules exact deterministic boundaries.

## Schema v5 building data

Bump the development snapshot schema from 4 to 5 and add to `PlacedBuilding`:

```rust
pub placed_at: f64,
pub resident_capacity: u16,
pub job_capacity: u16,
```

Replace `BuildingDefinition.citizen_count` with `resident_capacity` and `job_capacity`.

For this slice:

| Building | Residents | Jobs |
| --- | ---: | ---: |
| Small House | 4 | 0 |
| Supermarket | 0 | 4 |
| all other current buildings | 0 | 0 |

The Rust catalog stays gameplay authority. Capacity is copied into a **player-placed** building so both hosts and the UI consume authoritative per-instance values. Remove `citizenCount` from the TypeScript catalog instead of duplicating the new constants there.

### Keep dormant world growth inert

HPA-332 says this first slice populates only player-built housing. Do not add a persisted `playerBuilt`/source flag just to enforce that rule.

Instead, split the existing placement seam narrowly:

- normal/player `place_building_core` copies the catalog capacities;
- a new internal `place_world_building_core` reuses the same validation/footprint logic but stores both capacities as zero;
- `growth.rs` uses the world variant.

Campaign growth waves can still zone/place their authored buildings, but those buildings do not create residents or jobs in this slice. Update their tests to assert inert buildings rather than preserving the old immediate 4-citizen behavior. This is the minimum cleanup required to prevent dormant campaign state from entering the player-controlled occupancy loop.

Remove the dormant single-value `moveInRate: "paused"` sandbox setting/request/error branch in the same schema break. It conflicts with an active fixed rule and has no player control to preserve. Old local development saves may be cleared; do not add migration or compatibility readers.

## Deterministic move-in

Create `crates/caelum-core/src/population.rs` with:

```rust
pub const MOVE_IN_INTERVAL_SECONDS: f64 = GAME_DAY_SECONDS / 24.0;
```

That is 50 simulation seconds per in-game hour today.

For a player-built house with occupancy `n`, the next slot is due at:

```text
placed_at + n * MOVE_IN_INTERVAL_SECONDS
```

A paused new Small House remains `0 / 4`. The first running tick processes the slot due at `placed_at`; later residents arrive one game hour apart. Current occupancy is derived from sims whose `home` is in the footprint, so capacity itself is the progress record and no timer/counter state is required.

The population module should expose only focused helpers for resident occupancy, the next move-in boundary, remaining move-in slots, applying due move-ins, and removing residents from a demolished housing footprint. New residents are processed in stable building-ID order and reuse existing deterministic sim ID, worker-profile, shift-template, and home-tile rules.

## Reuse the tick scheduler

Do not add a scheduler service. `trips.rs` already substeps on day, commute, vehicle, growth, and objective boundaries.

- apply population events alongside existing growth due-events;
- add the next move-in boundary to `next_boundary_after`;
- add remaining resident slots to `max_tick_substeps`;
- keep the existing sim-count cap widening so new residents contribute commute boundaries.

A coarse tick therefore observes residents at the same timestamps as equivalent fine ticks.

## Capacity-aware workplaces

Keep `buildings.rs::assign_workplaces` as the assignment seam.

- only placed buildings with `job_capacity > 0` provide jobs;
- preserve valid existing assignments and count them against capacity;
- process unassigned workers and workplace buildings in stable ID order;
- map each occupied slot to a point in the workplace footprint so `Sim.workplace` remains usable by the current router;
- stop at capacity; excess workers remain unassigned.

No job categories, wages, preferences, or generalized labor market.

## Demolition

For Supermarket removal, reuse the existing destination-reference cleanup, then run capacity-aware assignment once so displaced workers can take remaining current jobs.

For occupied Small House removal, remove residents whose `home` is in the footprint and clean their active-trip/vehicle-passenger references before publishing the snapshot. Do not introduce household lifecycle infrastructure.

## UI

Make `ShellInspectorState` a small discriminated union with the existing transit fields under `kind: "transit"` and this building branch:

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

Derive presentation occupancy from the authoritative snapshot:

- Residents: sims whose `home` is in the footprint.
- Jobs: sims whose `workplace` is in the footprint.

`InspectPanel.svelte` only adds `Residents X / 4` or `Jobs X / 4`. No backend query, presenter layer, modal, citywide control, or occupancy overlay.

## Verification

Rust coverage proves:

1. Small House player placement while paused creates zero sims.
2. the first running tick creates one deterministic resident;
3. hourly boundaries fill to four and stop;
4. coarse/fine ticks produce equivalent population/workplace state;
5. one player-built Supermarket accepts four workers and no more;
6. `sim-001` reaches the existing outbound commute spawn path at its deterministic departure time;
7. world/campaign Small Houses remain capacity-zero and do not enter move-in;
8. workplace demolition clears/reassigns safely;
9. housing demolition leaves no resident/trip/vehicle reference to removed residents.

Update old tests that assert immediate `citizen_count` spawning. Update current schema/wire/host fixtures directly; do not add schema-v4 compatibility cases.

UI coverage extends `runtimeSelectors.test.ts` and the existing `tests/e2e/smoke.spec.ts`: while paused show population 0 plus `Residents 0 / 4` and `Jobs 0 / 4`; after Resume observe the first resident and first filled job. Rust tests cover later-hour filling and commute timing so Playwright does not wait until the morning shift.

## Non-goals

Additional building capacities, configurable/random move-in, households, job categories, shopping/school/leisure/visitor trips, citywide growth controls, new overlays, cars/congestion, service/headway planning, campaign redesign beyond keeping existing growth inert, save migration, and pre-release hardening are outside this slice.

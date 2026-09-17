# HPA-463 Workplace Commute Patterns Design

**Issue:** HPA-463 — Give offices and factories distinct commute patterns  
**Status:** Proposed for implementation on the same PR

## Summary

Make Office Tower and Factory materially different transport destinations without adding a second scheduling model.

- Office Tower workers use the existing `standard` shift template.
- Factory workers use the existing `early` or `late` shift template, chosen deterministically from citizen identity.
- Other workplaces keep the current identity-derived shift behavior.
- The existing `Routine::Worker.shift_template` remains the only worker schedule state. Assignment updates that field; the exact-time scheduler, trip lifecycle, day-off logic, optional outings, routing, and persistence remain unchanged.
- The Build panel explains Office/Factory size, price, job capacity, and schedule before placement.
- The selected-building inspector shows staffing, work pattern, and current destination demand from existing aggregate presentation rows.
- The WebGPU overlay emphasizes the selected Office/Factory footprint and its current demand using the existing overlay geometry path.
- Small Town replaces its current supermarket demonstration destination with an Office Tower while retaining its Factory, so both patterns are playable through the ordinary sandbox flow.

This is one vertical slice and one PR. No new art, schema, backend query, schedule registry, simulation class hierarchy, or passenger model is needed.

## Existing seams

The current implementation already has almost every required concept:

- `crates/caelum-core/src/commute.rs` owns canonical shift templates and their departure/return windows.
- `population/schedule.rs` stores the worker's selected template in `Routine::Worker.shift_template`, assigns finite workplace slots, reconciles workers after building changes, and schedules exact-time routine wakes.
- `PopulationIndex` already knows each workplace's `building_type`, job capacity, occupied tiles, and assigned workers.
- `GameEngine::snapshot()` persists the selected `shift_template`; restore reconstructs the same worker routine.
- `buildingOccupancy` already exposes worker count for job buildings without sending citizen rows to TypeScript.
- `demandFlow` already exposes aggregate destination demand by tile.
- `runtimeSelectors.ts` already resolves selected building footprints and builds the building inspector.
- `overlayBatch.ts` already draws demand fills and selection/preview geometry through WebGPU.
- Small Town already contains two Small Houses, a Factory, a destination occupying the exact 2x2 footprint needed by an Office Tower, and road access around both sites.

The feature should grow these seams in place rather than introduce new authorities.

## Approaches considered

### A. Assignment-time shift derivation — chosen

When a Worker receives a workplace, derive the worker's canonical `shift_template` from the workplace type and store it in the existing routine. Initial move-in and later vacancy refill call the same helper.

This keeps scheduling O(due work), preserves the current durable model, and makes active-trip behavior naturally follow the existing resolution path.

### B. Derive workplace schedule every time the scheduler wakes

Keep an identity-only template in the routine and look up the current workplace type every time `routine_minute` runs.

This avoids mutating the template on assignment, but leaves two competing meanings in `Routine::Worker`, adds lookups to every routine calculation, and makes persisted `shift_template` misleading. Reject.

### C. Add a workplace schedule registry / building-specific simulation objects

Introduce schedule descriptors or specialized Office/Factory simulation classes and reference them from workers.

This is unnecessary for two rules that map directly onto four existing canonical templates. It adds state and abstraction without adding gameplay. Reject.

## Rust scheduling rule

Add one focused helper in `commute.rs`:

```rust
pub fn shift_template_for_workplace(
    citizen_id: &str,
    building_type: &str,
) -> Option<&'static str>
```

Rules:

| Worker destination | Stored template |
| --- | --- |
| `officeTower` | `standard` |
| `factory` | `early` for one stable identity bucket, `late` for the other |
| any other workplace | existing `shift_template_for_id(citizen_id)` result |

Factory bucketing uses the numeric citizen-ID suffix parity. The rule is intentionally simple and deterministic: the same citizen receives the same Factory template across days, save/load, and reassignment. The UI describes Factory as an early/late mix; it does not promise a 50/50 ratio for a particular building.

`shift_template_for_id` continues to decide whether a new citizen is a Worker or Student. The workplace helper is only applied to Workers.

### Initial move-in

`apply_move_in` keeps the current sequence:

1. mint the citizen ID;
2. determine Worker versus Student through `shift_template_for_id`;
3. for a Worker, find the first stable available workplace;
4. when a workplace exists, derive the stored worker shift from the assigned building type;
5. when no workplace exists, keep the current identity-derived worker template until a job is assigned;
6. schedule through `routine_from_now` as today.

`find_available_workplace` may widen its private return tuple to include `building_type`; no new public type is required.

### Reassignment / vacancy refill

The existing global refill loop remains the authority for who gets each vacancy. When it fills a slot, update `Routine::Worker.workplace` and `Routine::Worker.shift_template` together using the same workplace helper.

Do not change vacancy ordering, nearest-home behavior, capacity, or global employment balancing.

### Active-trip behavior

Changing a worker's assignment must not rewrite, restart, duplicate, or directly reschedule an active trip.

The new stored template becomes visible at the next existing scheduling boundary:

- an outbound trip resolution schedules the return using the worker's current template;
- a return trip resolution schedules the next daily routine using the current template;
- the existing `.max(now)` late-return clamp prevents a newly selected return window from scheduling into the past;
- existing demolition retarget/drop/recovery semantics stay intact.

This is exactly the behavior HPA-463 needs; no rescheduling framework is added.

### Persistence

No snapshot field or schema version changes.

`CitizenRoutine::Worker.shift_template` already persists the selected canonical template, and workplace point already persists the assignment. A save produced after this change therefore restores the same shift and assignment. Focused native restore coverage will pin that contract.

Old development saves are not given compatibility behavior beyond the repository's existing validation; no migration is added.

## Player-facing building information

Keep presentation metadata small and local to the existing TypeScript building catalog. Add an optional `workPattern` string to `BuildingDefinition`, populated only for the two featured workplaces:

- Office Tower: `Standard · 07:00–09:00 starts, 17:00–19:00 returns`
- Factory: `Early / late · 05:30–07:00 or 10:00–11:30 starts; 15:00–16:30 or 19:30–21:00 returns`

These strings describe the exact existing Rust windows. They are explanatory copy, not simulation authority.

### Build panel

For Office Tower and Factory entries, show the existing catalog values before placement:

- rotated footprint (`width × height`);
- price;
- job capacity;
- `workPattern`.

Do this inside the existing Buildings submenu. Do not add a new detail screen or another build-menu state machine.

Other build items keep their current compact presentation unless the small shared markup naturally supports the same size/price/capacity row without extra branching.

## Selected-building inspector

Extend `ShellBuildingInspectorState` only with the derived values needed by the existing inspector:

```ts
workPattern: string | null;
currentDestinationDemand: number | null;
```

No backend call is introduced.

For the selected building, `buildInspector` already has its authored footprint and catalog definition. For Office Tower or Factory:

- `occupancy` remains the existing aggregate worker count from `buildingOccupancy`;
- `capacity` remains authored `jobCapacity`;
- `workPattern` comes from the TypeScript catalog copy;
- `currentDestinationDemand` is the sum of `state.demandFlow` rows whose points fall inside `building.occupiedTiles`.

The panel renders three distinct states:

- `Unstaffed` when job occupancy is zero;
- `Staffed · quiet now` when occupancy is positive and current destination demand is zero;
- `Staffed · current destination demand N` when both are positive.

It always shows the authored `Jobs X / Y` separately from live demand and schedule copy. Zero current demand is never described as good service, no future demand, or lack of ridership.

Housing and other existing building-inspector behavior stays unchanged.

## WebGPU selected-workplace emphasis

Keep the existing renderer path and `UiState.selectedId` selection.

Export/reuse the existing selected-point parser from `runtimeSelectors.ts` rather than inventing another selection store. In `overlayBatch.ts`, add a small selected-workplace pass before previews:

1. resolve the selected point;
2. find the building whose occupied footprint contains it;
3. continue only for Office Tower or Factory and only for building selection (not a transit-node selection);
4. stroke the selected building's existing occupied tiles with the existing demand color;
5. when the global Demand overlay is not already active, fill only selected-footprint tiles that have `demandFlow` rows, using the existing `demandAlpha` calculation;
6. when the Demand overlay is active, retain only the outline so the demand fill is not double-darkened.

This makes an unstaffed/quiet selected workplace locatable while still showing where current destination demand is landing. No new color registry, canvas fallback, camera movement, or second overlay system.

## Small Town playable example

Keep the existing Small Town road and housing layout.

Change the authored 2x2 site at `(18, 6)` from Commercial + Supermarket to Office + Office Tower. Keep the existing 3x2 Industrial + Factory site at `(15, 11)`.

The two existing Small Houses provide eight Worker move-in slots before the first Student ID is reached. With Office Tower capacity 4 and Factory capacity 6, stable vacancy filling necessarily gives both workplaces at least some staff regardless of which job-building ID sorts first: the first can consume at most six of eight workers, leaving at least two for the other.

This is sufficient to demonstrate both patterns without adding housing, changing catalog capacities, seeding passengers, or creating another template.

Blank Grid and Crossroads are untouched.

## Testing strategy

### Rust

Pin the rule and lifecycle, not implementation details:

- `commute.rs` unit coverage for Office = standard, Factory = deterministic early/late, and other workplace = current identity-derived behavior;
- population integration coverage that ordinary move-in assigns Office/Factory workers the workplace-derived template;
- a representative demolition/refill reassignment updates the template without duplicating an active trip and relies on the existing past-return clamp;
- snapshot → `GameEngine::from_snapshot` restore preserves the assignment/template and subsequent schedule;
- existing Student/day-off/optional-outing/capacity tests remain green.

### TypeScript/UI/render

- building catalog test pins the two exact pattern strings;
- runtime selector tests cover unstaffed, staffed-but-quiet, active-demand sum across a footprint, and unchanged housing inspector behavior;
- Build panel UI test verifies Office/Factory footprint, price, capacity, and pattern copy are visible in the existing submenu;
- Inspect panel UI test verifies the three workplace states and separate Jobs/capacity line;
- WebGPU overlay unit test verifies selected workplace outline/demand vertices exist, quiet selection still outlines, and the global Demand overlay does not double-fill selected demand.

### Sandbox/browser

- sandbox factory test pins Small Town to Office Tower + Factory while Blank Grid/Crossroads remain unchanged;
- one Chromium real-WASM Small Town path creates the template, runs normal move-in, selects the two workplaces through ordinary UI, and observes staffing/pattern/current-demand presentation without a test-only passenger seed.

## Verification

Focused commands during implementation:

```bash
cargo test -p caelum-core --test population
cargo test -p caelum-core --test sandbox_factory
bunx vitest run --project runtime tests/runtime/buildingCatalog.test.ts tests/runtime/runtimeSelectors.test.ts tests/render/webgpuOverlayBatch.test.ts
bunx vitest run --project ui
bunx playwright test tests/e2e/newCity.spec.ts --project=chromium
```

Final repository gate:

```bash
cargo test --workspace
bun run test
bun run check
bun run lint
bun run format:check
bun run build
bun run test:e2e
```

## Non-goals

No new building types, art, timetable editor, workplace schedule registry, per-citizen presentation payload, economy rebalancing, nearest-home employment, household simulation, production chains, taxes, land value, transport mode, route diagnostics, stop/line navigation, camera behavior, benchmark gate, persistence migration, or separate QA PR.

HPA-464 remains the owner of stop queues, line warnings, and service-control navigation.
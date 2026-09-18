# HPA-463 Workplace Commute Patterns Design

**Issue:** HPA-463 — Give offices and factories distinct commute patterns  
**Status:** Proposed for implementation on the same PR

## Summary

Make Office Tower and Factory materially different transport destinations without adding a second scheduling model.

- Office Tower workers use the existing `standard` shift template.
- Factory workers use the existing `early` or `late` shift template, chosen deterministically from citizen identity.
- Other workplaces do not change a worker's existing stored shift when assigned/reassigned; only Office Tower and Factory provide workplace-specific overrides.
- The existing `Routine::Worker.shift_template` remains the only worker schedule state. Assignment updates that field; the exact-time scheduler, trip lifecycle, day-off logic, optional outings, routing, and persistence remain unchanged.
- The Build panel explains Office/Factory size, price, job capacity, and schedule before placement.
- The selected-building inspector shows staffing, work pattern, and current destination demand from existing aggregate presentation rows.
- The WebGPU overlay generically emphasizes any selected building footprint and any current `demandFlow` rows inside that footprint; the renderer does not know Office/Factory taxonomy.
- Small Town keeps its Supermarket/optional-outing path, adds one Small House and an Office Tower, and retains its Factory so office/factory patterns remain playable without disabling existing sandbox behavior.

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
- Small Town already contains two Small Houses, a Supermarket (its only optional-outing site), a Factory, and free road-adjacent space for one additional Small House plus an Office Tower.

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

Add one focused **override** helper in `commute.rs`:

```rust
pub fn workplace_shift_template(
    citizen_id: &str,
    building_type: &str,
) -> Option<&'static str>
```

Rules:

| Worker destination | Override |
| --- | --- |
| `officeTower` | `Some("standard")` |
| `factory` | `Some("early")` for one stable identity bucket, `Some("late")` for the other |
| any other workplace | `None` — keep the worker's existing stored template |

Factory bucketing uses numeric citizen-ID suffix parity. The same citizen therefore receives the same Factory override across days, save/load, and later Factory assignments. The UI describes Factory as an early/late mix; it does not promise a 50/50 ratio for a particular building.

`shift_template_for_id` continues to decide Worker versus Student and supplies the Worker's initial identity-derived template. `workplace_shift_template` never carries Student semantics; `None` means only "this workplace does not override the current Worker template." This keeps non-featured workplaces structurally unchanged and avoids an impossible-state `.expect()` at assignment.

### Initial move-in

`apply_move_in` keeps the current sequence:

1. mint the citizen ID;
2. determine Worker versus Student through `shift_template_for_id`;
3. for a Worker, find the first stable available workplace;
4. when the assigned workplace has a workplace-specific override, replace the stored worker shift with it;
5. otherwise keep the current identity-derived worker template;
6. schedule through `routine_from_now` as today.

`find_available_workplace` keeps its current private `(building_id, point)` return shape. After assignment, the caller reads `PopulationBuilding.building_type` from the existing `PopulationIndex` by `building_id`; no tuple widening or new public type is required.

### Reassignment / vacancy refill

The existing global refill loop remains the authority for who gets each vacancy. When it fills a slot, always update `Routine::Worker.workplace`; update `shift_template` only when `workplace_shift_template` returns an override. Assigning/reassigning a worker to Warehouse, Supermarket, Business Park, or another unfeatured workplace therefore preserves that worker's current template.

There is one existing timing seam that must also be corrected for an **idle unemployed Worker**. Such a Worker can already hold a future `NextActivity::DailyRoutine` scheduled from the old template. If a newly placed Office Tower or Factory fills that vacancy, keeping the old wake would make today's commute leave on the old clock.

Make activity supersession safe at the one scheduler insertion seam rather than at this call site:

- extend private `schedule_activity(world, entity, activity)` so, when the entity already has `NextActivity`, it removes every matching `PopulationEvent::Activity { entity }` from that previous exact due-time bucket and removes the bucket if empty;
- then insert the new event and replace the `NextActivity` component as it already does;
- keep `boundary_generation` monotonic; removing an obsolete key does not decrement it.

With that invariant in place, idle refill can simply call `schedule_activity(world, entity, routine_from_now(...))` after applying an Office/Factory override. Existing call sites that already schedule only when no activity exists keep their behavior, including the recovery guard after dropped trips.

Do not change vacancy ordering, nearest-home behavior, capacity, global employment balancing, or the existing dropped-trip recovery precedence.

### Active-trip behavior

Changing a worker's assignment must not create a second active trip or add a new shift-driven trip restart path.

Existing demolition reconciliation is preserved: when a cleared worker already has an outbound commute and receives a replacement workplace, `reconcile_buildings` may reset that **same trip ID** in place to the new destination with a fresh deadline/patience window. HPA-463 does not replace or duplicate that behavior.

The new stored template becomes visible through the existing lifecycle:

- an idle worker with a pending `DailyRoutine` wake schedules a replacement through the now-superseding `schedule_activity`, so a newly assigned Office/Factory affects the next outbound departure without leaving a stale bucket entry;
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

Do **not** inject long schedule prose into the existing uniform building buttons. Those buttons intentionally remain compact command leaves.

Instead, when a building is currently armed and the player opens the Buildings submenu, render one accessible summary block beside/above the existing Rotate control:

- current rotated footprint (`width × height`);
- price;
- the relevant authored capacity (`N residents` or `N jobs`);
- `workPattern` on a second line only when the armed definition has one.

The summary is generic for every armed building; `workPattern` is optional data, not a branch for two hard-coded building names. Arming a building already closes the command panel, so this summary appears when Build is reopened while that building remains armed; placement behavior and panel occlusion stay unchanged. Do not add a detail screen or another build-menu state machine.

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

## WebGPU selected-building emphasis

The Linear acceptance scope explicitly requires selected-workplace map emphasis, so keep one bounded WebGPU change — but make it **generic selection presentation**, not workplace taxonomy.

Keep the existing renderer path and `UiState.selectedId` selection. Export/reuse the existing selected-point parser from `runtimeSelectors.ts` rather than inventing another selection store. In `overlayBatch.ts`, add one selected-building pass before previews:

1. resolve the selected point;
2. if `selectedNodeKind !== null`, stop so transit-node selection keeps priority;
3. find **any** building whose `occupiedTiles` contain the selected point;
4. stroke its existing footprint with the existing demand color;
5. when the global Demand overlay is not active, fill only `demandFlow` rows whose points are inside that selected footprint using existing `demandAlpha`;
6. when Demand overlay is active, retain only the outline so demand fill is not double-darkened.

The renderer never checks `building.type === "officeTower"` or `"factory"`; future buildings gain the same selection behavior automatically. Unit coverage asserts exact expected tile coordinates/color/alpha using the test file's existing `hasVertexNear` / `alphaAt` helpers, not only buffer length.

This makes a quiet selected workplace locatable while also emphasizing current destination-demand tiles. No new color registry, canvas fallback, camera movement, renderer layer, or simulation taxonomy.

## Small Town playable example

Keep the existing roads, Supermarket, and Factory. The Supermarket is Small Town's only current optional-outing destination, so replacing it would silently disable `OptionalOutbound` / `OptionalReturn` gameplay in the only populated authored sandbox.

Make the smallest additive layout change:

- keep Small Houses at `(4, 7)` and `(8, 7)`;
- add a third Small House at `(6, 7)` inside the existing Residential zone;
- keep Commercial + Supermarket at `(18, 6)`;
- add Office area `(21, 6)` through `(22, 7)` and Office Tower at `(21, 6)`, adjacent to the existing y=8 road;
- keep Industrial + Factory at `(15, 11)`.

Place buildings in deterministic order: three Small Houses, Office Tower, Supermarket, Factory. The twelve housing slots mint `sim-001` through `sim-012`; `sim-010` remains the canonical Student, leaving eleven Workers. Stable building-ID vacancy filling therefore staffs Office Tower first (four workers), Supermarket next (four), and Factory with the remaining three workers. That gives both featured patterns real staff while retaining optional outings and existing destination behavior.

No catalog capacity, starting capital, passenger seed, or second template changes. Blank Grid and Crossroads remain untouched.

## Testing strategy

### Rust

Pin the rule and lifecycle, not implementation details:

- `commute.rs` unit coverage for Office/Factory overrides and `None` for unfeatured workplaces, plus a drift guard that asserts the standard/early/late departure+return window boundaries used by the TypeScript `workPattern` copy;
- population integration coverage that ordinary move-in assigns Office/Factory workers the workplace-derived template **and that their first pending DailyRoutine due time falls in the expected standard/early/late window**;
- idle vacancy-fill coverage proving scheduler supersession: ticking through the old wake must not emit a commute, while the new workplace-derived wake emits exactly one;
- a representative demolition/refill reassignment updates the template while preserving one active trip with the same trip ID; do not assert the trip payload is byte-for-byte unchanged because existing reconciliation retargets an outbound in place;
- snapshot → `GameEngine::from_snapshot` restore preserves the assignment/template and subsequent schedule;
- existing Student/day-off/optional-outing/capacity tests remain green.

### TypeScript/UI/render

- building catalog test pins the two exact pattern strings;
- runtime selector tests cover unstaffed, staffed-but-quiet, active-demand sum across a footprint, and unchanged housing inspector behavior;
- Build panel UI test verifies the generic armed-building summary shows rotated footprint/price/capacity for ordinary buildings and adds Office/Factory pattern copy when present;
- Inspect panel UI test verifies the three workplace states and separate Jobs/capacity line;
- WebGPU overlay unit test verifies exact selected-building outline coordinates and demand fill color/alpha, quiet selection still outlines, and global Demand overlay does not double-fill selected demand.

### Sandbox/browser

- sandbox factory test pins Small Town's three Houses + Office Tower + retained Supermarket + Factory, preserving the optional-outing destination while Blank Grid/Crossroads remain unchanged;
- one Chromium real-WASM Small Town path creates the template **paused at t=0**, selects both authored workplaces through ordinary UI, and verifies `Unstaffed`, `Jobs 0 / capacity`, and the correct pattern copy. Deterministic Rust tests own the staffing/timing proof; the browser test must not spend wall-clock time waiting for normal move-in.

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

## Risks and trade-offs

- **Scheduler supersession:** changing `schedule_activity` affects a central private seam. The implementation must remove only the same entity's prior `Activity` event at the prior `NextActivity.due_time`; MoveIn events and other citizens in that bucket stay untouched. Focused scheduler/population regressions plus the full Rust suite guard this.
- **Small Town balance/layout:** adding one House and one Office Tower changes deterministic building IDs and resident count for Small Town. This is intentional development content churn; tests pin the new authored order. Keeping the Supermarket avoids accidentally removing optional-outing coverage.
- **UI schedule-copy drift:** the prose remains TypeScript-local by design to avoid a new wire field. A Rust boundary test pins every standard/early/late window endpoint and explicitly names the catalog copy as its consumer so schedule edits fail near the simulation authority.
- **Selection overlay scope:** rendering becomes aware of generic selected buildings for the first time. The pass is presentation-only, uses existing `selectedId`/footprints/demand rows, and contains no building-type taxonomy.

## Non-goals

No new building types, art, timetable editor, workplace schedule registry, per-citizen presentation payload, economy rebalancing, nearest-home employment, household simulation, production chains, taxes, land value, transport mode, route diagnostics, stop/line navigation, camera behavior, benchmark gate, persistence migration, or separate QA PR.

HPA-464 remains the owner of stop queues, line warnings, and service-control navigation.
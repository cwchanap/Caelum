# Platform-Based Stop/Station Management Design

## Summary

Transit nodes gain **platforms**. Today a bus stop, bus terminal, or metro station is a single transit node with one boarding `position` and an unused `queueCitizenIds` field. This design adds a fixed number of logical platforms per node type, lets the player assign each route/line to a specific platform, and gives every platform a hard waiting-capacity limit.

The strategic lever is **where you put each route**: a platform holds unlimited routes but only a limited number of *waiting* passengers, so routes sharing a busy platform compete for the same waiting slots. Spreading routes across a terminal's platforms multiplies total waiting capacity.

Platforms are **logical slots inside a node**, not separate map tiles. Citizens still walk to the node's existing `position`; the platform governs grouping and waiting capacity only. The trip router is unchanged.

## Goals

- Give each transit node a fixed platform count by type: **bus stop = 1, metro station = 2, bus terminal = 3**.
- Each platform has a hard waiting capacity: **bus = 50, metro = 300** passengers. A platform hosts an unlimited number of routes/lines.
- Auto-assign new routes to the least-loaded platform on each node they serve; let the player rebalance via an Inspect → platform panel.
- Enforce the cap at boarding: only the on-platform (board-eligible) citizens can board; the rest queue off-platform, keep losing patience, and step on as slots free.
- Replace the dead `queueCitizenIds` state and make the existing (currently inert) Crowding overlay functional.
- Preserve determinism and the runtime-owned immutable-state contract.

## Non-Goals

- No platform-aware trip routing. `findRoutePlan` is unchanged; citizens plan as they do today and capacity only bites at boarding.
- No separate platform map tiles or per-platform `position`s. Platforms are logical.
- No per-platform vehicle berthing, dwell time, or per-platform vehicle assignment.
- No in-game configurable capacities; values are tunable code constants.
- No new objective or loss condition. Overflow pressure surfaces through existing unserved/average-wait metrics via the patience system.
- No change to how routes are *drawn* (still click stops in order).

## Decisions (resolved during brainstorming)

| Decision | Choice |
|---|---|
| Platform model | Logical slots inside a node; count by type — bus stop 1, metro station 2, bus terminal 3 |
| Per-platform waiting cap | bus 50 / metro 300; unlimited routes per platform |
| Overflow rule | Hard cap on *on-platform* (board-eligible) citizens; extras queue off-platform, keep losing patience, step on as slots free |
| Assignment | Auto least-loaded on route create; rebalance via Inspect → platform panel |
| Data representation | Node owns `platforms[]` with `routeIds` + `capacity`; occupancy derived each tick (single source of truth = citizens) |
| Router | Unchanged |
| On-platform tie-break | Longest-waiting first (`patienceRemaining` ascending), then citizen `id` ascending |
| Crowding overlay | Rewritten to use real platform occupancy; in scope |

## Data Model (`src/domain/types.ts`)

New interface:

```ts
export interface Platform {
  id: string;          // `${nodeId}-p0`, `${nodeId}-p1`, … — stable & deterministic
  label: string;       // "A" | "B" | "C"
  capacity: number;    // 50 (bus) | 300 (metro)
  routeIds: string[];  // bus route ids / metro line ids assigned to this platform
}
```

`Stop` and `Station` each **replace** `queueCitizenIds: string[]` with `platforms: Platform[]`.

Occupancy is **not stored**. On/off-platform counts are derived each tick from `state.citizens`, keeping citizens the single source of truth and avoiding desync.

## Constants (`legacy-ts-simulation/transit.ts`)

```ts
const PLATFORM_CAPACITY = { bus: 50, metro: 300 } as const;
// platform count by node kind: busStop → 1, busTerminal → 3, metroStation → 2
```

A small helper builds the initial `platforms` array for a node kind (labels A/B/C, empty `routeIds`, mode capacity, ids `${nodeId}-p{index}`).

## Node Creation

Every node-creation path initializes `platforms`:

- `transit.addBusStop` → 1 bus platform.
- `transit.addMetroStation` → 2 metro platforms.
- `buildings.placeBuilding`: bus stop → 1, bus terminal → 3, metro station → 2.

The initial game state seeds no transit nodes, so there is no scenario data to migrate — only test fixtures that currently set `queueCitizenIds`.

## Assignment Lifecycle

**Auto-assign on create.** After `addBusRoute` / `addMetroLine` inserts the route, for each *distinct* node in the route's `stopIds` (walked in `stopIds` order), append the route id to that node's **least-loaded platform**: the platform with the fewest `routeIds`, tie broken by label (A first). Deterministic.

**Reassign (new pure helper).** `assignRouteToPlatform(state, nodeId, routeId, platformId): GameState`:
- Validates the node exists, the route currently serves the node, and `platformId` belongs to the node. On any failure, returns `state` unchanged (no-op).
- Removes `routeId` from whichever platform on that node currently holds it, then adds it to the target platform.
- No cap on routes per platform (unlimited lines).

**Removal cleanup.** When a route/line is removed, or a node removal cascades to route removals (`removeAtTile`), strip the dead route id from **all** platforms across all remaining nodes. Removing a node drops its platforms with it.

## Simulation — On-Platform Gating (`legacy-ts-simulation/transit.ts`)

The hard cap is enforced only at boarding. At the **start of `tickVehicles`**, compute one snapshot set of board-eligible citizen ids:

```text
onPlatformCitizenIds: Set<string>
for each node (stops + stations):
  for each platform P on the node:
    waiters = citizens where
        status == "waiting"
        && position == node.position
        && currentLeg is a transit leg with lineId ∈ P.routeIds
    sort waiters by (patienceRemaining ASC, id ASC)   // longest-waiting first
    add the first P.capacity ids to onPlatformCitizenIds
```

`citizenCanBoard` gains a single extra condition: `onPlatformCitizenIds.has(citizen.id)`. Seat capacity, `lineId` match, and position checks are unchanged.

Each waiting citizen belongs to exactly one platform on their node (their boarding leg has one `lineId`, which sits on exactly one platform there), so the partition is well-defined.

Computing the snapshot **once at tick start** (from tick-start state) makes board eligibility independent of vehicle iteration order — preserving determinism even when multiple routes/vehicles share a platform and draw from the same shared cap.

**Overflow behavior falls out for free:** citizens beyond a platform's capacity are absent from the set, cannot board this tick, but remain `waiting` and keep losing patience through the existing `tickCitizens` path (no new status, no new state). As on-platform riders board and leave, overflow citizens' rank improves and they become eligible. Severe jams time out via the existing patience → unserved mechanic, feeding existing metrics/objectives.

## Router (`legacy-ts-simulation/router.ts`)

Unchanged. Confirmed by the chosen overflow rule (queue off-platform, not plan-around).

## Runtime + UI — Inspect Platform Panel

- **Resolve node at tile.** Generalize `resolveStopAtTile` (in `src/ui/actions.ts`) into `resolveNodeAtTile(state, point)` returning the stop *or* station at a tile, handling the bus terminal's 3×2 footprint and building-backed nodes. (Metro/bus-stop footprints are 1×1; bare tool-placed stops match by position.)
- **Selector.** `runtimeSelectors` builds an `inspector` view-model when `ui.selectedId` resolves to a node: per-platform rows `{ label, occupancy, capacity, routes: [{ id, name, color }] }`, plus, for each route, the sibling platforms it can move to. Occupancy comes from a shared derive `selectPlatformOccupancy(state)` (also used by the overlay).
- **Controller.** Add `RuntimeController.assignRouteToPlatform(nodeId, routeId, platformId)` → applies the pure helper and `commit`s. Wire through `createGameRuntime` and pass the handler down via `App.svelte`.
- **`ControlTower.svelte`.** Render the platform panel when an inspected node is present: occupancy (e.g. `12/50`), route chips per platform, and "Move →" buttons. Move controls appear only when the node has >1 platform; a bus stop shows a single read-only platform.

## Render — Crowding Overlay (`src/render/overlayRenderer.ts`)

The crowding branch currently reads the never-populated `queueCitizenIds` and never lights up. Rewrite it to use `selectPlatformOccupancy`: fill a node's tile(s) when **any platform is at/over capacity**, with lighter intensity above ~50% utilization. This makes the existing Crowding overlay functional for the first time.

## Determinism

- Platform `id`/`label` are positional and stable.
- Auto-assign is deterministic (least-loaded, label tie-break, `stopIds` order).
- The on-platform snapshot ranks by `patienceRemaining` then `id` — both deterministic.
- No `Math.random` or wall-clock time introduced.

## Testing (comprehensive)

**`tests/simulation/transit`**
- Auto-assign picks least-loaded platform; tie breaks to label A; respects `stopIds` order.
- `assignRouteToPlatform` moves a route between platforms; rejects bad node/route/platform as no-op.
- Removal strips a dead route id from every platform across nodes.
- On-platform snapshot ranks by `patienceRemaining` then `id`; exactly `capacity` are eligible.
- Boarding blocked once a platform is full; overflow citizen boards after an on-platform rider leaves.
- Per-mode capacities (bus 50 / metro 300) applied to the right node kinds.
- Determinism: identical inputs produce identical boarding order regardless of vehicle order.

**`tests/simulation/buildings`**
- Each node type initializes the correct platform count and capacity.

**`tests/ui/actions`**
- `assignRouteToPlatform` validation paths (no-op on invalid input).
- `resolveNodeAtTile` resolves terminal footprint tiles and metro/bus-stop tiles.

**`tests/runtime`**
- Selector emits the correct inspector VM and occupancy.
- Controller `assignRouteToPlatform` commits a new state.

**`tests/render`**
- Crowding overlay lights nodes with a full platform; stays dark below capacity.
- Update canvas fixtures.

**Fixture migration**
- Replace every test fixture `queueCitizenIds: []` with `platforms: [...]` of the correct shape.

## Open Risks

- **Fixture churn:** ~15 test fixtures and several `Stop`/`Station` literals reference `queueCitizenIds`; all must move to `platforms`. Mechanical but broad.
- **Selector cost:** occupancy is recomputed each render/tick. N is small (citizens + nodes), so acceptable; if profiling ever flags it, memoize per tick.

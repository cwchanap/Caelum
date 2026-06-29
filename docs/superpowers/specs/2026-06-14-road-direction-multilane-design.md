# Road Direction & Multilane Roads — Design

**Date:** 2026-06-14
**Status:** Approved (pending implementation plan)

## Summary

Add a one-way **direction** attribute to road lanes and establish **multilane
roads** as a first-class concept, built by laying parallel lane-tiles. The goal
is **routing depth**: one-way streets constrain which paths a bus route can
take. Each grid tile is one lane; a multilane road is simply adjacent road
tiles. This change is the data **foundation** for a future congestion
simulation (not built here) — the per-lane direction is what a congestion model
will read as flow.

## Context

The current road model (verified against the code):

- **Roads are a single binary tile layer.** A tile is either `kind: "road"` or
  not. There is no width, direction, or per-road cost.
- **Bus pathfinding** (`findTilePath` in `legacy-ts-simulation/network.ts`) is a
  deterministic 4-connected BFS over road tiles (fixed N, E, S, W expansion
  order — a scenario contract). Metro pathfinding traverses `hasTrack === true`
  tiles instead.
- **There is no congestion or traffic model.** Buses move at a fixed
  `TILES_PER_SECOND.bus = 0.8` regardless of road or load; citizens walk in
  straight lines independent of roads. So "multilane" has no existing mechanic
  to plug into — its present-day value is the routing geometry and the data
  foundation for future congestion.
- **`hasTrack?` is already an optional per-tile layer** that coexists with
  roads (level crossings). It is the precedent this design follows for adding a
  new road attribute.

## Decisions

These were settled during brainstorming:

1. **Goal = routing depth**, not a congestion subsystem (that comes later).
2. **Multilane = adjacent parallel lane-tiles.** 1 grid tile = 1 lane. There is
   no numeric lane-count attribute and no wider footprint; a multilane road is
   emergent geometry.
3. **Direction is a per-tile road attribute, two-way by default.** A lane is
   bidirectional unless made one-way. One-way is opt-in, so existing roads keep
   working unchanged. A realistic two-way corridor can be built as two parallel
   opposing one-way lanes; same-direction parallels are the future capacity
   foundation.
4. **Direction is set by cycling on click** with the Road tool. No extra palette
   UI.

## Design

### 1. Data model

Add an optional road-direction attribute to `Tile`, mirroring `hasTrack?`:

```ts
// src/domain/types.ts
export type RoadDirection = "north" | "east" | "south" | "west";

export interface Tile extends Point {
  id: string;
  kind: TileKind;
  districtId?: string;
  hasTrack?: boolean;
  /** One-way constraint on a road lane. Undefined = two-way (default). */
  oneWay?: RoadDirection;
}
```

- `oneWay` is only meaningful when `kind === "road"`.
- It is cleared whenever the tile stops being a road (removal).
- Default `undefined` everywhere ⇒ the Growing Suburb scenario and all existing
  tests are unchanged.
- A "multilane road" needs no field; it is just adjacent road tiles. `oneWay` is
  the per-lane flow a future congestion sim will consume.

### 2. Editing / UX — cycle on click

In `src/ui/actions.ts`, the `road` tool branch changes from "lay or no-op" to:

- **Click an empty tile** → `layRoad` (a two-way road, costs `COSTS.road`, as
  today).
- **Click an existing road tile** → cycle its direction:
  `two-way → north → east → south → west → two-way`. This is **free** (editing,
  not building). The cardinal order matches `network.ts`'s `neighborOffsets`
  (N, E, S, W) for consistency.

Each direction change runs through `recomputeRoutePaths` (exactly as
`layRoad`/`layTrack` already do), so a one-way that severs a route's loop flips
it to `pathBroken`, and reversing it restores the route — reusing the existing
network damage/repair machinery. No new UI controls are added to the Road tool
palette.

### 3. Routing semantics

`findTilePath` (`legacy-ts-simulation/network.ts`) gains a one-way **exit
constraint**, bus mode only: when BFS expands from a road tile whose `oneWay`
is set, the only legal next step is the neighbor in the arrow direction.

- Metro / track pathfinding ignores `oneWay` entirely.
- Two-way tiles (`oneWay === undefined`) behave exactly as today, so the
  deterministic-BFS scenario contract holds.
- The existing endpoint exception (from/to tiles are always traversable
  regardless of kind) is unaffected: the constraint is on *exiting* a directed
  tile, so a destination tile imposes nothing, and a start tile that is a
  one-way road still forces its arrow direction (correct).
- No travel-time or speed changes. One-way only restricts *which* paths are
  valid; multilane just offers additional parallel legal paths.

A pair of adjacent parallel one-way lanes pointing opposite directions therefore
forms a working two-way corridor; two same-direction parallel lanes both remain
valid forward paths (capacity foundation).

### 4. Rendering

In `src/render/mapRenderer.ts`, add an arrow pass structured like the existing
track-rendering pass: a one-way road tile draws a chevron pointing in its
`oneWay` direction. Two-way roads render unchanged.

Lane-divider striping between adjacent same-direction roads is **out of scope**
(visual polish with no present gameplay value).

### 5. Testing

`tests/` mirrors `src/` by domain; these are node-env simulation/runtime tests
plus one render test.

- **network**: a one-way tile blocks reverse traversal and permits forward;
  two-way unchanged; a parallel opposing one-way pair forms a working two-way
  corridor.
- **actions**: the road-tool cycle sequence
  (`two-way → north → east → south → west → two-way`); cycling is free, laying
  costs `COSTS.road`.
- **transit**: a one-way that breaks a route loop sets `pathBroken`; reversing
  it restores the route.
- **render**: a one-way tile draws a direction arrow.
- **Regression**: all existing scenario / route / path tests pass untouched
  (guaranteed by `oneWay === undefined` defaulting to today's behavior).

## Out of scope (YAGNI)

Deferred deliberately:

- Congestion / capacity simulation and per-lane throughput.
- Per-tile speed or travel-time effects from lanes.
- Numeric lane-count attributes or wider (multi-tile) road footprints.
- Drag-to-draw road direction.
- One-way constraints on metro tracks.
- Lane-marking / divider visuals.

This change is the minimal foundation: per-lane direction plus the routing and
rendering needed to use it.

## Affected files

- `src/domain/types.ts` — `RoadDirection` type, `oneWay?` on `Tile`.
- `legacy-ts-simulation/network.ts` — one-way exit constraint in `findTilePath`.
- `legacy-ts-simulation/map.ts` — helper to set/clear `oneWay`; clear on road removal.
- `legacy-ts-simulation/transit.ts` — direction-cycle action; ensure
  `recomputeRoutePaths` runs; clear `oneWay` in `removeInfrastructureAtTile`.
- `src/ui/actions.ts` — Road tool: empty → lay, existing road → cycle direction.
- `src/render/mapRenderer.ts` — one-way arrow rendering pass.
- `tests/simulation/*`, `tests/render/*` — coverage per section 5.

# Road/Track Route Restrictions — Design

**Date:** 2026-06-09
**Status:** Approved

## Problem

Routes currently have no relationship to infrastructure. A bus route or metro
line is an ordered list of stop IDs; vehicles interpolate in straight lines
between stop positions (fixed ~12.5s per segment regardless of distance), and
the renderer draws straight polylines. In reality buses can only drive on
roads and metros can only run on tracks.

Additionally, tracks do not exist in the game at all (no tile kind, no tool),
and roads are fixed by the scenario (full row y=8, full columns x=7/15/22 —
which partition the 28×18 map into 8 quadrants). There is no road-building
tool despite the project description promising one.

## Decisions (made with the user)

1. **Full path-following.** Routes are only valid along connected road/track,
   vehicles visibly drive along the path, and travel time scales with path
   length.
2. **Manual track tool.** The player lays track tiles by hand for a per-tile
   cost; metro stations and lines depend on that track.
3. **Road tool included.** Symmetric road-laying tool so buses are not stuck
   on the fixed scenario cross-network forever.
4. **Broken paths deactivate, never delete.** Bulldozing a tile a route
   depends on flips the route to a broken state; re-laying the tile restores
   it. No work is lost.
5. **Technical approach: stored paths + track as a tile layer.** `hasTrack`
   boolean on tiles (level crossings come free); deterministic BFS paths
   computed at build time and stored on each route; sim, renderer, and router
   all read the stored paths.

## Section 1: Data model, tools, and placement rules

### Tile changes

- `Tile` gains optional `hasTrack?: boolean` (absent = no track).
- `kind` is untouched. A `road` tile with `hasTrack: true` is a level
  crossing: buses and metros both pass through it. No new `TileKind`.

### New tools

- `Tool` union gains `"road"` and `"track"`, surfaced as two new build
  buttons in the Control Tower build category.
- Click-per-tile placement. Drag-to-paint is out of scope for v1.
- `COSTS` gains `road: 100` and `track: 500` per tile (tunable). Context:
  starting budget is $120k; a minimal metro (2 stations + train) is $100k, so
  a 20-tile track link adds ~$10k.
- Each placement checks affordability; insufficient budget = rejected
  (unchanged state).

### Placement rules

| Action | Rule |
| --- | --- |
| Road tool | Converts `empty` → `road`. Rejected on zoned tiles (residential/jobs/civic/park), building-occupied tiles, existing roads. |
| Track tool | Sets `hasTrack: true` on an `empty` **or** `road` tile (crossings). Rejected on zoned tiles, building-occupied tiles, tiles holding a stop/station, tiles that already have track. |
| Bus stop | Unchanged (`kind === "road"`, unoccupied) **plus** `!hasTrack` — no stops on crossings, so node tiles stay unambiguous. |
| Metro station | **Changed** from "road or empty" to: tile must have `hasTrack === true` (and be unoccupied). Track is laid first, then the station goes on it — mirroring bus stops on roads. |

### Bulldoze (remove tool) extension

Priority on a clicked tile:

1. Buildings / stops / stations — existing behavior, unchanged (so track can
   never be stripped from under a live station, nor road from under a stop).
2. If the tile is bare and has track → remove the track.
3. Else if the tile is a bare road → revert to `empty`.

A crossing therefore takes two clicks (track first, then road). Scenario
roads are removable exactly like player-laid roads. No refunds (consistent
with existing behavior — nothing refunds today).

### Growth waves

A wave tile converts only if it is still `empty` **and** has no track. If the
player laid road or track there first, the wave skips the tile *and* its
citizen spawns (same spirit as the existing building-occupied citizen skip).
All three scenario waves target initially-empty tiles, so default
playthroughs are unaffected.

## Section 2: Pathfinding and route lifecycle

### Pathfinder

New module `legacy-ts-simulation/network.ts`:

- `findTilePath(map, from, to, mode): Point[] | null` — BFS on the
  4-connected grid. Traversable tiles: `kind === "road"` for bus,
  `hasTrack === true` for metro. Fixed neighbor expansion order (N, E, S, W)
  makes the shortest path fully deterministic. Returns the inclusive tile
  path (from → … → to) or `null`.
- **Endpoint exception (amendment):** the `from` and `to` tiles are always
  traversable regardless of kind/track. Stops and stations can also be
  created via the *building* path (`placeBuilding`), whose footprints sit on
  `empty` tiles — e.g. the e2e flow places Bus Stop buildings beside the
  road, not on it. The endpoint exception lets such a node connect through
  an adjacent network tile; a node with no adjacent road/track simply has no
  path and cannot be added to a route. Building placement additionally
  changes: no building may sit on a track tile, except the Metro Station
  building, whose tile must have track (mirroring the station tool rule).
- `recomputeRoutePaths(state): GameState` — refreshes `segments` and
  `pathBroken` on every route and metro line. Runs after laying/removing
  road or track and after route/line creation. (Stop/station removal already
  cascade-deletes dependent routes — unchanged.)

### Route schema

`Route` and `MetroLine` gain:

- `segments: Point[][]` — `segments[i]` is the tile path from stop *i* to
  stop *i+1*; the final segment closes the loop from the last stop back to
  the first (routes are loops: vehicles wrap via `segmentIndex % stopCount`,
  which stays).
- `pathBroken: boolean` — a route runs only when `active && !pathBroken`.
  Network damage never touches `active`, so re-laying a tile cannot restart
  a route the player manually paused, and the player toggle cannot clear a
  broken path.

### Draft-time validation

In `handleTileClick`:

- Adding a stop/station to a draft is rejected (silent no-op, matching
  existing rejection patterns) unless `findTilePath` succeeds from the
  previous draft stop to the clicked one.
- The path computed at click time is stored in `UiState` as
  `draftStopPaths: Point[][]` / `draftStationPaths: Point[][]` (parallel to
  the existing ID arrays, maintained by the same add/remove/cancel
  operations), so the draft preview follows the network with zero per-frame
  pathfinding.
- Removing a middle draft stop (`removeDraftStop`) merges its two adjacent
  legs into one, which requires a fresh `findTilePath` for the merged pair.
  If no path exists, the removal is rejected (no-op) — the draft invariant
  "every consecutive pair is connected" always holds, and the player can
  still cancel the whole draft. Removing an end stop just drops its single
  leg, no recompute needed.
- The closing loop segment needs no draft validation: paths are undirected,
  so if every consecutive pair connects, all stops share one connected
  component and last → first always has a path. `recomputeRoutePaths` still
  computes it for storage.

### Breaking and restoring routes

- Bulldozing road/track triggers `recomputeRoutePaths`. Any route with an
  unpathable segment gets `pathBroken: true`.
- On the transition to broken: vehicles on the route park at their current
  segment's starting stop; their passengers are force-disembarked there; and
  (reusing the `invalidatePlansForLine` machinery) every citizen whose plan
  references the line is reset to idle, with riding citizens positioned at
  that stop, to replan from where they are.
- Re-laying the missing tile triggers another recompute; if all segments
  path again, `pathBroken` flips to `false` and the route resumes (provided
  the player has not also toggled `active` off).

## Section 3: Movement, rendering, router

### Vehicle movement (`tickVehicles`)

- Distance-based speeds: **bus 0.8 tiles/s, metro 1.6 tiles/s**.
- `progress` remains a 0→1 fraction per segment but increments by
  `speed × deltaSeconds / segmentSteps`, where
  `segmentSteps = segments[i].length − 1`.
- Boarding at `progress === 0`, disembarking at `progress ≥ 1`, and
  `segmentIndex` wrap-around are unchanged.
- Routes with `pathBroken` (or missing segments) do not move; their vehicles
  are parked at the current segment's starting stop.
- This re-times every scenario; determinism-dependent simulation tests get
  updated expectations.

### Rendering

- **Tracks** (`mapRenderer`): on each `hasTrack` tile, draw rail from the
  tile center toward each 4-neighbor that also has track — standard
  connected-tile rendering; crossings need no special casing.
- **Route lines** (`transitRenderer`): polylines through the concatenated
  `segments` tiles instead of straight stop-to-stop lines; the selection
  halo follows the same path.
- **Vehicles**: interpolated along the segment's tile path
  (`progress × segmentSteps` selects the adjacent path-tile pair). Parked at
  the segment start when broken.
- **Draft preview**: dashed line through the stored draft paths.

### Router (`findRoutePlan`)

- Ride-time estimates use actual stored path steps between boarding and
  alighting stops, following the loop forward with wrap (matching how
  vehicles actually travel), divided by the vehicle speed, plus the existing
  flat boarding overheads (90s bus, 120s metro).
- Walk legs stay Manhattan × 20s (walking is unrestricted).
- `pathBroken` routes are excluded from planning, same as inactive ones.

### Error handling

The established idiom holds throughout: every invalid action (placement,
draft click, bulldoze with nothing to remove) returns the same
`GameState`/`UiState` reference so the runtime skips re-render and publish.

## Testing

Mirrors `tests/` ↔ `src/` by domain:

- `tests/simulation/network.test.ts` — BFS shortest path; deterministic
  tie-breaking; no path → `null`; bus vs metro traversability; crossings
  traversable by both.
- `tests/simulation/map.test.ts` — road/track placement and bulldoze rules
  (including the two-click crossing and station/stop protection);
  growth-wave skip rule.
- `tests/simulation/transit.test.ts` — route creation stores segments
  (including closing segment); bulldoze → `pathBroken`, vehicles park,
  passengers disembark and replan; re-lay → route resumes; distance-based
  segment timing.
- `tests/ui/…` — draft click rejected without a connecting path; draft paths
  maintained through add/remove/cancel; new tool selection.
- `tests/simulation/router.test.ts` — estimates from path lengths with
  forward-wrap; broken routes excluded.
- `tests/render/…` — track tiles, path-following route lines, vehicle
  position along path, draft preview.
- Existing simulation tests updated for new vehicle timings and the
  metro-station-requires-track placement rule.

## Out of scope

- Drag-to-paint road/track placement.
- Refunds on bulldoze.
- One-way roads, track capacity, elevated/underground layers.
- Force-disembark behavior for *manually* deactivated routes (pre-existing
  behavior; only `pathBroken` transitions get the new disembark handling).
- Road-aware citizen walking (walking remains free-form Manhattan).

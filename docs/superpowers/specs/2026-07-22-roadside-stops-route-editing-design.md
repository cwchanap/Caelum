# Roadside Stop Access & Route Editing — Design

**Issue:** [HPA-309](https://linear.app/cwchanap/issue/HPA-309) — Fix bus route editing, roadside stops, and dual-lane turning.
**Date:** 2026-07-22
**Status:** Revised 2026-07-23 after three design-review rounds (see "Review revisions" below)

## Context

The heading-aware route editor and road topology introduced by PR #13 (commit `15e1082`) work at the subsystem level, but the player workflow exposes model, integration, and UX gaps around bus stops and route construction. This design covers the complete correction across all five delivery slices identified in the issue: data model + migration, access-constrained routing, draft undo/duplicate suppression, typed diagnostics, and regression tests.

Rust remains the authority for stop placement, road access, topology, route preview, and committed route validation. TypeScript owns draft history, shortcuts, interaction state, and presentation.

### The player-facing bus stop is on-road (issue premise confirmed)

The issue states *"bus stops are currently placed and stored directly on road cells."* **This is correct.** The lightweight `busStop` tool — the only normal bus stop the player can place — goes through a path separate from `place_building`:

- Build menu (`src/domain/catalog/buildMenu.ts`): transit category is `[transitNodeItem("busStop"), buildingItem("busTerminal")]`. The `busStop` *building* catalog entry is never surfaced; the menu uses the `busStop` **tool**.
- Runtime (`src/runtime/createGameRuntime.ts`): `activeTool === "busStop"` produces a `{ type: "addBusStop", point }` intent.
- `transit::add_bus_stop` → `is_valid_bus_stop_placement` **requires `tile.kind == "road"`** and stores `position: *point` (the road tile). (Only `busTerminal`, a 3×2 building via `place_building`, is roadside.)

So the issue's product decision — *"a normal bus stop occupies a non-road roadside cell"* — requires **moving the `busStop` tool off-road** (decision 2). This is a real positional migration of existing on-road stops, not merely "derive an access field."

### Root cause of the dual-road turn failure

`road_topology::compile_automatic_junction_transitions` already emits port-to-port left/right turns between dual carriageways — the junction graph **does** support legal turns. The bug is endpoint resolution, not the graph. Verified: `RoadTopology::find_path` takes bare `Point`s; `start_states` fans an off-road anchor out to **all** adjacent road tiles × all headings; the goal accepts any heading at manhattan distance 1. That unconstrained fan-out across parallel dual carriageways is the wrong-lane binding. The fix is to pin each endpoint to the stop's authoritative access **tile**, eliminating the fan-out — without constraining the heading (revision A).

### Review revisions

**Round 1 (2026-07-22):**
- **A. Pin the tile, not the heading.** `road_point` is the authoritative pin; the heading is preference/display only (a hard heading pin breaks shuttle returns).
- **B. `find_path` must be replaced for bus stops** — a new tile-constrained finder; the graph builder is unchanged.

**Round 2 (2026-07-22):**
- **C/E. Persist access (normalize into the snapshot)** so the TS indicator is authoritative, not resolve-time-only.
- **D/F. Footprint-aware validation; usable-road requirement; checkpoint history; status matrix; structural preview≡commit equality.**
- **G. Turnaround guidance attaches to the producing leg kind.**
- **H. Mutation-result contract; keyboard undo in `App.svelte`.**

**Round 3 (2026-07-23) — premise correction + downstream fixes:**
- **I. Move the `busStop` tool off-road.** `add_bus_stop` is rewritten to require an empty roadside tile with an adjacent usable road; `Stop.position` becomes the roadside anchor, `road_access.road_point` the adjacent road. Existing on-road stops migrate to a roadside anchor (decision 2). This supersedes the first draft's false "stops are already roadside" correction.
- **J. Normalize on the dispatch commit path too**, not only at engine construction — road edits happen via `dispatch`/`tick`, so demolishing a road beside a stop must re-normalize its access immediately (gated on map change, same as the topology recompile).
- **K. Zero-step service legs need a terminal-reversal fallback** — `road_exit_heading`/`road_entry_heading` return `None` on an empty path and the deleted `terminal_reversal_access_points` fallback no longer rescues it; derive the reversal headings from `preferred_heading` (or the nearest non-empty bounding leg) instead.
- **L. `stop_footprint` must be defined** — `Stop` carries only `position`; the footprint lives on `PlacedBuilding.occupied_tiles`. Define a helper (roadside `busStop` → `[position]`; `busTerminal` → associated building's `occupied_tiles`) and pass the footprint into `restore_or_create_node` (called before the building is pushed). Tombstoned stops (no building) are skipped by normalization.
- **M. Housekeeping.** `find_path` becomes **test-only** (its sole production caller is `resolve_service_path`); `find_reversal_between` becomes dead — remove it. `lane_accepts`/`is_road`/`reciprocal_connection` need `pub(crate)`; `orthogonal_neighbors` = `canonical_headings()` + `offset()`. Loop closing-leg rule for RouteEditor = last loop spec (`toWaypointId === waypointIds[0]` when `pattern === "loop"`). Drop the millisecond-quantization hedge (paths share `build_road_path`; integer millis → exact deterministic equality).

**Round 4 (2026-07-23) — implementation-contract gaps:**
- **N. Migration needs a real entry point.** `GameEngine::new()`/`reset()` build only the initial (empty) snapshot; `WasmGameEngine` exposes no load method. Add `GameEngine::from_snapshot(snapshot)` (compile topology + run stop-access migration) and expose it through the wasm/Tauri hosts; the runtime uses it whenever loading a non-initial snapshot.
- **O. Dependent-state contract for moving `Stop.position`.** `position` feeds passenger routing, boarding, and coordinate-keyed occupancy; vehicles use `road_access.road_point`; route/platform assignments remain id-based while waiter indexes are coordinate-keyed and must migrate with waiting trips; active trips retarget to the new position; saved routes reference waypoint IDs (stable).
- **P. Typed resolution result.** The finder/reversal return `Result`/failure reason, not `Option`, so the §5 matrix is actually producible (distinguish NoLegalEntryHeading / NetworkDisconnected / NoLegalTurnaround).
- **Q. History is owned by the runtime, not reducers.** Reducers are pure `(draft, action) → { draft, notice?, previewRequested }`; the controller records checkpoints and manages past/future. (Supersedes the `history?`-in-mutation shape.)
- **R. Fallback + None-heading edge cases.** `is_valid_access` permits `road_point == anchor` (distance 0, degenerate on-road fallback); the zero-step terminal fallback picks a deterministic heading from `road_point` when `preferred_heading` is `None`, else returns the corresponding typed entry/exit-heading failure.
- **S. TS view threading.** `RouteLegPath.failureReason` flows through selectors into `RouteEditorView`/`RouteFailureRow`; loop-closing vs terminal-reversal context derived from `leg.kind` + `pattern` for guidance.

## Decisions (confirmed in brainstorming; revised after four reviews)

1. **Scope:** all five delivery slices in one spec.
2. **Placement model — move the `busStop` tool off-road (revision I).** The player-facing `busStop` tool is relocated from road tiles to roadside cells: `add_bus_stop` is rewritten to require an empty, unoccupied roadside tile with at least one adjacent usable road. `Stop.position` becomes the roadside anchor (an empty cell); `road_access.road_point` is the adjacent road; `preferred_heading` is auto-picked (N,E,S,W order) and shown via an indicator. No two-step gesture. `busTerminal` (already roadside via `place_building`) keeps the footprint-based derivation.
3. **Migration & staleness — positional migration, no schema bump (revisions C/E/I/N).** `roadAccess` is a `#[serde(default)] Option<StopRoadAccess>` on `Stop`; stay on v2. Add an explicit `GameEngine::from_snapshot(snapshot)` load entry point: it normalizes legacy **on-road** stops, compiles topology, and returns the engine that hosts use for non-initial snapshots. Each legacy stop moves to an adjacent empty, unoccupied, non-node roadside cell, picked in N,E,S,W order; its original road tile becomes `road_access.road_point`. If no roadside cell is available, it stays on-road with `road_point == position` as a supported degenerate fallback. Access is re-normalized on the **dispatch commit path** whenever the map changes (revision J), and at placement/restore — so the TS indicator is authoritative mid-session. Resolve re-derives only as a defensive fallback. Migration explicitly rebases dependent passenger/trip state; vehicles remain on the road access tile and saved routes remain ID-based (revision O).

## Architecture — two forks

### Routing fork

**Chosen — pin endpoints to the access *tile*.** Each service leg's endpoints become the stop's authoritative `road_point` (one specific tile). A new tile-constrained finder seeds start states only from that tile's `RoadState`s (preferred heading ranked first) and accepts the goal only at the destination tile. This kills the across-parallel-roads fan-out (the dual-road bug) while leaving both travel directions of a two-way road servable, so shuttle returns still work. The graph/topology builder is unchanged — legal junction turns already exist.

*Rejected — hard-pin to one lifelong `RoadState` heading.* Breaks shuttle return legs on ordinary bidirectional roads (revision A).
*Rejected — synthetic stop-access graph nodes.* More invasive, no payoff: the bus never occupies a separate node.

### Undo fork

**Chosen — immutable checkpoint stack.** `RouteDraftHistory { past, future }` of `RouteDraftCheckpoint`s — a `Pick` of the topology/selection fields, **not** the full draft (so stale `preview`/`generation` are never restored). Redo is free; compound ops need no inverse logic.

*Rejected — inverse-action log.* Correctness is hard for compound operations and redo requires forward replay.

## Section 1 — Data model & wire format

### Rust (`crates/caelum-core/src/model.rs`)

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopRoadAccess {
    pub road_point: Point,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preferred_heading: Option<Heading>,
}

// Stop gains an optional access field:
#[serde(default, skip_serializing_if = "Option::is_none")]
pub road_access: Option<StopRoadAccess>,
```

`Point` and `Heading` are already `Copy + Eq + Hash + Serialize + Deserialize`, so `StopRoadAccess` derives everything cheaply.

**Semantics (revision A).** `road_point` is the authoritative pin — the one road tile the bus must occupy while serving this stop; routing constrains the endpoint to that tile. `preferred_heading` is **not** a constraint: it is a display/ranking hint (the indicator arrow direction and the tie-break order the finder uses when several `RoadState`s at that tile are reachable). Both travel directions of a two-way `road_point` remain servable, so shuttle return legs that approach from the opposite heading still resolve. `preferred_heading` is `Option<Heading>`; `None` means "no preference."

### TypeScript (`src/domain/types.ts`)

```typescript
export interface StopRoadAccess {
  roadPoint: Point;
  preferredHeading?: Heading;
}

export interface Stop {
  id: string;
  kind: StopKind;
  status: TransitNodeStatus;
  position: Point;
  roadAccess?: StopRoadAccess; // new, optional
  platforms: Platform[];
}
```

**No schema bump.** Per decision 3, `roadAccess` is optional and normalized into the snapshot (placement, restore, `GameEngine::from_snapshot`, dispatch commit). `Station` (metro) is unchanged — metro already uses track paths and has no road access concept. `RouteLegPath` also gains `failureReason?` (§5).

## Section 2 — Placement & deterministic access selection

There are two placement paths and both now produce a roadside anchor + an explicit access:

- **`busStop` tool → `transit::add_bus_stop`** (revision I): the player-facing lightweight stop, **relocated off-road**.
- **`busTerminal` → `buildings::place_building`**: the 3×2 building (already roadside), footprint-based.

### New module `crates/caelum-core/src/stop_access.rs`

```rust
/// Derive access for a roadside anchor (an empty/off-road tile): scan its
/// orthogonal neighbors for the first usable bare road tile.
pub fn derive_stop_access(map: &GameMap, anchor: Point) -> Option<StopRoadAccess>
/// Derive access for a multi-tile footprint (busTerminal): union of orthogonal
/// neighbors of every footprint tile, in footprint-then-N,E,S,W order.
pub fn derive_stop_access_for_footprint(map: &GameMap, footprint: &[Point]) -> Option<StopRoadAccess>
/// Resolve the footprint a stop's access must stay adjacent to.
/// busStop -> [position]; busTerminal -> associated building's occupied_tiles.
pub fn stop_footprint(snapshot: &GameSnapshot, stop: &Stop) -> Vec<Point>
```

**Candidate road tiles** — usable bare road tiles (`kind == "road" && road_structure_id.is_none()` **and** at least one heading `h` with `lane_accepts(one_way, h)` **and** `reciprocal_connection(map, tile, h)`; automatic-junction/roundabout footprint tiles are excluded). For `busStop`, scan the anchor's neighbors N,E,S,W; for `busTerminal`, the union over all footprint tiles. The **first** candidate becomes `road_point`.

`preferred_heading` (best-effort display/ranking hint, never a constraint): first `h` (N,E,S,W) where `lane_accepts(one_way,h) && road_connections.contains(h)`; else first `h` where `lane_accepts(one_way,h)`; else `None`.

### `add_bus_stop` rewrite (revision I)

`is_valid_bus_stop_placement` is inverted: it now requires the clicked tile to be a **roadside anchor** — an **empty** tile (not road), unoccupied by a building, not already a transit node, `road_structure_id.is_none()`, with **at least one adjacent usable road** (`derive_stop_access(map, point).is_some()`). `add_bus_stop` stores `position: *point` (the roadside anchor) and `road_access: derive_stop_access(map, *point)`. Rejections: `OutOfBounds`; `RoadRequired` is replaced — on-road clicks now fail with `NoRoadAccess` (no adjacent usable road) or `BlockedTile` (occupied/non-empty). `BUS_STOP_COST` is unchanged.

### `place_building` (`busTerminal`)

`can_place_building` for `busTerminal` additionally requires `derive_stop_access_for_footprint(map, &occupied_tiles).is_some()`, else `NoRoadAccess`. `place_building_core` stores the derived `road_access` on the new `Stop`. (The unused `busStop` building-catalog entry stays dead — the tool path is `add_bus_stop`.)

**Tombstone restore (`restore_or_create_node`)** is passed the footprint (revision F/L — it is called before the building is pushed, and is shared with metro) and re-derives/installs access for the current footprint; a terminal rebuilt with a different rotation gets a fresh access. `busStop` restore uses `[anchor]`. Tombstoned stops have no building → `stop_footprint` falls back to `[position]`; normalization skips `Missing` stops entirely (they aren't routed).

### Migration of existing on-road stops (revisions I/N)

`GameEngine::from_snapshot(snapshot)` is the concrete legacy-snapshot entry point. It runs the migration before compiling the cached topology and before the first `snapshot()` is exposed by the WASM/Tauri host. The same normalization helper is re-run on the dispatch commit path when the map changes (revision J). Normalize every `Present` stop:

1. If `position` is a **road tile** (legacy on-road stop): pick a roadside anchor — the first orthogonal neighbor (N,E,S,W) that is an empty, unoccupied, non-node tile — and set `position` to it; set `road_access.road_point` to the **original** road tile (preserving the served lane). If no roadside neighbor is free, leave `position` on the road with `road_access.road_point == position` (degenerate fallback, still servable and explicitly supported by `is_valid_access`).
2. If `position` is already roadside but `road_access` is missing or fails `is_valid_access` (road demolished / one-way flipped / tile swallowed): re-derive via `derive_stop_access`/`derive_stop_access_for_footprint`.

This is a real positional change to existing snapshots (stop `position`s move off the road), so e2e/fixture assertions on stop coordinates and `MovementKind[]` paths must be updated (§6). It stays on schema v2 — no reject-old-saves.

### Dependent-state contract for `Stop.position` (revision O)

`Stop.position` is the **passenger coordinate**: the roadside cell where citizens walk, wait, board conceptually, and where the stop is rendered. `StopRoadAccess.road_point` is the **vehicle coordinate**: buses remain on road geometry there for path steps, boarding/disembark geometry, and parking/rebase. A migration must not move a vehicle to the roadside anchor.

- **Active trips:** before changing a legacy stop's position, record the old-to-new coordinate map by stop id. Retarget any active trip's stop-bound passenger destination/origin, `position` when it is waiting at that stop, and the corresponding route-plan leg endpoints from the old road coordinate to the new roadside coordinate. Do not rewrite a citizen's home/workplace merely because it happens to share the old coordinate; a walking trip's current position is not teleported unless it is the stop-bound waiting coordinate.
- **Vehicles:** update `route_lifecycle::present_node_world` and parking/rebase helpers so bus waypoints resolve to `road_access.road_point` (metro continues to use station position). Preserve `parked_position`/road movement on that road coordinate; route lifecycle rebasing remains keyed by waypoint ids and recomputes vehicle itinerary/path indexes against normalized route legs. A parked bus must never be rebased onto `Stop.position`.
- **Platforms and occupancy:** route/platform assignments remain keyed by node/platform ids, but waiter lookup is currently coordinate-keyed (`platforms::platform_index`, `platform_waiter_ids`, and the TS `platformOccupancy` mirror). Updating both `Stop.position` and any waiting trip's passenger coordinate keeps those indexes consistent; add a regression test for migrated waiting passengers. No platform-id migration is needed.
- **Saved routes:** routes reference waypoint ids, not positions. Their legs are re-resolved after migration against the normalized stop access; no route-id or waypoint-id rewrite is performed.
- **Tombstones:** `Missing` stops have no passenger/vehicle activity to rebase and are skipped by normalization. When restored, the new placement supplies the current anchor/footprint and access.

### TypeScript mirror (`src/render/placementValidation.ts` + `createGameRuntime.ts`)

The `busStop` tool's hover validation flips to require an **empty** tile with an adjacent bare road (was: a road tile). `createGameRuntime.ts` keeps emitting `addBusStop`; the Rust side now interprets it as a roadside placement. `busTerminal` hover matches the footprint version.

### Rendering indicator

The transit renderer draws a small arrow from the stop's `position` (roadside) toward `roadAccess.roadPoint` along `preferredHeading`. Z-order: map < buildings < access indicator < transit handles/preview.

## Section 3 — Access-constrained routing (`network.rs` + `road_topology.rs`)

### Access resolution & normalization (revisions C/E/F/I/J/N)

Access is **normalized into the snapshot** so the wire field is authoritative for both routing and the TS indicator — at load *and* mid-session:

- **At placement / tombstone restore:** `road_access` is derived for the current footprint and stored on the `Stop` (§2).
- **At `GameEngine::from_snapshot(snapshot)` (revision N):** run the migration + re-derivation pass — legacy on-road stops move to a roadside anchor (revision I), and any stop whose `road_access` is `None` or fails `is_valid_access` is re-derived and written back. Compile the candidate map's topology only after migration, then expose the normalized snapshot through the host's first `snapshot()` call. `GameEngine::new()` remains the initial-scenario constructor; it is not the legacy-load hook.
- **On the dispatch commit path (revision J):** road edits happen via `dispatch`/`tick`, not construction, so a stop whose neighbor road was demolished/flipped/swallowed would otherwise keep a stale persisted field (and a wrong indicator) until next load. The engine's `commit_network_mutation` computes `map_changed = before.map != candidate.map`; when true, it normalizes stop access and dependent passenger state before route recomputation, then compiles/reuses topology and commits the normalized candidate. This keeps the wire field correct mid-session.
- **At resolve (defensive):** `stop_access` trusts stored access when valid and re-derives otherwise. With the commit-path normalize this is a no-op in practice.

The new load boundary is explicit:

```rust
impl GameEngine {
    pub fn from_snapshot(snapshot: GameSnapshot) -> GameplayResult<Self> {
        let snapshot = normalize_snapshot_stops(snapshot)?;
        let road_topology = RoadTopology::compile(&snapshot.map)?;
        Ok(Self { snapshot, road_topology })
    }
}
```

`normalize_snapshot_stops` performs the positional migration, dependent-state rebase, and access normalization described in §2. `WasmGameEngine` and the Tauri managed-state loader expose/use this constructor for non-initial snapshots; `new()` remains the fresh-scenario constructor. The first host snapshot is therefore already normalized, and no TS-only approximation of road topology is permitted.

```rust
/// Resolve a stop waypoint to its authoritative access tile + preferred heading.
fn stop_access(snapshot: &GameSnapshot, stop_id: &str) -> Option<StopRoadAccess> {
    let stop = snapshot.transit.stops.iter().find(|s| s.id == stop_id)?;
    let footprint = stop_footprint(snapshot, stop);   // [position] for busStop, building tiles for terminal
    match stop.road_access {
        Some(access) if is_valid_access(&snapshot.map, &footprint, &access) => Some(access),
        _ => derive_stop_access_for_footprint(&snapshot.map, &footprint),
    }
}

/// road_point is a bare, usable road tile AND either orthogonally adjacent to
/// the stop's CURRENT footprint or equal to the single-tile position of the
/// supported legacy on-road fallback. preferred_heading is not re-validated.
fn is_valid_access(map: &GameMap, footprint: &[Point], access: &StopRoadAccess) -> bool {
    let still_bare_usable = map.tile(access.road_point).is_some_and(|t| {
        t.kind == "road" && t.road_structure_id.is_none()
            && canonical_headings().any(|h| {
                lane_accepts(t.one_way, h) && reciprocal_connection(map, access.road_point, h)
            })
    });
    let adjacent_to_footprint = footprint
        .iter()
        .any(|p| canonical_headings().any(|h| offset(*p, h) == access.road_point));
    let legacy_on_road_fallback = footprint.len() == 1
        && footprint[0] == access.road_point
        && map.tile(access.road_point).is_some_and(|t| t.kind == "road");
    still_bare_usable && (adjacent_to_footprint || legacy_on_road_fallback)
}
```

### New tile-constrained finder (revision B)

`RoadTopology` gains a finder that pins endpoints to specific **tiles** rather than fanning out across all adjacent roads:

```rust
impl RoadTopology {
    /// Route between two specific access tiles. Start states are seeded ONLY
    /// from `from_tile`'s RoadStates (preferred heading ranked first); the goal
    /// is accepted ONLY at `to_tile` (any reachable heading; preferred first
    /// for tie-breaking). No fan-out to other adjacent tiles.
    pub fn find_path_between_access_tiles(
        &self,
        map: &GameMap,
        from_tile: Point,
        to_tile: Point,
        from_preferred: Option<Heading>,
        to_preferred: Option<Heading>,
    ) -> Result<TransitPath, LegFailureReason>
}
```

Implementation is `deterministic_dijkstra` with two changes: `start_states` is replaced by `road_start_states(topology, from_tile)` only (no off-road neighbor scan), and the goal test becomes `state.position == to_tile` (with `movement_count > 0`, as today). The preferred headings only affect ranking/tie-breaking among otherwise-equal states, never feasibility. The typed propagation rules are explicit: empty start states return `Err(NoLegalEntryHeading)`; a non-empty search that exhausts without reaching `to_tile` returns `Err(NetworkDisconnected)`; a successful search returns `Ok(path)`.

**Shared-access-tile / positive-movement rule (revision E, 2nd-review P1).** When two stops share the same `road_point` (`from_tile == to_tile`) — e.g. roadside cells on opposite sides of one road tile — the bus is already at the goal `RoadState`, so the leg is a **deliberate zero-step service leg** (connected, 0 s). This is distinct from the `movement_count > 0` guard, which exists to reject an *untraversed* goal on a seeded start tile. The finder returns the zero-step path only when `from_tile == to_tile` (a legitimate same-tile serve); for `from_tile != to_tile` the `movement_count > 0` guard is preserved exactly as today, so a goal is never accepted without a real traversal.

The existing `find_path(map, &Point, &Point)` had exactly one production caller (`resolve_service_path`); after this change it is **test-only** (the ~26 remaining call sites are integration tests). Prefer migrating those tests to `find_path_between_access_tiles` and removing it; if retained temporarily for fixture coverage, keep it as a `#[doc(hidden)]` public compatibility helper rather than `#[cfg(test)]` (integration tests do not compile the library with the dependency's test cfg). It must never be used by production routing. `find_reversal_between` becomes dead (no caller, no test) — **remove it**.

### Service legs

`resolve_service_path` / `resolve_leg` resolve each waypoint via `stop_access(...)` and call `find_path_between_access_tiles(&snapshot.map, from.road_point, to.road_point, from.preferred_heading, to.preferred_heading)`. `waypoint_position` is retained only for presence/missing-node detection (`RouteLegStatus::MissingNode`). The `Result` error is copied into `RouteLegPath.failure_reason`; `current_path`/`last_valid_path` remain `None` for a newly failed leg and the coarse status becomes `NetworkDisconnected`.

### Terminal reversal

`resolve_terminal_reversal` operates at the terminal stop's single `road_point`. Arrival and departure tile are the same (one access per stop), so the reversal is in-place:

```rust
RoadTopology::find_terminal_reversal(
    access_tile,
    exit_heading,
    entry_heading,
) -> Result<TransitPath, LegFailureReason>
```

where `exit_heading`/`entry_heading` come from `road_exit_heading`/`road_entry_heading` (`.last()`/`.first()` of the bounding legs' road steps). **Zero-step bounding-leg fallback (revisions K/R):** those helpers return `None` when a bounding service leg is a deliberate zero-step (two stops sharing one `road_point`), and the old `terminal_reversal_access_points` degenerate branch that rescued this is deleted. For a missing heading, first use the terminal's `preferred_heading`; if it is `None`, choose the first deterministic heading (N,E,S,W) with a usable transition at the access tile. If no such heading exists, return the corresponding typed `NoLegalExitHeading` or `NoLegalEntryHeading` error. Otherwise the heading is **not** pinned, so a shuttle's return leg naturally arrives on the opposite heading and the terminal reversal performs the real heading change.

The reversal finder classifies failures instead of collapsing them to `None`: no transition can leave the access tile with `exit_heading` → `NoLegalExitHeading`; no transition can reach the access tile with `entry_heading` → `NoLegalEntryHeading`; both endpoint headings are available but the finite reversal search cannot connect them → `NoLegalTurnaround`. `resolve_leg` copies that error into `RouteLegPath.failure_reason`.

**Remove** `terminal_reversal_access_points`, `shared_service_access_tile`, and (unused) `find_reversal_between` — the "scan all adjacent roads" fallback was the source of the wrong-lane binding. Existing tests that relied on multi-access corners are rewritten as explicit dual-stop / dual-lane fixtures (§6).

### Preview ≡ commit invariant

Both `preview::preview_route` and `route_lifecycle` route creation/revision **must** call the same `network::resolve_route_legs` (already true). The regression test asserts the preview path and committed path are **structurally equal** (revision D/M): same leg keys (`from`/`to`/`direction`/`kind`) and per-leg equal road-step `position`/`entering_heading`/`leaving_heading`/`movement`, with `total_travel_seconds` compared by **exact** equality (both paths are built by the same `build_road_path` from identical integer `travel_millis`, so the `f64` is deterministic — no quantization needed).

## Section 4 — Draft undo + duplicate suppression (TypeScript)

### History (`src/ui/routeDraft.ts` + `src/ui/uiState.ts`)

History stores **checkpoints**, not full drafts, so a stale `preview` or `generation` is never restored (revision D):

```typescript
export type RouteDraftCheckpoint = Pick<
  RouteDraft,
  "waypointIds" | "pattern" | "selectedIndex" | "interaction" | "mode" | "source"
>;

export interface RouteDraftHistory {
  past: RouteDraftCheckpoint[];   // most-recent last
  future: RouteDraftCheckpoint[]; // redo stack, most-recent last
}
```

Held in `UiState` alongside the active `RouteDraft`. A checkpoint is a small `Pick` of topology + selection fields.

**Meaningful mutations** push the pre-mutation checkpoint onto `past` and clear `future`:

- append waypoint
- insert waypoint
- replace waypoint (where the id actually changes)
- remove waypoint
- reorder waypoint
- reverse direction
- service-pattern change (loop ↔ shuttle)

**Selection-only changes** (e.g. `selectWaypoint`) do **not** push history. **History is cleared** on `cancelRouteDraft`, successful save, `startRouteEdit`, and mode switch.

### Mutation-result contract (revisions H/Q)

The current reducer contract is too narrow: `applyNodeClick` returns `RouteDraftClickResult { draft, rejection }` only (`routeDraft.ts`), and a reducer that accepts only a draft cannot preserve an existing `past`/`future` stack. **The runtime/controller owns history.** Reducers remain pure and do not receive or return history:

```typescript
export interface RouteDraftMutation {
  draft: RouteDraft;                 // post-mutation draft (=== input for strict no-ops)
  notice?: { kind: "alreadyOnRoute"; waypointId: string }; // transient; omitted when n/a
  previewRequested: boolean;         // false for strict no-ops (duplicate suppression)
}
```

`applyNodeClick` / `applyRouteNodeClick` (and the keyboard-driven reducers) return `RouteDraftMutation`. For every meaningful action, the runtime first records `checkpoint(currentDraft)` in `history.past`, clears `history.future`, then applies the reducer result. A strict no-op returns the same draft reference with `previewRequested: false`; the runtime does not touch history or request a preview. Undo/redo are the only operations that consume/push `past`/`future` and restore checkpoints. The runtime surfaces `notice` in `UiState` and auto-clears it on the next meaningful action, undo, or redo.

### View surface

The route-editor view model gains (so Svelte can bind disabled states and the notice without reaching into internals):

- `canUndo: boolean` (`history.past.length > 0`)
- `canRedo: boolean` (`history.future.length > 0`)
- `notice: { kind: "alreadyOnRoute"; waypointId: string } | null`
- `failures: RouteFailureRow[]` (typed preview-leg failures, including `legKind`, `isLoopClosing`, and shared guidance)

These are added to the route-editor slice of `ShellState`/`RouteEditorView` and threaded through the HUD like the existing route-draft fields.

### Undo / redo

```typescript
undo(): if past non-empty → push checkpoint(current) to future, pop past → restore into draft;
        generation++; clear preview; request fresh authoritative preview.
redo(): symmetric (future → past).
```

The generation bump + preview clear is mandatory: undo restores topology only, then demands a fresh authoritative preview so Rust revalidates against the (possibly edited) snapshot. The `notice` clears on undo/redo and on the next meaningful mutation.

### Bindings & focus rules (revision H)

Controller methods `undoRouteDraft()` / `redoRouteDraft()` on `RuntimeController` remain the single entry for Svelte buttons and key handlers.

- **Keyboard (location):** undo/redo keys are handled in `App.svelte`'s existing `handleWindowKeydown` (`<svelte:window onkeydown=...>`) — **not** the canvas host. That handler already early-returns on `metaKey`/`ctrlKey`/`altKey`/`isTextInput(target)`, so the Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z (or Cmd/Ctrl+Y) branches are added **before** that early-return, with their own `isTextInput(target)` focus check (route-draft undo never steals a text field's native undo). Delete/Backspace → `removeWaypoint` follows the same focus rule and is added alongside.
- **Right-click / context-menu:** the canvas host attaches a `contextmenu` listener that calls `undoRouteDraft()` while a route draft is active and suppresses the browser menu only in that mode; it must not interfere with canvas drag-cancel (verify during impl). `actions.ts` remains the click/drag dispatch layer.

A visible **Undo** action in `RouteEditor.svelte`, disabled when `!canUndo`; paired **Redo**, disabled when `!canRedo`. Optional stack cap (e.g. 100) is fine.

### Duplicate suppression (on the real reducers — revision D)

Clicks flow `applyRouteNodeClick → applyNodeClick`; duplicate suppression must live on those shared reducers (the public mutation entry points), not only on `appendWaypoint` (which is mostly tests). "All draft mutations that add/replace ids" apply the rules below:

| Action | Condition | Result |
|---|---|---|
| append | `id === waypointIds[last]` | strict no-op (`===` draft, no generation bump, no preview) |
| append | `id` already present elsewhere | **select** that existing waypoint; no mutation, no history |
| replace(i, id) | `waypointIds[i] === id` | strict no-op |
| replace(i, id) | `id` exists at another index `j` | **select** index `j`; no mutation, no history |
| insert(i, id) | `id` already present | no mutation, no history, surface transient **"Already on this route"** notice |

The append→select / insert→notice asymmetry is **intentional** and matches the issue spec ("clicking a stop already on the route while appending selects/highlights"; "inserting an already-used stop … shows a subtle 'Already on this route' message"). Rust duplicate validation remains the final invariant (unchanged in `route_lifecycle`).

The no-op contract is testable: assert the returned `RouteDraft` is `===` the input, `generation` unchanged, and no preview requested.

## Section 5 — Diagnostics & unified hit testing

### Typed leg diagnostics (Rust)

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LegFailureReason {
    NoRoadAccess,
    NetworkDisconnected,
    NoLegalEntryHeading,
    NoLegalExitHeading,
    NoLegalTurnaround,
}
```

The internal routing APIs use the same typed failure enum instead of `Option`:

```rust
type TransitPathResult = Result<TransitPath, LegFailureReason>;

fn resolve_service_path(...) -> TransitPathResult;
fn resolve_terminal_reversal(...) -> TransitPathResult;
```

`resolve_leg` handles missing/tombstoned waypoints before calling either function, maps `None` from `stop_access` to `NoRoadAccess`, and copies any `Err(reason)` into `RouteLegPath.failure_reason`. Add `failure_reason: Option<LegFailureReason>` to `RouteLegPath` (`#[serde(default)]`, so old snapshots/fixtures deserialize to `None`). The coarse `RouteLegStatus` is retained and **derived** from `failure_reason` (revision D/P — explicit matrix):

| Situation | `failure_reason` | `RouteLegStatus` |
|---|---|---|
| a waypoint id is absent or tombstoned | `None` | `MissingNode` |
| leg resolves (path found) | `None` | `Connected` |
| a present waypoint has no derivable access tile | `NoRoadAccess` | `NetworkDisconnected` |
| **service leg:** the *from* access tile has no usable start `RoadState` (bus cannot legally occupy that tile in any heading) | `NoLegalEntryHeading` | `NetworkDisconnected` |
| **service leg:** Dijkstra exhausts (the *to* tile is unreachable, or has no `RoadState`s at all — the goal is **not** required to have outbound transitions) | `NetworkDisconnected` | `NetworkDisconnected` |
| **terminal reversal:** no transition carries the required exit heading off the access tile | `NoLegalExitHeading` | `NetworkDisconnected` |
| **terminal reversal:** no transition arrives with the required entry heading | `NoLegalEntryHeading` | `NetworkDisconnected` |
| **terminal reversal:** no multi-step reversal path between exit and entry headings | `NoLegalTurnaround` | `NetworkDisconnected` |

The Entry/Exit naming is scoped to where headings are genuinely constrained: the *origin* of a service leg (must be enterable) and the *terminal reversal* (specific exit then entry headings). The *destination* of a service leg is never failed for lacking an exit heading — only for being unreachable (`NetworkDisconnected`), per the reviewer's correction.

### TS presentation

The wire field is threaded end-to-end (revision S): Rust `RouteLegPath.failureReason` → `normalizeRouteLegPath` (default `null` for old fixtures) → `runtimeSelectors` → `RouteEditorView.failures` and `ShellRouteListItem.failures`/`RouteFailureRow` → `RouteEditor.svelte`, `ManagePanel.svelte`, and `overlayRenderer.ts`. Extend the current coarse `RouteFailureRow.reason` union with `noRoadAccess`, `networkDisconnected`, `noLegalEntryHeading`, `noLegalExitHeading`, and `noLegalTurnaround`; retain `missingNode` for tombstones. Each row also carries `legKind`, `isLoopClosing`, and a resolved `guidance` string so every consumer uses the same context.

```typescript
interface RouteFailureRow {
  legIndex: number;
  fromWaypointId: string;
  toWaypointId: string;
  reason: "missingNode" | LegFailureReason;
  legKind: RouteLegKind;
  isLoopClosing: boolean;
  guidance: string;
  /** Present only when reason is "missingNode": the kind of the missing
   * waypoint(s) — "station" if either endpoint is a missing station, otherwise
   * "stop". */
  missingNodeKind?: "stop" | "station";
}
```

`RouteEditor.svelte`, `ManagePanel.svelte`, and `render/overlayRenderer.ts` render the failed leg with the typed reason and actionable guidance (revision G/S — guidance attaches to the leg kind and pattern context that can actually produce it):

- `NoRoadAccess` → "Stop has no adjacent road."
- `NoLegalTurnaround` (occurs **only on Shuttle terminal-reversal legs** — `loop_specs` emits no such legs) → "No legal U-turn here; add a junction or roundabout." (Not "switch to Shuttle" — a Shuttle route is already Shuttle.)
- `NetworkDisconnected` on a **Loop closing service leg** (the `last → first` wrap) → "Loop can't close here; remove a stop or switch to **Shuttle**." (This is the only place "switch to Shuttle" is offered — Shuttle has no closing leg.)
- `NetworkDisconnected` elsewhere → "Roads not connected between these stops."
- `NoLegalEntryHeading` / `NoLegalExitHeading` → "Road direction doesn't allow serving this stop here."

`rejectionMessages.ts` gains a `noRoadAccess` placement message. The editor never silently flips Loop↔Shuttle; it only *suggests* Shuttle for a failed Loop closing leg.

**Loop closing-leg identification (revision M):** RouteEditor treats a leg as the "closing leg" iff `pattern === "loop"` and `leg.toWaypointId === waypointIds[0]` (equivalently, the last spec from `loop_specs`). Only that leg offers the Shuttle suggestion.

The selector computes `isLoopClosing` using that rule and computes terminal-reversal context from `leg.kind === "terminalReversal"`; `RouteEditorView` exposes `failures` for the active preview and `RouteFailureRow[]` for persisted/manage-route failures. `previewMessage` remains the coarse summary, while `guidance` is the typed per-leg message rendered by all three surfaces.

### Unified hit testing (TS)

One footprint-aware resolver — the existing `resolveStopAtTile` (`routeDraft.ts`) — is used for **add, inspect, and select**. Route-handle selection currently uses only the exact node anchor; it is switched to the shared footprint-aware path so multi-tile `busTerminal` footprints resolve consistently across all three interactions.

## Section 6 — Tests

### Rust

- **`tests/dual_road_routing.rs` (new):** via normal `GameIntent` calls — (1) draw intersecting dual-bidirectional roads; (2) assert the automatic-junction footprint and ports; (3) place stops on differently-oriented approaches; (4) preview and save a route; (5) assert the path's road steps **contain the specific junction turn tiles** (assert concrete `position`/`movement` values, not just "a left turn exists") and never enter a lane wrong-way; (6) **Shuttle terminal reversal:** a paired road with no legal turnaround fails the **terminal-reversal leg** with `NoLegalTurnaround`, then succeeds after adding a junction/roundabout; (6b) **Loop closing leg:** a Loop whose `last→first` wrap is impossible fails that **service** leg with `NetworkDisconnected` (the leg "suggest Shuttle" attaches to); (7) **shuttle return-leg regression:** a shuttle A→B→C on an ordinary two-way road resolves both outbound and return legs (the heading-unpinned fix).
- **`tests/transit_build.rs` (extend):** `add_bus_stop` now requires an **empty roadside** tile with an adjacent usable road; rejects an on-road click and a no-adjacent-road empty cell (`NoRoadAccess`); rejects an isolated road; stores `position` = roadside anchor and `road_access.road_point` = adjacent road (`preferred_heading` populated). `busTerminal` with road only along the far edge derives access from the non-origin footprint neighbor. A tombstoned terminal rebuilt with a different rotation installs the freshly-derived access.
- **`tests/stop_migration.rs` (new, revisions I/N/O):** build a legacy snapshot, call `GameEngine::from_snapshot`, and assert each on-road stop migrates to a deterministic roadside anchor, `road_access.road_point` remains the original road tile, active trip passenger endpoints retarget while homes/workplaces do not, vehicles remain parked on road geometry, and routes still resolve on the same lane. A stop with no free roadside neighbor falls back to on-road with `road_point == position` and passes `is_valid_access`.
- **`tests/route_editing.rs` (extend):** preview path ≡ committed path via **structural equality** (leg keys + road-step `position`/`entering_heading`/`leaving_heading`/`movement` + exact `total_travel_seconds`), not bytes. Stale `road_access` (road demolished / one-way flipped / tile swallowed) is re-normalized **on the dispatch commit path** (not only on construction) and the route resolves or fails with the correct typed reason. Shared-access-tile (two stops, one `road_point`) yields a zero-step connected leg; a Shuttle whose end leg is that zero-step still resolves its terminal reversal (preferred-heading or deterministic-transition fallback). Finder/reversal unit tests assert `Err(NoLegalEntryHeading)`, `Err(NetworkDisconnected)`, `Err(NoLegalExitHeading)`, and `Err(NoLegalTurnaround)` at their respective boundaries.
- **`tests/model_wire_format.rs` (extend):** `Stop` with and without `roadAccess` round-trips; missing field deserializes to `None`; `RouteLegPath` with and without `failureReason` round-trips.

### TypeScript

- **`tests/ui/routeDraft.test.ts` (extend):** reducers return `RouteDraftMutation` without history; the runtime/controller owns the stacks. Duplicate clicks are no-ops on the real reducers (`applyRouteNodeClick`/`applyNodeClick`) — assert `===` draft, `generation` unchanged, `previewRequested === false`, and the runtime leaves history unchanged; append-of-existing selects the existing waypoint; insert-of-existing surfaces the `alreadyOnRoute` notice without mutating; undo/redo restore checkpoints and bump generation; **`selectWaypoint` does not push history**; history is cleared on cancel/save/startEdit/mode switch.
- **`tests/ui/appShell.test.ts` (extend, revision H):** `handleWindowKeydown` dispatches Cmd/Ctrl+Z → undo and Cmd/Ctrl+Shift+Z/Y → redo **only when no text input is focused** (assert it does not fire when an `<input>`/`<textarea>` has focus); Delete/Backspace removes the selected waypoint under the same focus rule.
- **A canvas `contextmenu` test:** right-click while a route draft is active calls `undoRouteDraft()` and suppresses the browser menu; outside route-draft mode it does not.
- **`tests/render/placementValidation.test.ts` (extend):** the `busStop` tool requires an **empty** tile with an adjacent bare road (was: a road tile); `busTerminal` requires a bare-road neighbor of the full footprint.
- **`tests/runtime/gameRuntime.test.ts` (extend):** end-to-end preview≡commit identity through the runtime/backend boundary (structural equality); the published snapshot's stops carry normalized `roadAccess` (indicator has data); a roadside `busStop` placement flows through `addBusStop`.
- **`tests/runtime/runtimeSelectors.test.ts` (extend, revision S):** typed `failureReason`, `legKind`, `isLoopClosing`, and shared guidance flow into `RouteEditorView.failures` and `RouteFailureRow`; old legs without `failureReason` normalize to the coarse missing/disconnected behavior.
- **`tests/ui/hudPanels.test.ts` (extend, revision S):** ManagePanel and RouteEditor render the same typed guidance as the overlay for Loop closing and Shuttle terminal-reversal failures.
- **`tests/render/overlayRenderer.test.ts` (extend):** failed-leg overlay renders the typed reason + correct guidance (Shuttle-reversal → infrastructure; Loop closing leg → suggest Shuttle); access indicator renders toward `roadPoint`.
- **`tests/e2e/routes.spec.ts` (update, revision I):** the existing fixture places a stop on a road tile (`{9,4}` on `y=4`); rewrite to place the stop on the roadside cell beside the road, and relax/update any `MovementKind[]` assertions affected by the relocated anchor.
- Test fixtures under `tests/fixtures/` and `tests/helpers/gameState.ts` updated for the new `roadAccess`/`failureReason` fields and roadside stop positions.

## Acceptance criteria mapping

| Criterion | Section |
|---|---|
| Stop rendered on a roadside cell, never on the road | §2 rev I (`add_bus_stop` relocated off-road + migration) |
| Every stop has an explicit authoritative serving road access | §1, §2, §3 (`road_point` is the pin) |
| Route can legally turn through an auto-generated dual-road intersection | §3 (tile pin kills the fan-out) |
| Route never crosses paired lanes mid-block or enters a one-way lane wrong-way | §3 (tile-constrained finder + `is_valid_access`) |
| Shuttle return legs still resolve on ordinary two-way roads (no heading over-pin) | §1 rev A, §3 (heading is preference only) |
| Turnaround failure explained | §3, §5 (`NoLegalTurnaround`) |
| Preview and committed paths are identical | §3, §6 (structural equality) |
| Right-click and Cmd/Ctrl+Z undo one meaningful operation and refresh preview | §4 |
| Repeatedly clicking the same stop adds no duplicate, no history, no generation, no preview | §4 |
| Route-node hit testing consistent across add/inspect/edit | §5 |
| Existing on-road snapshots migrate to roadside deterministically; stale access re-normalizes after road edits (mid-session) | §2 rev I, §3 rev J (construction + dispatch commit) |
| Stop migration preserves passenger coordinates, waiting occupancy, vehicle road positions, and ID-based route state | §2 rev O, §6 |
| Rust workspace tests and frontend tests pass | §6 |

## Primary files

### Rust
- `crates/caelum-core/src/model.rs` — `StopRoadAccess { road_point, preferred_heading }`, `LegFailureReason`, `Stop.road_access`, `RouteLegPath.failure_reason`.
- `crates/caelum-core/src/stop_access.rs` — **new** `derive_stop_access` / `derive_stop_access_for_footprint` / `stop_footprint` / `is_valid_access` (footprint-aware, reciprocal-connection usability).
- `crates/caelum-core/src/transit.rs` — **rewrite `add_bus_stop`/`is_valid_bus_stop_placement`** off-road (revision I); store `position`=anchor + `road_access`.
- `crates/caelum-core/src/buildings.rs` — `busTerminal` placement validation (footprint + usability) + storing access.
- `crates/caelum-core/src/engine.rs` — `GameEngine::from_snapshot` migration entry point (revision N); dependent-state rebasing; stop-access normalization on load and on the dispatch commit path gated on map change (revision J/O), alongside topology compilation.
- `crates/caelum-core/src/road_topology.rs` — **new** `find_path_between_access_tiles -> Result`; **remove** `find_reversal_between`; `find_path` becomes test-only (revision M/P).
- `crates/caelum-core/src/network.rs` — access-aware endpoint resolution via typed finder/reversal results; `stop_access` defensive fallback; remove `terminal_reversal_access_points` + `shared_service_access_tile`; deterministic `preferred_heading`/transition fallback (revision K/R); populate `failure_reason`.
- `crates/caelum-core/src/router.rs`, `crates/caelum-core/src/platforms.rs`, `crates/caelum-core/src/transit.rs`, `crates/caelum-core/src/trips.rs` — passenger/boarding coordinates follow roadside `Stop.position`; waiter indexes migrate with active trips; bus vehicle/world/parking logic uses `road_access.road_point`.
- `crates/caelum-core/src/route_lifecycle.rs` — `present_node_world` and parked-vehicle rebasing use bus road access rather than passenger position.
- `crates/caelum-core/src/transit_nodes.rs` — tombstone restore takes the footprint and **re-derives/installs** access (revision F/L).
- `crates/caelum-core/src/road.rs`, `crates/caelum-core/src/road_topology.rs` — `pub(crate)` for `lane_accepts`, `is_road`, `reciprocal_connection` (revision M).
- `crates/caelum-core/src/rejection.rs` — `NoRoadAccess` code.
- `crates/caelum-core/tests/dual_road_routing.rs`, `crates/caelum-core/tests/stop_migration.rs` — **new**.
- `crates/caelum-core/tests/transit_build.rs`, `route_editing.rs`, `model_wire_format.rs` — extend.

### TypeScript / Svelte
- `src/domain/types.ts` — `StopRoadAccess`, `LegFailureReason`, `Stop.roadAccess`, `RouteLegPath.failureReason`, extend `RejectionCode` union with `"noRoadAccess"`.
- `src/ui/routeDraft.ts` — `RouteDraftMutation` result contract, checkpoint history, undo/redo, duplicate suppression on `applyNodeClick`/`applyRouteNodeClick`.
- `src/ui/uiState.ts` — `RouteDraftHistory`, `RouteDraftCheckpoint`, `alreadyOnRoute` notice.
- `src/runtime/types.ts`, `src/runtime/createGameRuntime.ts`, `src/runtime/runtimeSelectors.ts` — runtime-owned `RouteDraftHistory`; `RuntimeController.undoRouteDraft()`/`redoRouteDraft()`; `canUndo`/`canRedo`/`notice`; typed `RouteFailureRow`/`RouteEditorView.failures` (revision Q/S).
- `src/App.svelte` — keyboard undo/redo/Delete in `handleWindowKeydown` (focus-guarded).
- `src/runtime/createCanvasHost.ts` — `contextmenu` listener → undo in route-draft mode (revision H). `src/ui/actions.ts` remains click/drag dispatch.
- `src/runtime/backend/types.ts`, `src/runtime/backend/shared.ts`, `src/runtime/snapshotView.ts` (+ WASM/Tauri load wrappers) — `failureReason` / `roadAccess` round-trip, old-field defaults, and the `from_snapshot` load boundary.
- `src/runtime/rejectionMessages.ts` — `noRoadAccess` message.
- `src/render/placementValidation.ts` — `busStop` tool hover now requires an **empty** tile + adjacent bare road; `busTerminal` full-footprint neighbor check.
- `src/domain/platformOccupancy.ts` — migrated waiting-trip coordinates remain aligned with stop-position occupancy indexes.
- `src/render/overlayRenderer.ts` + transit renderer — access indicator (defined z-order), failed-leg overlay + shared typed guidance.
- `src/components/hud/panels/RouteEditor.svelte`, `ManagePanel.svelte` — Undo/Redo actions (disabled binding), notice, typed failure/guidance presentation.
- `tests/ui/routeDraft.test.ts`, `tests/ui/appShell.test.ts`, `tests/ui/hudPanels.test.ts`, `tests/runtime/gameRuntime.test.ts`, `tests/runtime/runtimeSelectors.test.ts`, `tests/render/overlayRenderer.test.ts`, `tests/render/placementValidation.test.ts`, `tests/e2e/routes.spec.ts`, `tests/fixtures/*`, `tests/helpers/gameState.ts` — extend/update.

## Out of scope

- No change to metro routing (track paths).
- No new graph edges / topology **builder** changes — the existing port-to-port junction transitions already support legal turns. (A new *finder* is added, but the compiled graph is untouched.)
- No two-step lane-picking gesture (deferred; a "cycle serving lane" action can be added later if auto-pick proves insufficient).
- No schema-version bump — old v2 snapshots with on-road stops migrate in-place to roadside anchors through `GameEngine::from_snapshot` and the dispatch normalize pass (decision 3). There is no separate offline migration tool.

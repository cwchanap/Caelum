# Roadside Stop Access & Route Editing — Design

**Issue:** [HPA-309](https://linear.app/cwchanap/issue/HPA-309) — Fix bus route editing, roadside stops, and dual-lane turning.
**Date:** 2026-07-22
**Status:** Revised 2026-07-22 after design review (see "Review revisions" below)

## Context

The heading-aware route editor and road topology introduced by PR #13 (commit `15e1082`) work at the subsystem level, but the player workflow exposes model, integration, and UX gaps around bus stops and route construction. This design covers the complete correction across all five delivery slices identified in the issue: data model + migration, access-constrained routing, draft undo/duplicate suppression, typed diagnostics, and regression tests.

Rust remains the authority for stop placement, road access, topology, route preview, and committed route validation. TypeScript owns draft history, shortcuts, interaction state, and presentation.

### Correction to the issue's premise

The issue states *"bus stops are currently placed and stored directly on road cells."* This is **inaccurate**. `buildings::can_place_building` (`crates/caelum-core/src/buildings.rs:132`) already requires `tile.kind == "empty"` for `busStop`, and `Stop.position` is set to the roadside `origin` (`buildings.rs:252`). Stops are *already* on roadside cells.

The real gap is the **missing explicit road access**: routing scans adjacent roads unconstrainedly (`network::terminal_reversal_access_points`, bare `waypoint_position`), which causes wrong-lane binding and the dual-road turn failures. Migration is therefore *"derive and persist a road access for stops already roadside,"* not *"move stops off roads."*

### Root cause of the dual-road turn failure

`road_topology::compile_automatic_junction_transitions` already emits port-to-port left/right turns between dual carriageways — the junction graph **does** support legal turns. The bug is endpoint resolution, not the graph. Verified: `RoadTopology::find_path` takes bare `Point`s (`road_topology.rs`); `start_states` fans an off-road anchor out to **all** adjacent road tiles × all headings; the goal accepts any heading at manhattan distance 1. That unconstrained fan-out across parallel dual cariageways is the wrong-lane binding. The fix is to pin each endpoint to the stop's authoritative access **tile**, eliminating the fan-out — without constraining the heading (see Review revision A).

### Review revisions (2026-07-22)

A design review caught two blocking defects and several gaps in the first draft. The revisions below are incorporated into the sections that follow:

- **A. Pin the tile, not the heading.** The draft pinned both endpoints of every leg to one lifelong `RoadState { road_point, serving_heading }`. That breaks shuttle returns on ordinary two-way roads: a mid-block stop pinned to `East` cannot be reached westbound on the return leg (`shuttle_specs` emits real return legs needing the opposite heading). `road_point` is the authoritative pin; the heading is preference/display only.
- **B. `find_path` must be replaced for bus stops.** "Dijkstra unchanged" was wrong — `find_path(map, &Point, &Point)` fans out across all adjacent roads. A new tile-constrained finder is required (`road_topology.rs` is now a touched file).
- **C. Stale `road_access` after road edits.** A stored access can point at a demolished road, a swallowed structure tile, or a flipped one-way forever. The access is normalized into the snapshot (revision E supersedes the earlier "resolve-time no-mutate" wording).
- **D. History checkpoints, not full drafts; real reducers; status matrix; multi-tile terminal access; structural preview≡commit equality.** See §4/§5.
- **E (2nd review). Persist access so the UI indicator is authoritative.** Resolve-time-only derivation can't feed the TS indicator (migrated stops would show no arrow; stale stops would show a tile Rust no longer routes through). Access is now **normalized into the snapshot** at engine construction and at placement/restore, so the wire field is always authoritative. Resolve validates defensively but is no longer the sole supplier.
- **F (2nd review). Validate access against the stop footprint, not just bare-road.** `is_valid_access` requires `road_point` to be orthogonally adjacent to the stop's *current* footprint; tombstone restore installs the access derived for the new placement (a terminal rebuilt with a different rotation must not keep a now-dangling road_point). "Legal road access" at placement requires a *usable* road tile (≥1 servable heading with a reciprocal neighbor), not merely a bare road tile.
- **G (2nd review). Turnaround guidance attaches to the right leg kind.** `NoLegalTurnaround` only occurs on Shuttle terminal-reversal legs (Loop itineraries have none), so its guidance is "add turnaround infrastructure," not "switch to Shuttle." The "switch to Shuttle" suggestion attaches to a failed Loop *closing service leg*.
- **H (2nd review). Mutation result carries notice/history; keyboard lives in App.svelte.** `applyNodeClick` returns `{ draft, rejection }` only today — extend the reducer contract to carry notice/history; `canUndo`/`canRedo`/notice join the view model; keyboard undo is wired in `App.svelte`'s existing `handleWindowKeydown` (which already has the `isTextInput` focus guard), not the canvas host.

## Decisions (confirmed in brainstorming; revised after two reviews)

1. **Scope:** all five delivery slices in one spec.
2. **Access selection UX:** auto-pick deterministically (fixed tile order, then N,E,S,W heading order) at placement, render a visible indicator. No two-step gesture. **The pin is the tile (`road_point`); the heading is preference/display only** (revision A).
3. **Migration & staleness:** add `roadAccess` as a `#[serde(default)] Option<StopRoadAccess>` on `Stop`. **No schema bump** (stay on v2). Access is **normalized into the snapshot** — derived+stored at placement, at tombstone restore, and on `GameEngine` construction for any stop whose access is missing or invalid against the live map (revisions E/F). Resolve re-derives only as a defensive fallback. The wire field is the authoritative source for both routing and the TS indicator.

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

**No schema bump.** Per decision 3, `roadAccess` is optional and lazily (re)derived at resolve time. `Station` (metro) is unchanged — metro already uses track paths and has no road access concept. `RouteLegPath` also gains `failureReason?` (§5).

## Section 2 — Placement & deterministic access selection

### New module `crates/caelum-core/src/stop_access.rs`

```rust
/// Deterministically derive the authoritative road access for a stop.
/// `road_point` is the pin; `preferred_heading` is a display/ranking hint.
/// Returns None when no adjacent legal road access exists.
pub fn derive_stop_access(map: &GameMap, anchor: Point) -> Option<StopRoadAccess>
pub fn derive_stop_access_for_footprint(map: &GameMap, footprint: &[Point]) -> Option<StopRoadAccess>
```

**Candidate tiles** — the set of orthogonal neighbors that are *usable* bare road tiles, scanned in a deterministic order:

- `busStop` (1×1): neighbors of the single anchor cell, in N, E, S, W order.
- `busTerminal` (3×2, revision D): the union of orthogonal neighbors of **every** footprint tile. Deterministic order: iterate footprint tiles in their emitted order, and within each tile scan N, E, S, W; dedup. This handles a terminal whose only adjacent road runs along the far edge (the `origin` cell alone would miss it). `Stop.position` stays as `origin` (the passenger anchor); only `road_point` may come from a non-origin footprint neighbor.

The **first** candidate tile (in that order) becomes `road_point`. Then `preferred_heading`:

1. first heading `h` (N, E, S, W) where `lane_accepts(one_way, h)` **and** `road_connections.contains(h)` — the bus can pass straight through (the usual mid-block direction); else
2. first `h` where `lane_accepts(one_way, h)` — terminus / must-turn; else
3. `None`.

**`preferred_heading` is best-effort.** It ranks otherwise-equal goal states and drives the indicator arrow; it never reduces the servable heading set. A heading with no graph transitions is harmless — the finder simply falls back to the other reachable headings on `road_point`.

**Usable-road requirement (revision F).** A candidate qualifies only if it is a *usable* road tile, not merely bare road:

- bare road: `kind == "road" && road_structure_id.is_none()` (automatic-junction/roundabout footprint tiles are excluded — those are served through their ports via normal graph edges); **and**
- at least one heading `h` where `lane_accepts(one_way, h)` **and** `reciprocal_connection(map, road_point, h)` — the neighbor in direction `h` is a road that connects back, so a compiled `RoadState` transition will exist there. This is a cheap local adjacency check (`road::reciprocal_connection`), no full topology compile.

This prevents an isolated road from passing placement and then immediately producing `NoLegalEntryHeading`. (If only a non-reciprocal heading exists the tile is a true dead-end with no legal entry/exit and is rejected as `NoRoadAccess`.)

### Placement integration (`buildings.rs`)

- `can_place_building` adds a new validation branch for `busStop`/`busTerminal`: after the existing footprint checks, derive the access (`derive_stop_access` for 1×1, `derive_stop_access_for_footprint` for terminals); reject with `RejectionCode::NoRoadAccess` (new code) when it returns `None` or the candidate is not *usable*. This enforces *"at least one adjacent legal, usable road access exists."*
- `place_building_core` stores the derived `road_access` on the new `Stop`.
- **Tombstone restore (`restore_or_create_node`) re-derives and installs access for the new placement** (revision F): a terminal rebuilt at the same origin but a different rotation has a different footprint, and a previously-valid `road_point` may no longer be adjacent. Restore must not preserve a stale field; it installs the access derived for the *current* footprint. (Same anchor + footprint re-derives identically, so identity is preserved for unchanged restores.)
- Removal (`remove_or_tombstone_node`) is unchanged — `road_access` is part of the `Stop`, carried by tombstones and dropped on garbage-collection.

### TypeScript mirror (`src/render/placementValidation.ts`)

`canPlaceBuilding` for `busStop`/`busTerminal` additionally requires at least one orthogonal neighbor (of the **full footprint** for terminals) to be a bare road tile, so hover validation matches Rust (optimistic-only parity, same as today; the reciprocal-connection usability check is Rust-side authoritative).

### Rendering indicator

The transit/building renderer draws a small arrow from the stop's `position` toward `roadAccess.roadPoint` along `preferredHeading`, making the bound lane visible (decision 2). The arrow renders above the road layer but below route-preview handles so it stays readable (z-order: map < buildings < access indicator < transit handles/preview). Exact art handled in implementation; a short stub arrow is the minimum.

## Section 3 — Access-constrained routing (`network.rs` + `road_topology.rs`)

### Access resolution & normalization (revisions C/E/F)

Access is **normalized into the snapshot** so the wire field is authoritative for both routing and the TS indicator:

- **At placement / tombstone restore:** `road_access` is derived for the current footprint and stored on the `Stop` (§2).
- **At `GameEngine` construction:** any stop whose `road_access` is `None` **or** fails `is_valid_access` is re-derived (against its current footprint) and written back into the snapshot. This runs once on load, so old v2 snapshots and stops affected by road edits converge to a valid, persisted access on the first snapshot the host publishes.
- **At resolve (defensive):** `stop_access` trusts the stored access when still valid and re-derives otherwise. Because construction already normalized, this fallback should be a no-op in practice — it exists to guarantee correctness if a snapshot reaches routing without normalization.

```rust
/// Resolve a stop waypoint to its authoritative access tile + preferred heading.
fn stop_access(snapshot: &GameSnapshot, stop_id: &str) -> Option<StopRoadAccess> {
    let stop = snapshot.transit.stops.iter().find(|s| s.id == stop_id)?;
    let footprint = stop_footprint(snapshot, stop);           // [origin] for busStop, full for terminal
    match stop.road_access {
        Some(access) if is_valid_access(&snapshot.map, &footprint, &access) => Some(access),
        _ => derive_stop_access_for_footprint(&snapshot.map, &footprint),
    }
}

/// road_point is still a bare, usable road tile AND is orthogonally adjacent to
/// the stop's CURRENT footprint. preferred_heading is not re-validated (a hint).
/// Footprint-adjacency catches a terminal rebuilt with a different rotation whose
/// old road_point is no longer touching the footprint.
fn is_valid_access(map: &GameMap, footprint: &[Point], access: &StopRoadAccess) -> bool {
    let still_bare_usable = map.tile(access.road_point).is_some_and(|t| {
        t.kind == "road" && t.road_structure_id.is_none()
            && canonical_headings().any(|h| {
                lane_accepts(t.one_way, h) && reciprocal_connection(map, access.road_point, h)
            })
    });
    let adjacent_to_footprint = footprint
        .iter()
        .any(|p| orthogonal_neighbors(*p).contains(&access.road_point));
    still_bare_usable && adjacent_to_footprint
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
    ) -> Option<TransitPath>
}
```

Implementation is `deterministic_dijkstra` with two changes: `start_states` is replaced by `road_start_states(topology, from_tile)` only (no off-road neighbor scan), and the goal test becomes `state.position == to_tile` (with `movement_count > 0`, as today). The preferred headings only affect ranking/tie-breaking among otherwise-equal states, never feasibility.

**Shared-access-tile / positive-movement rule (revision E, 2nd-review P1).** When two stops share the same `road_point` (`from_tile == to_tile`) — e.g. roadside cells on opposite sides of one road tile — the bus is already at the goal `RoadState`, so the leg is a **deliberate zero-step service leg** (connected, 0 s). This is distinct from the `movement_count > 0` guard, which exists to reject an *untraversed* goal on a seeded start tile. The finder returns the zero-step path only when `from_tile == to_tile` (a legitimate same-tile serve); for `from_tile != to_tile` the `movement_count > 0` guard is preserved exactly as today, so a goal is never accepted without a real traversal.

The existing `find_path(map, &Point, &Point)` is **kept** for any non-stop caller and for metro (metro uses `find_track_path`, unaffected). Bus service legs stop calling it.

### Service legs

`resolve_service_path` / `resolve_leg` resolve each waypoint via `stop_access(...)` and call `find_path_between_access_tiles(from.road_point, to.road_point, from.preferred_heading, to.preferred_heading)`. `waypoint_position` is retained only for presence/missing-node detection (`RouteLegStatus::MissingNode`).

### Terminal reversal

`resolve_terminal_reversal` operates at the terminal stop's single `road_point`. Arrival and departure tile are the same (one access per stop), so the reversal is in-place:

```rust
RoadTopology::find_terminal_reversal(access_tile, exit_heading, entry_heading)
```

`exit_heading` / `entry_heading` are derived from the bounding service legs' last/first road-step headings (as today). Because the heading is **not** pinned, a shuttle's return leg naturally arrives on the opposite heading and the terminal reversal performs the real heading change (no zero-step no-op unless the headings genuinely match). `find_reversal_between` is retained in `RoadTopology` but unused by stop-based terminals under the single-access model.

**Remove** `terminal_reversal_access_points` and `shared_service_access_tile` (the "scan all adjacent roads" fallback) — the source of the wrong-lane binding. Existing tests that relied on multi-access corners are rewritten as explicit dual-stop / dual-lane fixtures (§6).

### Preview ≡ commit invariant

Both `preview::preview_route` and `route_lifecycle` route creation/revision **must** call the same `network::resolve_route_legs` (already true). The regression test asserts the preview path and committed path are **structurally equal** (revision D): same leg keys (`from`/`to`/`direction`/`kind`) and per-leg equal road-step `position`/`entering_heading`/`leaving_heading`/`movement`, with `travel_seconds` compared quantized to the millisecond. Raw serde bytes / `f64` equality would flake and are not used.

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

### Mutation-result contract (revision H)

The current reducer contract is too narrow: `applyNodeClick` returns `RouteDraftClickResult { draft, rejection }` only (`routeDraft.ts`), with no slot to distinguish an insert-duplicate notice from another strict no-op, and history lives elsewhere. Reducers that mutate the draft return a richer result:

```typescript
export interface RouteDraftMutation {
  draft: RouteDraft;                 // post-mutation draft (=== input for strict no-ops)
  history?: RouteDraftHistory;       // new history when a checkpoint was pushed/cleared; omitted otherwise
  notice?: { kind: "alreadyOnRoute"; waypointId: string }; // transient; omitted when n/a
  previewRequested: boolean;         // false for strict no-ops (duplicate suppression)
}
```

`applyNodeClick` / `applyRouteNodeClick` (and the keyboard-driven mutations) return `RouteDraftMutation`. Strict no-ops return `{ draft: sameRef, previewRequested: false }` with no `history`/`notice`. The runtime/controller consumes this: it applies `history` to `UiState`, surfaces `notice` (auto-clearing), and only requests a preview when `previewRequested`.

### View surface

The route-editor view model gains (so Svelte can bind disabled states and the notice without reaching into internals):

- `canUndo: boolean` (`history.past.length > 0`)
- `canRedo: boolean` (`history.future.length > 0`)
- `notice: { kind: "alreadyOnRoute"; waypointId: string } | null`

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

Add `failure_reason: Option<LegFailureReason>` to `RouteLegPath` (`#[serde(default)]`, so old snapshots/fixtures deserialize to `None`). It is populated in `network::resolve_leg`. The coarse `RouteLegStatus` is retained and **derived** from `failure_reason` (revision D — explicit matrix):

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

`RouteEditor.svelte` and `render/overlayRenderer.ts` render the failed leg with the typed reason and actionable guidance (revision G — guidance attaches to the leg kind that can actually produce it):

- `NoRoadAccess` → "Stop has no adjacent road."
- `NoLegalTurnaround` (occurs **only on Shuttle terminal-reversal legs** — `loop_specs` emits no such legs) → "No legal U-turn here; add a junction or roundabout." (Not "switch to Shuttle" — a Shuttle route is already Shuttle.)
- `NetworkDisconnected` on a **Loop closing service leg** (the `last → first` wrap) → "Loop can't close here; remove a stop or switch to **Shuttle**." (This is the only place "switch to Shuttle" is offered — Shuttle has no closing leg.)
- `NetworkDisconnected` elsewhere → "Roads not connected between these stops."
- `NoLegalEntryHeading` / `NoLegalExitHeading` → "Road direction doesn't allow serving this stop here."

`rejectionMessages.ts` gains a `noRoadAccess` placement message. The editor never silently flips Loop↔Shuttle; it only *suggests* Shuttle for a failed Loop closing leg.

### Unified hit testing (TS)

One footprint-aware resolver — the existing `resolveStopAtTile` (`routeDraft.ts`) — is used for **add, inspect, and select**. Route-handle selection currently uses only the exact node anchor; it is switched to the shared footprint-aware path so multi-tile `busTerminal` footprints resolve consistently across all three interactions.

## Section 6 — Tests

### Rust

- **`tests/dual_road_routing.rs` (new):** via normal `GameIntent` calls — (1) draw intersecting dual-bidirectional roads; (2) assert the automatic-junction footprint and ports; (3) place stops on differently-oriented approaches; (4) preview and save a route; (5) assert the path's road steps **contain the specific junction turn tiles** (assert concrete `position`/`movement` values, not just "a left turn exists") and never enter a lane wrong-way; (6) **Shuttle terminal reversal:** a paired road with no legal turnaround fails the **terminal-reversal leg** with `NoLegalTurnaround`, then succeeds after adding a junction/roundabout; (6b) **Loop closing leg:** a Loop whose `last→first` wrap is impossible fails that **service** leg with `NetworkDisconnected` (the leg "suggest Shuttle" attaches to); (7) **shuttle return-leg regression:** a shuttle A→B→C on an ordinary two-way road resolves both outbound and return legs (the heading-unpinned fix).
- **`tests/transit_build.rs` (extend):** placement requires *usable* road access (reciprocal connection); rejects an isolated road and a no-adjacent-road cell (`NoRoadAccess`); stores the correct `road_access` (`road_point` deterministic, `preferred_heading` populated); `busTerminal` placed with road only along the far edge derives access from the non-origin footprint neighbor; a tombstoned terminal rebuilt with a different rotation installs the freshly-derived access (no dangling road_point); engine construction normalizes a stop with missing/invalid access into the snapshot.
- **`tests/route_editing.rs` (extend):** preview path ≡ committed path via **structural equality** (leg keys + road-step `position`/`entering_heading`/`leaving_heading`/`movement` + millis quantized to 1 ms), not bytes. Also: a stop whose stored `road_access` is stale (road demolished / one-way flipped / tile swallowed by a structure) is re-normalized on engine construction and the route resolves or fails with the correct typed reason. Shared-access-tile (two stops, one `road_point`) yields a zero-step connected leg.
- **`tests/model_wire_format.rs` (extend):** `Stop` with and without `roadAccess` round-trips; missing field deserializes to `None`; `RouteLegPath` with and without `failureReason` round-trips.

### TypeScript

- **`tests/ui/routeDraft.test.ts` (extend):** reducers return `RouteDraftMutation`; duplicate clicks are no-ops on the real reducers (`applyRouteNodeClick`/`applyNodeClick`) — assert `===` draft, `generation` unchanged, `previewRequested === false`, no history push; append-of-existing selects the existing waypoint; insert-of-existing surfaces the `alreadyOnRoute` notice without mutating; undo/redo restore checkpoints and bump generation; **`selectWaypoint` does not push history**; history is cleared on cancel/save/startEdit/mode switch.
- **`tests/ui/appShell.test.ts` (extend, revision H):** `handleWindowKeydown` dispatches Cmd/Ctrl+Z → undo and Cmd/Ctrl+Shift+Z/Y → redo **only when no text input is focused** (assert it does not fire when an `<input>`/`<textarea>` has focus); Delete/Backspace removes the selected waypoint under the same focus rule.
- **A canvas `contextmenu` test:** right-click while a route draft is active calls `undoRouteDraft()` and suppresses the browser menu; outside route-draft mode it does not.
- **`tests/render/placementValidation.test.ts` (extend):** `canPlaceBuilding` for busStop/busTerminal requires a bare-road neighbor (full footprint for terminals).
- **`tests/runtime/gameRuntime.test.ts` (extend):** end-to-end preview≡commit identity through the runtime/backend boundary (structural equality); the published snapshot's stops carry normalized `roadAccess` (indicator has data).
- **`tests/render/overlayRenderer.test.ts` (extend):** failed-leg overlay renders the typed reason + correct guidance (Shuttle-reversal → infrastructure; Loop closing leg → suggest Shuttle); access indicator renders toward `roadPoint`.
- Test fixtures under `tests/fixtures/` and `tests/helpers/gameState.ts` updated for the new `roadAccess`/`failureReason` fields.

## Acceptance criteria mapping

| Criterion | Section |
|---|---|
| Stop rendered on a roadside cell, never on the road | §1, §2 (already roadside; now has access) |
| Every stop has an explicit authoritative serving road access | §1, §2, §3 (`road_point` is the pin) |
| Route can legally turn through an auto-generated dual-road intersection | §3 (tile pin kills the fan-out) |
| Route never crosses paired lanes mid-block or enters a one-way lane wrong-way | §3 (tile-constrained finder + `is_valid_access`) |
| Shuttle return legs still resolve on ordinary two-way roads (no heading over-pin) | §1 rev A, §3 (heading is preference only) |
| Turnaround failure explained | §3, §5 (`NoLegalTurnaround`) |
| Preview and committed paths are identical | §3, §6 (structural equality) |
| Right-click and Cmd/Ctrl+Z undo one meaningful operation and refresh preview | §4 |
| Repeatedly clicking the same stop adds no duplicate, no history, no generation, no preview | §4 |
| Route-node hit testing consistent across add/inspect/edit | §5 |
| Existing snapshots migrate deterministically; stale access re-derives after road edits | §1, §3 (normalize on construction + placement/restore) |
| Rust workspace tests and frontend tests pass | §6 |

## Primary files

### Rust
- `crates/caelum-core/src/model.rs` — `StopRoadAccess { road_point, preferred_heading }`, `LegFailureReason`, `Stop.road_access`, `RouteLegPath.failure_reason`.
- `crates/caelum-core/src/stop_access.rs` — **new** `derive_stop_access` / `derive_stop_access_for_footprint` / `is_valid_access` (footprint-aware, reciprocal-connection usability).
- `crates/caelum-core/src/buildings.rs` — placement validation (incl. terminal footprint + usability) + storing access.
- `crates/caelum-core/src/engine.rs` — normalize stop access into the snapshot on `GameEngine` construction (revision E).
- `crates/caelum-core/src/road_topology.rs` — **new** `find_path_between_access_tiles` (finder only; compile/builder unchanged; preserves `movement_count > 0`, deliberate zero-step for shared tile).
- `crates/caelum-core/src/network.rs` — access-aware endpoint resolution via the new finder; `stop_access` defensive validate-on-resolve; remove `terminal_reversal_access_points` + `shared_service_access_tile`; populate `failure_reason`.
- `crates/caelum-core/src/transit_nodes.rs` — tombstone restore **re-derives and installs** access for the current footprint.
- `crates/caelum-core/src/rejection.rs` — `NoRoadAccess` code.
- `crates/caelum-core/tests/dual_road_routing.rs` — **new**.
- `crates/caelum-core/tests/transit_build.rs`, `route_editing.rs`, `model_wire_format.rs` — extend.

### TypeScript / Svelte
- `src/domain/types.ts` — `StopRoadAccess`, `LegFailureReason`, `Stop.roadAccess`, `RouteLegPath.failureReason`, extend `RejectionCode` union with `"noRoadAccess"`.
- `src/ui/routeDraft.ts` — `RouteDraftMutation` result contract, checkpoint history, undo/redo, duplicate suppression on `applyNodeClick`/`applyRouteNodeClick`.
- `src/ui/uiState.ts` — `RouteDraftHistory`, `RouteDraftCheckpoint`, `alreadyOnRoute` notice.
- `src/runtime/types.ts`, `src/runtime/createGameRuntime.ts`, `src/runtime/runtimeSelectors.ts` — `RuntimeController.undoRouteDraft()`/`redoRouteDraft()`; `canUndo`/`canRedo`/`notice` in the route-editor view model.
- `src/App.svelte` — keyboard undo/redo/Delete in `handleWindowKeydown` (focus-guarded).
- `src/runtime/createCanvasHost.ts` — `contextmenu` listener → undo in route-draft mode (revision H). `src/ui/actions.ts` remains click/drag dispatch.
- `src/runtime/backend/types.ts` (+ wire mappers if not pure structural serde) — `failureReason` / `roadAccess` round-trip.
- `src/runtime/rejectionMessages.ts` — `noRoadAccess` message.
- `src/render/placementValidation.ts` — road-access hover mirror (full footprint for terminals).
- `src/render/overlayRenderer.ts` + transit renderer — access indicator (defined z-order), failed-leg overlay + guidance.
- `src/components/hud/panels/RouteEditor.svelte` — Undo/Redo actions (disabled binding), notice, Loop-closing-leg Shuttle suggestion, Shuttle-reversal infrastructure suggestion.
- `tests/ui/routeDraft.test.ts`, `tests/ui/appShell.test.ts`, `tests/runtime/gameRuntime.test.ts`, `tests/render/overlayRenderer.test.ts`, `tests/render/placementValidation.test.ts`, `tests/fixtures/*`, `tests/helpers/gameState.ts` — extend.

## Out of scope

- No change to metro routing (track paths).
- No new graph edges / topology **builder** changes — the existing port-to-port junction transitions already support legal turns. (A new *finder* is added, but the compiled graph is untouched.)
- No two-step lane-picking gesture (deferred; a "cycle serving lane" action can be added later if auto-pick proves insufficient).
- Access is normalized into the snapshot (placement, restore, engine construction) so the wire field is authoritative — but there is no separate offline migration tool or schema-version bump; old v2 snapshots converge on first load via the construction normalize pass.

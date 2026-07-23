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
- **C. Stale `road_access` after road edits.** A stored access can point at a demolished road, a swallowed structure tile, or a flipped one-way forever. Resolve-time validate-and-rederive (no mutate) replaces the contradictory "lazy on engine load" wording.
- **D. History checkpoints, not full drafts; real reducers; status matrix; multi-tile terminal access; structural preview≡commit equality.** See §4/§5.

## Decisions (confirmed in brainstorming; revised after review)

1. **Scope:** all five delivery slices in one spec.
2. **Access selection UX:** auto-pick deterministically (fixed tile order, then N,E,S,W heading order) at placement, render a visible indicator. No two-step gesture. **The pin is the tile (`road_point`); the heading is preference/display only** (revision A).
3. **Migration & staleness:** add `roadAccess` as a `#[serde(default)] Option<StopRoadAccess>` on `Stop`. **No schema bump** (stay on v2). Missing or *stale* access is lazily (re)derived **at resolve time** by validating the stored access against the live map (revision C) — not mutated into the snapshot at engine load.

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

**Candidate tiles** — the set of orthogonal neighbors that are bare road tiles, scanned in a deterministic order:

- `busStop` (1×1): neighbors of the single anchor cell, in N, E, S, W order.
- `busTerminal` (3×2, revision D): the union of orthogonal neighbors of **every** footprint tile. Deterministic order: iterate footprint tiles in their emitted order, and within each tile scan N, E, S, W; dedup. This handles a terminal whose only adjacent road runs along the far edge (the `origin` cell alone would miss it). `Stop.position` stays as `origin` (the passenger anchor); only `road_point` may come from a non-origin footprint neighbor.

The **first** candidate tile (in that order) becomes `road_point`. Then `preferred_heading`:

1. first heading `h` (N, E, S, W) where `lane_accepts(one_way, h)` **and** `road_connections.contains(h)` — the bus can pass straight through (the usual mid-block direction); else
2. first `h` where `lane_accepts(one_way, h)` — terminus / must-turn; else
3. `None`.

**`preferred_heading` is best-effort.** It ranks otherwise-equal goal states and drives the indicator arrow; it never reduces the servable heading set. A heading with no graph transitions is harmless — the finder simply falls back to the other reachable headings on `road_point`.

**Bare-road-tile restriction.** A stop may not bind to an automatic-junction or roundabout footprint tile — those are served through their ports via normal graph edges. Only `kind == "road" && road_structure_id.is_none()` qualifies as `road_point`.

### Placement integration (`buildings.rs`)

- `can_place_building` adds a new validation branch for `busStop`/`busTerminal`: after the existing footprint checks, derive the access (`derive_stop_access` for 1×1, `derive_stop_access_for_footprint` for terminals); reject with `RejectionCode::NoRoadAccess` (new code) when it returns `None`. This enforces *"at least one adjacent legal road access exists."*
- `place_building_core` stores the derived `road_access` on the new `Stop`.
- Tombstone restore (`restore_or_create_node`) preserves `road_access`: the same anchor/footprint yields the same derived access, so identity is preserved; restored nodes re-derive if the field is absent.
- Removal (`remove_or_tombstone_node`) is unchanged — `road_access` is part of the `Stop`, carried by tombstones and dropped on garbage-collection.

### TypeScript mirror (`src/render/placementValidation.ts`)

`canPlaceBuilding` for `busStop`/`busTerminal` additionally requires at least one orthogonal neighbor (of the **full footprint** for terminals) to be a bare road tile, so hover validation matches Rust (optimistic-only parity, same as today).

### Rendering indicator

The transit/building renderer draws a small arrow from the stop's `position` toward `roadAccess.roadPoint` along `preferredHeading`, making the bound lane visible (decision 2). The arrow renders above the road layer but below route-preview handles so it stays readable (z-order: map < buildings < access indicator < transit handles/preview). Exact art handled in implementation; a short stub arrow is the minimum.

## Section 3 — Access-constrained routing (`network.rs` + `road_topology.rs`)

### Access resolution: validate-on-resolve (revision C)

```rust
/// Resolve a stop waypoint to its authoritative access tile + preferred heading.
/// Validates any stored access against the live map and re-derives if stale.
/// Does NOT mutate the snapshot.
fn stop_access(snapshot: &GameSnapshot, stop_id: &str) -> Option<StopRoadAccess> {
    let stop = snapshot.transit.stops.iter().find(|s| s.id == stop_id)?;
    let footprint = stop_footprint(snapshot, stop);           // [origin] for busStop, full for terminal
    match stop.road_access {
        Some(access) if is_valid_access(&snapshot.map, &access) => Some(access),
        _ => derive_stop_access_for_footprint(&snapshot.map, &footprint),
    }
}

fn is_valid_access(map: &GameMap, access: &StopRoadAccess) -> bool {
    // road_point is still a bare road tile (not demolished, not swallowed by a
    // structure, not flipped). preferred_heading is NOT re-validated — it is a hint.
    map.tile(access.road_point)
        .is_some_and(|t| t.kind == "road" && t.road_structure_id.is_none())
}
```

This reconciles the earlier contradiction: there is no "engine-load mutation." Stored access is trusted when still valid; otherwise it is re-derived transparently at every preview/commit. (A later normalize pass may persist re-derived access, but is not required for correctness.)

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

Implementation is `deterministic_dijkstra` with two changes: `start_states` is replaced by `road_start_states(topology, from_tile)` only (no off-road neighbor scan), and the goal test becomes `state.position == to_tile` (with `movement_count > 0`, as today). The preferred headings only affect ranking/tie-breaking among otherwise-equal states, never feasibility. `from_tile == to_tile` returns a zero-step path (same as today's `from == to` branch).

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

### Undo / redo

```typescript
undo(): if past non-empty → push checkpoint(current) to future, pop past → restore into draft;
        generation++; clear preview; request fresh authoritative preview.
redo(): symmetric (future → past).
```

The generation bump + preview clear is mandatory: undo restores topology only, then demands a fresh authoritative preview so Rust revalidates against the (possibly edited) snapshot.

### Bindings & focus rules

Controller methods are named `undoRouteDraft()` / `redoRouteDraft()` on `RuntimeController` so Svelte buttons and key handlers share one path. The transient `alreadyOnRoute` notice auto-clears on the next meaningful mutation or on undo/redo.

- **Right-click / context-menu** while a route draft is active → `undoRouteDraft()`, and the browser context menu is suppressed only in route-draft mode. It must not interfere with canvas drag-cancel (verify during impl).
- **Cmd/Ctrl+Z** → `undoRouteDraft()`; **Cmd/Ctrl+Shift+Z** / Cmd/Ctrl+Y → `redoRouteDraft()`.
- **Focus rule:** these shortcuts and **Delete/Backspace** (`removeWaypoint(selectedIndex)`, a meaningful mutation) apply only when no `<input>`/`<textarea>` in `RouteEditor.svelte` has focus — otherwise the field's native undo/edit takes precedence. (Decision: route-draft undo never steals focus from a text field.)
- A visible **Undo** action in `RouteEditor.svelte`, disabled when `past` is empty; paired **Redo**, disabled when `future` is empty. Optional stack cap (e.g. 100) is fine.

Keyboard handling lives in the runtime canvas host (`createCanvasHost.ts`) / `actions.ts`.

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

`RouteEditor.svelte` and `render/overlayRenderer.ts` render the failed leg with the typed reason and one line of actionable guidance, e.g.:

- `NoRoadAccess` → "Stop has no adjacent road."
- `NoLegalTurnaround` → "No legal U-turn here; add a junction/roundabout or switch to Shuttle."
- `NetworkDisconnected` → "Roads not connected between these stops."
- `NoLegalEntryHeading` / `NoLegalExitHeading` → "Road direction doesn't allow serving this stop here."

`rejectionMessages.ts` gains a `noRoadAccess` placement message. When a return/closing leg fails with `NoLegalTurnaround`, the editor suggests Shuttle rather than silently flipping the pattern.

### Unified hit testing (TS)

One footprint-aware resolver — the existing `resolveStopAtTile` (`routeDraft.ts`) — is used for **add, inspect, and select**. Route-handle selection currently uses only the exact node anchor; it is switched to the shared footprint-aware path so multi-tile `busTerminal` footprints resolve consistently across all three interactions.

## Section 6 — Tests

### Rust

- **`tests/dual_road_routing.rs` (new):** via normal `GameIntent` calls — (1) draw intersecting dual-bidirectional roads; (2) assert the automatic-junction footprint and ports; (3) place stops on differently-oriented approaches; (4) preview and save a route; (5) assert the path's road steps **contain the specific junction turn tiles** (assert concrete `position`/`movement` values, not just "a left turn exists") and never enter a lane wrong-way; (6) assert a paired road without a legal turnaround rejects the return leg (`NoLegalTurnaround`), then becomes valid after adding a junction or roundabout; (7) **shuttle return-leg regression:** a shuttle A→B→C on an ordinary two-way road resolves both outbound and return legs (the heading-unpinned fix).
- **`tests/transit_build.rs` (extend):** placement requires road access; rejects when no adjacent road (`NoRoadAccess`); stores the correct `road_access` (`road_point` deterministic, `preferred_heading` populated); `busTerminal` placed with road only along the far edge derives access from the non-origin footprint neighbor; re-derives identically after tombstone restore.
- **`tests/route_editing.rs` (extend):** preview path ≡ committed path via **structural equality** (leg keys + road-step `position`/`entering_heading`/`leaving_heading`/`movement` + millis quantized to 1 ms), not bytes. Also: a stop whose stored `road_access` is stale (road demolished / one-way flipped / tile swallowed by a structure) is re-derived at resolve and the route still resolves or fails with the correct typed reason.
- **`tests/model_wire_format.rs` (extend):** `Stop` with and without `roadAccess` round-trips; missing field deserializes to `None`; `RouteLegPath` with and without `failureReason` round-trips.

### TypeScript

- **`tests/ui/routeDraft.test.ts` (extend):** duplicate clicks are no-ops on the real reducers (`applyRouteNodeClick`/`applyNodeClick`) — assert `===` draft, `generation` unchanged, no preview requested; append-of-existing selects the existing waypoint; insert-of-existing surfaces the notice without mutating; undo/redo restore checkpoints and bump generation; right-click triggers undo; **`selectWaypoint` does not push history**; history is cleared on cancel/save/startEdit/mode switch.
- **`tests/runtime/gameRuntime.test.ts` (extend):** end-to-end preview≡commit identity through the runtime/backend boundary (structural equality).
- **`tests/render/overlayRenderer.test.ts` (extend):** failed-leg overlay renders the typed reason; access indicator renders toward `roadPoint`.
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
| Existing snapshots migrate deterministically; stale access re-derives after road edits | §1, §3 (validate-on-resolve) |
| Rust workspace tests and frontend tests pass | §6 |

## Primary files

### Rust
- `crates/caelum-core/src/model.rs` — `StopRoadAccess { road_point, preferred_heading }`, `LegFailureReason`, `Stop.road_access`, `RouteLegPath.failure_reason`.
- `crates/caelum-core/src/stop_access.rs` — **new** `derive_stop_access` / `derive_stop_access_for_footprint` / `is_valid_access`.
- `crates/caelum-core/src/buildings.rs` — placement validation (incl. terminal footprint) + storing access.
- `crates/caelum-core/src/road_topology.rs` — **new** `find_path_between_access_tiles` (finder only; compile/builder unchanged).
- `crates/caelum-core/src/network.rs` — access-aware endpoint resolution via the new finder; `stop_access` validate-on-resolve; remove `terminal_reversal_access_points` + `shared_service_access_tile`; populate `failure_reason`.
- `crates/caelum-core/src/transit_nodes.rs` — tombstone restore preserves access.
- `crates/caelum-core/src/rejection.rs` — `NoRoadAccess` code.
- `crates/caelum-core/tests/dual_road_routing.rs` — **new**.
- `crates/caelum-core/tests/transit_build.rs`, `route_editing.rs`, `model_wire_format.rs` — extend.

### TypeScript / Svelte
- `src/domain/types.ts` — `StopRoadAccess`, `LegFailureReason`, `Stop.roadAccess`, `RouteLegPath.failureReason`, extend `RejectionCode` union with `"noRoadAccess"`.
- `src/ui/routeDraft.ts` — checkpoint history, undo/redo, duplicate suppression on `applyNodeClick`/`applyRouteNodeClick`.
- `src/ui/uiState.ts` — `RouteDraftHistory`, `RouteDraftCheckpoint`, `alreadyOnRoute` notice.
- `src/runtime/types.ts`, `src/runtime/createGameRuntime.ts` — `RuntimeController.undoRouteDraft()`/`redoRouteDraft()`.
- `src/runtime/createCanvasHost.ts` / `src/ui/actions.ts` — right-click + key bindings (with focus rules).
- `src/runtime/backend/types.ts` (+ wire mappers if not pure structural serde) — `failureReason` / `roadAccess` round-trip.
- `src/runtime/rejectionMessages.ts` — `noRoadAccess` message.
- `src/render/placementValidation.ts` — road-access hover mirror (full footprint for terminals).
- `src/render/overlayRenderer.ts` + transit renderer — access indicator (defined z-order), failed-leg overlay.
- `src/components/hud/panels/RouteEditor.svelte` — Undo/Redo actions, notice, Loop→Shuttle guidance.
- `tests/ui/routeDraft.test.ts`, `tests/runtime/gameRuntime.test.ts`, `tests/render/overlayRenderer.test.ts`, `tests/fixtures/*`, `tests/helpers/gameState.ts` — extend.

## Out of scope

- No change to metro routing (track paths).
- No new graph edges / topology **builder** changes — the existing port-to-port junction transitions already support legal turns. (A new *finder* is added, but the compiled graph is untouched.)
- No two-step lane-picking gesture (deferred; a "cycle serving lane" action can be added later if auto-pick proves insufficient).
- No persistent normalization of re-derived access into the snapshot (resolve-time validate-and-rederive is sufficient for correctness; a later pass may persist).

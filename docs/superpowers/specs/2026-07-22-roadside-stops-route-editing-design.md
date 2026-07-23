# Roadside Stop Access & Route Editing — Design

**Issue:** [HPA-309](https://linear.app/cwchanap/issue/HPA-309) — Fix bus route editing, roadside stops, and dual-lane turning.
**Date:** 2026-07-22
**Status:** Approved (pending implementation)

## Context

The heading-aware route editor and road topology introduced by PR #13 (commit `15e1082`) work at the subsystem level, but the player workflow exposes model, integration, and UX gaps around bus stops and route construction. This design covers the complete correction across all five delivery slices identified in the issue: data model + migration, access-constrained routing, draft undo/duplicate suppression, typed diagnostics, and regression tests.

Rust remains the authority for stop placement, road access, topology, route preview, and committed route validation. TypeScript owns draft history, shortcuts, interaction state, and presentation.

### Correction to the issue's premise

The issue states *"bus stops are currently placed and stored directly on road cells."* This is **inaccurate**. `buildings::can_place_building` (`crates/caelum-core/src/buildings.rs:132`) already requires `tile.kind == "empty"` for `busStop`, and `Stop.position` is set to the roadside `origin` (`buildings.rs:252`). Stops are *already* on roadside cells.

The real gap is the **missing explicit road access**: routing scans adjacent roads unconstrainedly (`network::terminal_reversal_access_points`, bare `waypoint_position`), which causes wrong-lane binding and the dual-road turn failures. Migration is therefore *"derive and persist a road access for stops already roadside,"* not *"move stops off roads."*

### Root cause of the dual-road turn failure

`road_topology::compile_automatic_junction_transitions` (`road_topology.rs:335`) already emits port-to-port left/right turns between dual carriageways — the junction graph **does** support legal turns. The bug is endpoint resolution binding a service leg to the wrong `RoadState` (wrong lane / wrong travel direction), so Dijkstra either fails or routes the wrong way. Pinning endpoints to the stop's explicit access fixes this without touching the graph builder.

## Decisions (confirmed in brainstorming)

1. **Scope:** all five delivery slices in one spec.
2. **Access selection UX:** auto-pick deterministically (fixed N,E,S,W heading order) at placement, render a visible indicator. No two-step gesture.
3. **Migration:** add `roadAccess` as a `#[serde(default)] Option<StopRoadAccess>` on `Stop`. **No schema bump** (stay on v2). Missing access is lazily derived on engine load via the same deterministic picker.

## Architecture — two forks

### Routing fork

**Chosen — pin endpoints to access `RoadState`.** Each service leg's endpoints become the exact `RoadState { position: road_point, incoming_heading: serving_heading }` derived from the stop's access. Dijkstra over `RoadTopology` is unchanged. Legal junction turns come for free from the existing port-to-port transitions.

*Rejected — synthetic stop-access graph nodes.* Inserting virtual edges from the access `RoadState` to a stop node is more invasive and buys nothing: the bus never occupies a separate node, the stop is just a pause at a real `RoadState`.

### Undo fork

**Chosen — immutable snapshot stack.** `RouteDraftHistory { past, future }` of immutable `RouteDraft` copies. Drafts are tiny; redo is trivially free; compound ops (reverse, pattern change) need no special inverse logic.

*Rejected — inverse-action log.* Correctness is hard for compound operations and redo requires forward replay. Not worth the complexity at this draft size.

## Section 1 — Data model & wire format

### Rust (`crates/caelum-core/src/model.rs`)

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopRoadAccess {
    pub road_point: Point,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serving_heading: Option<Heading>,
}

// Stop gains an optional access field:
#[serde(default, skip_serializing_if = "Option::is_none")]
pub road_access: Option<StopRoadAccess>,
```

`Point` and `Heading` are already `Copy + Eq + Hash + Serialize + Deserialize`, so `StopRoadAccess` derives everything cheaply.

**Semantics.** `road_point` is the road tile the bus occupies while serving. `serving_heading` is the direction of travel the bus moves while serving. The arrival/departure endpoint `RoadState` is exactly `{ position: road_point, incoming_heading: serving_heading }`. Both arrival and departure reference the same `RoadState` — the stop is a pause, not a graph edge.

`serving_heading` is `Option<Heading>` for robustness during the brief lazy-derive window, but `derive_stop_access` always populates `Some(...)` when any legal access exists.

### TypeScript (`src/domain/types.ts`)

```typescript
export interface StopRoadAccess {
  roadPoint: Point;
  servingHeading?: Heading;
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

**No schema bump.** Per decision 3, `roadAccess` is optional and lazily derived. `Station` (metro) is unchanged — metro already uses track paths and has no road access concept.

## Section 2 — Placement & deterministic access selection

### New module `crates/caelum-core/src/stop_access.rs`

```rust
/// Deterministically derive the serving road access for a roadside stop anchor.
/// Returns None when no adjacent legal road access exists.
pub fn derive_stop_access(map: &GameMap, anchor: Point) -> Option<StopRoadAccess> {
    // 1. Scan the anchor's 4 orthogonal neighbors in fixed N, E, S, W order.
    // 2. First neighbor that is a BARE road tile (kind == "road",
    //    road_structure_id == None) becomes road_point.
    // 3. serving_heading, in preference order:
    //    a. first heading h (N, E, S, W) where lane_accepts(one_way, h)
    //       AND road_connections.contains(h)  — bus can pass straight through;
    //    b. else first h where lane_accepts(one_way, h)             — terminus / must-turn;
    //    c. else None.
    // 4. Return None if no neighbor qualifies.
}
```

**Why two tiers for `serving_heading`.** Tier (a) picks a travel direction the bus can continue straight through — the normal case for a mid-block stop. Tier (b) is the fallback for a dead-end / terminus road tile where the bus must arrive and turn around (no straight continuation exists); the stop is still servable, and routing will use `find_terminal_reversal` to reverse there. A heading that satisfies only `lane_accepts` but has no graph transitions surfaces as a `NoLegalExitHeading` diagnostic if routing genuinely cannot proceed — the diagnosable outcome.

**Bare-road-tile restriction.** A stop may not bind to an automatic-junction or roundabout footprint tile — those are served through their ports via normal graph edges. Only `kind == "road" && road_structure_id.is_none()` qualifies as `road_point`.

### Placement integration (`buildings.rs`)

- `can_place_building` adds a new validation branch for `busStop`/`busTerminal`: after the existing footprint checks, call `derive_stop_access(map, *origin)`; reject with `RejectionCode::NoRoadAccess` (new code) when it returns `None`. This enforces *"at least one adjacent legal road access exists."*
- `place_building_core` stores the derived `road_access` on the new `Stop`.
- Tombstone restore (`restore_or_create_node`) preserves `road_access`: the same anchor yields the same derived access, so identity is preserved; restored nodes re-derive if the field was absent.
- Removal (`remove_or_tombstone_node`) is unchanged — `road_access` is part of the `Stop`, carried by tombstones and dropped on garbage-collection.

### TypeScript mirror (`src/render/placementValidation.ts`)

`canPlaceBuilding` for `busStop`/`busTerminal` additionally requires at least one orthogonal neighbor to be a bare road tile, so hover validation matches Rust (optimistic-only parity, same as today).

### Rendering indicator

The transit/building renderer draws a small arrow from the stop's `position` toward `roadAccess.roadPoint` along `servingHeading`, making the bound lane visible (decision 2). Exact art handled in implementation; a short stub arrow is the minimum.

## Section 3 — Access-constrained routing (`crates/caelum-core/src/network.rs`)

### Access-state resolution

```rust
/// Resolve a stop waypoint to its authoritative endpoint RoadState.
/// Lazily derives the access if the stop's road_access is None (does not mutate).
fn stop_access_state(snapshot: &GameSnapshot, stop_id: &str) -> Option<RoadState> {
    let stop = snapshot.transit.stops.iter().find(|s| s.id == stop_id)?;
    let access = stop
        .road_access
        .or_else(|| derive_stop_access(&snapshot.map, stop.position))?;
    Some(RoadState {
        position: access.road_point,
        incoming_heading: access.serving_heading?,
    })
}
```

### Service legs

`resolve_service_path` / `resolve_leg` stop using bare `Point` endpoints from `waypoint_position`. They resolve each waypoint via `stop_access_state` and run Dijkstra between the two `RoadState`s. `waypoint_position` is retained only for presence/missing-node detection (`RouteLegStatus::MissingNode`).

### Terminal reversal

`resolve_terminal_reversal` operates at the terminal stop's single `road_access.road_point`. Because every stop has exactly one access (decision 2), the arrival tile and departure tile are **always the same** — the reversal is always in-place:

```rust
RoadTopology::find_terminal_reversal(access_tile, exit_heading, entry_heading)
```

where `exit_heading` / `entry_heading` are derived from the bounding service legs' last/first road-step headings (as today). `find_reversal_between` is retained in `RoadTopology` but is no longer exercised by stop-based terminals under the single-access model; it stays available for future multi-access stops.

**Remove** `terminal_reversal_access_points` (the "scan all adjacent roads" fallback). That fallback is the source of the wrong-lane binding bug. With explicit access there is always one authoritative access tile and no fallback is needed.

### Preview ≡ commit invariant

Both `preview::preview_route` and `route_lifecycle` route creation/revision **must** call the same `network::resolve_route_legs`. This is already true in the current code; the implementation adds a regression test asserting the preview path and committed path are byte-identical for the same snapshot and waypoint sequence (acceptance criterion).

## Section 4 — Draft undo + duplicate suppression (TypeScript)

### History (`src/ui/routeDraft.ts` + `src/ui/uiState.ts`)

```typescript
export interface RouteDraftHistory {
  past: RouteDraft[];   // previous states, most-recent last
  future: RouteDraft[]; // redo stack, most-recent last
}
```

Held in `UiState` alongside the active `RouteDraft`. A `RouteDraft` is small (ordered waypoint ids + selection + meta), so snapshot copies are cheap.

**Meaningful mutations** push the pre-mutation draft onto `past` and clear `future`:

- append waypoint
- insert waypoint
- replace waypoint
- remove waypoint
- reorder waypoint
- reverse direction
- service-pattern change (loop ↔ shuttle)

**Selection-only changes** (selecting a different handle) do **not** push history.

### Undo / redo

```typescript
undo():  if past non-empty → push current to future, pop past → current;
         bump preview generation; request fresh authoritative preview.
redo():  symmetric (future → past).
```

### Bindings

- **Right-click / context-menu** while a route draft is active → `undo()`. (Current right-click behavior — likely nothing/cancel — is replaced only in the route-draft context.)
- **Cmd/Ctrl+Z** → `undo()`.
- **Cmd/Ctrl+Shift+Z** (or Cmd/Ctrl+Y) → `redo()`.
- **Delete/Backspace** with a selected waypoint → `removeWaypoint(selectedIndex)` (a meaningful mutation).
- A visible **Undo** action in `RouteEditor.svelte`, disabled when `past` is empty; paired **Redo**, disabled when `future` is empty.

Keyboard handling lives in the runtime canvas host / `actions.ts`; the controller methods (`undo()`, `redo()`) live on `RuntimeController` so Svelte and key handlers share one path.

### Duplicate suppression

- `appendWaypoint(stopId)`: if `stopId === draft.waypoints[last]` → **strict no-op** (return same `RouteDraft` reference, no generation bump, no preview request). If `stopId` is already anywhere in `draft.waypoints` → select that existing waypoint, no mutation, no history.
- `replaceWaypoint(index, stopId)`: if `draft.waypoints[index] === stopId` → **strict no-op**.
- `insertWaypoint(index, stopId)`: if `stopId` already present → no mutation, no history, surface a transient **"Already on this route"** message (new `UiState.notice` field, auto-clears).
- Rust duplicate validation remains as the final invariant (unchanged in `route_lifecycle`).

The no-op contract is testable: assert the returned `RouteDraft` is `===` the input and `generation` did not increment and no preview was requested.

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

Add `failure_reason: Option<LegFailureReason>` to `RouteLegPath` (model.rs), populated in `network::resolve_leg`:

| Condition | Reason |
|---|---|
| waypoint resolves to no `stop_access_state` (no adjacent road / access undeterminable) | `NoRoadAccess` |
| endpoint `RoadState` has no outgoing transitions in the graph | `NoLegalEntryHeading` (from) / `NoLegalExitHeading` (to) |
| service Dijkstra exhausts without a path | `NetworkDisconnected` |
| terminal reversal returns `None` | `NoLegalTurnaround` |
| otherwise | leg `Connected`, `failure_reason = None` |

The existing coarse `RouteLegStatus` (`connected`/`networkDisconnected`/`missingNode`) is retained for backward compatibility and derived from `failure_reason`.

### TS presentation

`RouteEditor.svelte` and `render/overlayRenderer.ts` render the failed leg with the typed reason and one line of actionable guidance, e.g.:

- `NoRoadAccess` → "Stop has no adjacent road."
- `NoLegalTurnaround` → "No legal U-turn here; add a junction/roundabout or switch to Shuttle."
- `NetworkDisconnected` → "Roads not connected between these stops."

The `Loop`-vs-`Shuttle` guidance specifically: when a return/closing leg fails with `NoLegalTurnaround`, suggest Shuttle rather than silently flipping the pattern.

### Unified hit testing (TS)

One footprint-aware resolver — the existing `resolveStopAtTile` (`routeDraft.ts:75`) — is used for **add, inspect, and select**. Route-handle selection currently uses only the exact node anchor; it is switched to the shared footprint-aware path so multi-tile `busTerminal` footprints resolve consistently across all three interactions.

## Section 6 — Tests

### Rust

- **`tests/dual_road_routing.rs` (new):** via normal `GameIntent` calls — (1) draw intersecting dual-bidirectional roads; (2) assert the automatic-junction footprint and ports; (3) place stops on differently-oriented approaches; (4) preview and save a route; (5) assert the path contains the legal left/right turn and never enters a lane wrong-way; (6) assert a paired road without a legal turnaround rejects the return leg, then becomes valid after adding a junction or roundabout.
- **`tests/transit_build.rs` (extend):** placement requires road access; rejects when no adjacent road (`NoRoadAccess`); stores the correct `road_access` (deterministic heading); re-derives identically after tombstone restore.
- **`tests/route_editing.rs` (extend):** preview path ≡ committed path for the same snapshot + waypoints.
- **`tests/model_wire_format.rs` (extend):** `Stop` with and without `roadAccess` round-trips; missing field deserializes to `None`.

### TypeScript

- **`tests/ui/routeDraft.test.ts` (extend):** duplicate clicks are no-ops (assert `===` draft, `generation` unchanged, no preview requested); undo/redo traverse history correctly; right-click triggers undo; selection-only changes do not create history; insert-of-existing surfaces the notice without mutating.
- **`tests/runtime/gameRuntime.test.ts` (extend):** end-to-end preview≡commit identity through the runtime/backend boundary.
- **`tests/render/overlayRenderer.test.ts` (extend):** failed-leg overlay renders the typed reason.

## Acceptance criteria mapping

| Criterion | Section |
|---|---|
| Stop rendered on a roadside cell, never on the road | §1, §2 (already roadside; now has access) |
| Every stop has an explicit authoritative serving road access | §1, §2, §3 |
| Route can legally turn through an auto-generated dual-road intersection | §3 (root cause) |
| Route never crosses paired lanes mid-block or enters a one-way lane wrong-way | §3 (access pins the lane) |
| Route requiring a turnaround fails with a specific explanation | §3, §5 (`NoLegalTurnaround`) |
| Preview and committed paths are identical | §3, §6 |
| Right-click and Cmd/Ctrl+Z undo one meaningful operation and refresh preview | §4 |
| Repeatedly clicking the same stop adds no duplicate, no history, no generation, no preview | §4 |
| Route-node hit testing consistent across add/inspect/edit | §5 |
| Existing on-road (roadside) snapshots migrate deterministically | §1, §2 (lazy-derive) |
| Rust workspace tests and frontend tests pass | §6 |

## Primary files

### Rust
- `crates/caelum-core/src/model.rs` — `StopRoadAccess`, `LegFailureReason`, `Stop.road_access`, `RouteLegPath.failure_reason`.
- `crates/caelum-core/src/stop_access.rs` — **new** `derive_stop_access`.
- `crates/caelum-core/src/buildings.rs` — placement validation + storing access.
- `crates/caelum-core/src/network.rs` — access-aware endpoint resolution; remove `terminal_reversal_access_points`.
- `crates/caelum-core/src/transit_nodes.rs` — tombstone restore preserves access.
- `crates/caelum-core/src/rejection.rs` — `NoRoadAccess` code.
- `crates/caelum-core/tests/dual_road_routing.rs` — **new**.
- `crates/caelum-core/tests/transit_build.rs`, `route_editing.rs`, `model_wire_format.rs` — extend.

### TypeScript / Svelte
- `src/domain/types.ts` — `StopRoadAccess`, `LegFailureReason`, `Stop.roadAccess`.
- `src/ui/routeDraft.ts` — history, undo/redo, duplicate suppression.
- `src/ui/uiState.ts` — `RouteDraftHistory`, notice field.
- `src/runtime/types.ts`, `src/runtime/createGameRuntime.ts` — controller `undo()`/`redo()`.
- `src/runtime/createCanvasHost.ts` / `src/ui/actions.ts` — right-click + key bindings.
- `src/render/placementValidation.ts` — road-access hover mirror.
- `src/render/overlayRenderer.ts` + transit renderer — access indicator, failed-leg overlay.
- `src/components/hud/panels/RouteEditor.svelte` — Undo/Redo actions, notice.
- `tests/ui/routeDraft.test.ts`, `tests/runtime/gameRuntime.test.ts`, `tests/render/overlayRenderer.test.ts` — extend.

## Out of scope

- No change to metro routing (track paths).
- No new graph edges / topology builder changes — the existing port-to-port junction transitions already support legal turns.
- No two-step lane-picking gesture (deferred; the "cycle serving lane" action can be added later if auto-pick proves insufficient).

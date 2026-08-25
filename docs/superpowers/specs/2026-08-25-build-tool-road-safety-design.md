# Build-Tool Road Safety and Rectangular Demolition Design

**Date:** 2026-08-25  
**Tracking:** HPA-551  
**Roadmap:** HPA-330  
**Delivery:** one implementation PR

## Goal

Make the existing build tools predictable during real map authoring without introducing a new editor framework:

1. Demolish drags remove the inclusive **N × M rectangle** between pointer-down and pointer-up.
2. A valid perpendicular road crossing, including dual-bidirectional × dual-bidirectional, produces a complete and traversable junction.
3. A multi-tile road stroke cannot silently repaint or overlap an existing road. Reusing a road tile is legal only for a genuine perpendicular crossing.

The implementation stays inside the current frontend drag/runtime flow and the authoritative Rust road-mutation pipeline. Browser/WASM and Tauri continue to consume the same existing backend methods.

## Current behavior and root-cause boundaries

### Demolish is constrained by frontend geometry, not backend capability

`UiState.drag` already stores an atomic gesture with `tool`, `start`, and `current`. The backend `removeAtTiles` operation already accepts an arbitrary point list and applies the existing full removal behavior for roads, track, buildings, transit nodes, and whole roundabouts.

The row-only behavior comes from `createGameRuntime.ts`: both road-mutation preview construction and `commitDrag()` pass every Road, Track, and Remove drag through `axisLockedLine`. The renderer already contains an inclusive row-major rectangle helper for area painting, but that helper is private to `overlayRenderer.ts`.

The smallest fix is therefore to share rectangle geometry and choose geometry by tool. No new controller method, backend intent, or Rust removal path is needed.

### Road overlap is currently treated as an edit

`crates/caelum-core/src/road.rs::author_lane_tiles` currently accepts an existing road tile. It calls `merge_lane_direction`, which can preserve or replace one-way metadata depending on the existing connections. The generated reverse carriageway has a separate `can_overlay_reverse_lane` rule, so forward and reverse lanes do not apply one uniform contact policy.

That behavior makes a dragged road stroke ambiguous:

- it can be a new road;
- it can upgrade or repaint an existing same-axis road;
- it can create a perpendicular crossing;
- the forward and generated reverse lanes can make different decisions over the same map.

The player requirement removes that ambiguity. Multi-tile road authoring is new-road construction plus legal crossings only. Existing-road direction editing remains the separate single-tile direction-cycle interaction.

### Junction correctness must be proven at the right layers

Current tests cover several clean and upgrade-based dual-road crossing sequences and assert four internal reciprocal edges for a 2 × 2 automatic junction. The topology compiler, however, routes automatic junctions through their live boundary ports, not merely through the serialized internal mesh.

A useful reproduction must therefore distinguish four layers:

1. expected automatic-junction footprint;
2. reciprocal internal road edges;
3. reciprocal external boundary ports;
4. compiled legal paths through the junction.

Production topology code changes only after one of those assertions is RED. A clean crossing that already passes all four layers does not justify another completion or normalization pass.

## Product decisions

## 1. Demolish uses an inclusive rectangle

Add one shared pure helper in `src/ui/roadDrag.ts`:

```ts
export function rectanglePoints(start: Point, end: Point): Point[]
```

The helper returns every point in the inclusive bounds:

```text
minX = min(start.x, end.x)
maxX = max(start.x, end.x)
minY = min(start.y, end.y)
maxY = max(start.y, end.y)
```

Ordering is deterministic row-major order: top to bottom, then left to right. Drag direction does not change the resulting point list.

Examples:

```text
(2, 3) -> (4, 4)
[
  (2,3), (3,3), (4,3),
  (2,4), (3,4), (4,4),
]

(4, 4) -> (2, 3)
produces the same list
```

`createGameRuntime.ts` chooses drag points once through a small local helper:

```ts
function dragMutationPoints(
  tool: "road" | "track" | "remove",
  start: Point,
  current: Point,
): Point[] {
  return tool === "remove"
    ? rectanglePoints(start, current)
    : axisLockedLine(start, current);
}
```

Both `roadMutationForUi` and `commitDrag` use this helper. This prevents preview/commit geometry drift.

Behavior by tool remains:

| Tool | Drag geometry |
| --- | --- |
| Road | axis-locked line |
| Track | axis-locked line |
| Demolish | inclusive rectangle |
| Area | inclusive rectangle through the existing rectangle intent |

`overlayRenderer.ts` imports the shared `rectanglePoints` for area paint preview and deletes its private duplicate. Demolish continues to render the authoritative road-mutation preview, which already carries changed/skipped tiles, route impact warnings, and structure footprints.

Single-tile demolition remains `removeAtTile`. A 1 × N or N × 1 rectangle remains behaviorally identical to the current line drag.

## 2. Road contact is validated before budget or map mutation

The overlap rule applies to `LayRoadLine`, not to the existing single-tile `LayRoad`/`CycleRoadDirection` click contract.

For a valid multi-tile road stroke, derive the requested axis from the stroke. Then validate every point in the complete requested footprint against the **original** map before authoring either lane or spending budget.

The complete footprint is:

- TwoWay: forward points;
- OneWay: forward points;
- DualBidirectional: forward points plus the generated reverse-carriageway points.

A requested point that is empty or otherwise handled by the existing placement/skip rules is not an overlap conflict. When the point is already a road, apply this table:

| Existing road state | Result |
| --- | --- |
| Ordinary road with only the perpendicular connection axis | legal crossing |
| Ordinary road with any connection on the requested axis | reject |
| Ordinary road with both axes | reject existing junction overlap |
| Ordinary road with no established connection axis | reject ambiguous overlap |
| Any structure-owned road tile | reject |
| Any roundabout-owned tile | reject |

“Only the perpendicular axis” includes a perpendicular endpoint with one reciprocal edge, so a new stroke may form a T-junction as well as a full crossing. It does not include an existing mixed-axis junction cell.

On the first conflict, return:

```rust
GameplayRejection::at(RejectionCode::BlockedTile, point)
```

The existing player message, “That tile is blocked,” is sufficient for this first version. No new Rust/TypeScript rejection enum is added.

### Atomicity

The preflight runs before:

- one-way spacing validation;
- any `CostPolicy` authorization/application;
- `author_lane_tiles`;
- connection creation;
- automatic-junction refresh.

Therefore a partially overlapping stroke cannot build its empty portion, spend budget, or alter route topology before being rejected. Preview and commit share `road::apply_road_mutation`, so the same rejection and unchanged snapshot apply to both.

### Road extension

A player extends an existing road by starting the new drag on the adjacent empty tile. `connect_neighbor_endpoints` attaches the new sequence to the existing endpoint. Starting the stroke on the existing endpoint is same-axis overlap and is rejected.

This removes upgrade-in-place and repaint semantics from the multi-tile tool without removing ordinary extension.

### Existing-road single click

A zero-length Road drag remains the existing deferred click behavior:

- empty tile: lay one two-way road tile;
- ordinary road tile: cycle its direction;
- structure-owned road tile: unchanged silent no-op through the existing rule.

No preset-dependent single-tile behavior is added.

## 3. One footprint helper serves validation and rejected previews

Add a small Rust helper in `road.rs`:

```rust
pub(crate) fn road_line_footprint(
    points: &[Point],
    preset: RoadPreset,
) -> Vec<Point>
```

For valid coordinates it returns the deterministic, de-duplicated forward footprint plus the generated reverse carriageway for `DualBidirectional`. The mutation path continues to perform the existing overflow rejection before trusting generated reverse points. For an already-rejected overflowing stroke, preview may fall back to the supplied forward points.

The helper is used by:

1. the preflight contact validator;
2. `preview.rs::attempted_mutation_tiles` for rejected `LayRoadLine` previews.

This matters for dual roads: when the conflict lies on the generated reverse lane, the invalid preview must show both attempted carriageways rather than only the dragged forward line.

## 4. Existing-road authoring is narrowed to legal crossings

After the preflight, an existing road tile encountered by `author_lane_tiles` is known to be a legal perpendicular crossing.

The implementation should therefore:

- remove the `reverse_lane` parameter from `author_lane_tiles`;
- delete `can_overlay_reverse_lane`;
- keep a narrowly named merge helper only for the legal crossing case;
- set the crossing tile to two-way (`one_way = None`) while retaining authored reciprocal connections for both axes;
- keep ordinary empty-tile placement, per-tile blocked skips, and budget exhaustion behavior unchanged.

The validator owns whether contact is allowed. The author owns how an already-approved crossing is materialized. This avoids a second, weaker policy inside the reverse-carriageway loop.

## 5. Dual-road intersection repair is evidence-gated

Extend `crates/caelum-core/tests/dual_road_routing.rs` with a reusable contract assertion for a clean 2 × 2 dual-road crossing.

For a crossing whose top-left footprint point is `p`, assert:

```text
Internal reciprocal edges:
p       <-> p + East
p       <-> p + South
p+East  <-> p + East + South
p+South <-> p + East + South
```

Also assert the exact eight live boundary port keys: two on each side of the 2 × 2 footprint. Finally, prove representative straight and turning paths across the compiled `RoadTopology`.

Cover the small sequence matrix justified by the report:

- horizontal first, then vertical;
- vertical first, then horizontal;
- each crossing stroke supplied in reverse point order;
- a road extension authored from the adjacent empty tile before the crossing is added.

Do not retain upgrade-in-place fixtures as accepted product behavior. Tests whose only purpose is proving that TwoWay/OneWay strokes can be repainted into Dual should be replaced by overlap-rejection tests.

### Root-cause decision gate

After the no-overlap preflight is implemented, run the crossing contract tests before touching topology production code.

- **Missing reciprocal road edge:** change only `connect_authored_sequence` / `connect_neighbor_endpoints`, or add a narrowly restricted 2 × 2 completion helper if the RED fixture proves an incomplete already-classified 2 × 2 junction.
- **Edges correct, boundary port missing:** change only boundary-port derivation in `refresh_automatic_junctions`.
- **Edges and ports correct, path missing:** change only `compile_automatic_junction_transitions` in `road_topology.rs`.
- **All assertions GREEN:** make no topology production change. The reported broken state came from a now-forbidden overlay sequence or needs a more exact playtest reproduction before further work.

A generic “connect every adjacent road in a 2 × 2 block” pass is rejected. It can invent turns inside parallel roads or malformed structures and would obscure which layer actually failed.

## Runtime data flow

### Rectangular demolition

```text
pointerdown
  -> UiState.drag { tool: remove, start, current: start }

pointermove
  -> setDragCurrent(current)
  -> dragMutationPoints(remove, start, current)
  -> rectanglePoints(start, current)
  -> RoadMutation::RemoveAtTiles preview request
  -> Rust remove_at_tiles candidate
  -> changed/skipped/route-impact preview

pointerup
  -> commitDrag
  -> same dragMutationPoints helper
  -> GameIntent::RemoveAtTiles
  -> Rust remove_at_tiles commit
```

### Road line

```text
pointerup
  -> axisLockedLine
  -> GameIntent::LayRoadLine
  -> road_line_footprint
  -> validate complete footprint against original map
  -> reject atomically OR author approved empty/crossing tiles
  -> refresh automatic junctions
  -> canonicalize roads
  -> compile and commit topology with snapshot
```

No TypeScript placement rule duplicates the Rust overlap classification. TypeScript supplies gesture geometry; Rust remains authoritative for gameplay validity.

## Error and failure handling

- Empty road strokes keep `InvalidRoadStroke`.
- Coordinate/offset overflow keeps `InvalidRoadStroke`.
- One-way proximity keeps `OneWayParallelTooClose` when no overlap conflict exists.
- Road overlap uses `BlockedTile` at the first conflicting point.
- A rejected stroke leaves snapshot, budget, topology cache, dirty state, and routes unchanged.
- Demolishing a rectangle with at least one removable item applies; non-removable/empty cells remain skipped through the existing removal contract.
- A rectangle with no removable item keeps the existing `BlockedTile` rejection.
- Backend/preview host failures continue through the current runtime error paths; no new retry or rollback state is introduced.

## File scope

### Frontend production

- `src/ui/roadDrag.ts`
- `src/runtime/createGameRuntime.ts`
- `src/render/overlayRenderer.ts`

### Frontend tests

- `tests/runtime/roadDrag.test.ts`
- `tests/runtime/gameRuntime.test.ts`
- `tests/render/overlayRenderer.test.ts`
- `tests/e2e/commandShelf.spec.ts`

### Rust production

- `crates/caelum-core/src/road.rs`
- `crates/caelum-core/src/preview.rs`
- `crates/caelum-core/src/road_topology.rs` only if a RED path assertion identifies that seam

### Rust tests

- `crates/caelum-core/tests/road_authoring.rs`
- `crates/caelum-core/tests/dual_road_routing.rs`

No new production module, backend method, public controller method, dependency, persistence field, schema version, migration, or compatibility wrapper.

## Testing strategy

### TypeScript unit/runtime

- `rectanglePoints` returns row-major inclusive points.
- Reverse drag directions return the same canonical rectangle.
- 1 × 1, 1 × N, and N × 1 remain correct.
- Remove preview and commit dispatch the same rectangle points.
- Road and Track continue to dispatch axis-locked lines.
- Area preview still uses the same rectangle geometry after helper extraction.

### Rust road authoring

- complete same-axis overlap rejects atomically;
- partial overlap rejects atomically and does not build the empty tail;
- generated reverse-lane overlap rejects the entire Dual stroke;
- perpendicular TwoWay and OneWay crossings remain legal;
- clean Dual × Dual crossing remains legal;
- mixed-axis automatic-junction overlap rejects;
- roundabout/structure-owned overlap rejects;
- extension from adjacent empty tile connects;
- preview and commit return the same rejection and unchanged snapshot;
- single-tile direction cycling remains unchanged.

### Junction topology

- both construction orders;
- reversed point order;
- complete 2 × 2 internal reciprocal mesh;
- exact eight boundary ports;
- representative straight and turning paths;
- no production topology helper without a RED assertion.

### Player-level smoke

Build a small rectangle of roads in Blank Grid, arm Demolish, drag diagonally across it, and verify every road tile in the rectangle is empty while an adjacent tile outside the rectangle remains unchanged.

## Acceptance criteria

- Demolish previews and removes arbitrary inclusive N × M rectangles in every drag direction.
- Road and Track drags remain straight and axis-locked.
- Same-axis, partial, ambiguous, junction-owned, and roundabout-owned road overlaps reject before any mutation or cost.
- Both forward and generated reverse lanes are validated.
- Perpendicular one-lane and dual-lane crossings remain legal.
- Road extension from the adjacent empty tile remains usable.
- Single-click direction editing remains unchanged.
- A clean Dual × Dual crossing has its expected footprint, reciprocal internal edges, eight live ports, and legal compiled paths.
- Preview and commit agree for accepted and rejected road strokes.
- The implementation ships as one PR for HPA-551.

## Non-goals

- Free-form, diagonal, curved, or L-shaped Road/Track drags.
- Upgrade-in-place road repainting.
- Adding a road arm through an existing automatic-junction footprint.
- New road provenance, stroke identity, lane-capacity model, or generic junction framework.
- New undo/redo or transaction framework.
- Save migration or backward compatibility for development snapshots.
- Broad refactoring outside the touched drag and road-authoring seams.

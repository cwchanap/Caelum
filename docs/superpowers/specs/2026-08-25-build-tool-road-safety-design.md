# Build-Tool Road Safety and Rectangular Demolition Design

**Date:** 2026-08-25  
**Tracking:** HPA-551  
**Roadmap:** HPA-330  
**Delivery:** one implementation PR

## Goal

Make the existing build tools predictable during real map authoring without introducing a new editor framework:

1. Demolish removes the inclusive **N × M rectangle** between pointer-down and pointer-up.
2. A valid perpendicular road crossing, including dual-bidirectional × dual-bidirectional, produces a complete and traversable junction.
3. A multi-tile player road stroke cannot silently repaint or overlap an existing road. Reusing a road tile is legal only for a genuine perpendicular crossing.

The implementation stays inside the current frontend drag/runtime flow and the authoritative Rust road-mutation pipeline. Browser/WASM and Tauri continue to consume the same existing backend methods.

## Review disposition

The reviewed product shape remains unchanged. The implementation contract is narrowed in four places:

- inventory and rewrite every test fixture that still specifies player `LayRoadLine` overlay as success;
- keep `author_scenario_road_line` merge-on-contact behavior for built-in sandbox templates;
- make the dual-junction task characterization-only until a post-fixture RED result identifies a production seam;
- run the player smoke in Blank Grid, not the default Crossroads template.

No topology repair implementation is pre-authorized by this design.

## Verified current boundaries

### Demolish is constrained by frontend geometry

`UiState.drag` already stores an atomic gesture with `tool`, `start`, and `current`. The backend `removeAtTiles` operation already accepts an arbitrary point list and applies the existing full removal behavior for roads, track, buildings, transit nodes, and whole roundabouts.

The row-only behavior comes from `createGameRuntime.ts`: road-mutation preview construction and `commitDrag()` currently pass Road, Track, and Remove through `axisLockedLine`. `overlayRenderer.ts` already contains an inclusive row-major rectangle helper for area painting.

The smallest fix is to share that geometry and choose points by tool. No new controller method, backend intent, or Rust removal path is needed.

### Player road overlap is currently treated as an edit

`crates/caelum-core/src/road.rs::author_lane_tiles` currently accepts an existing road tile and calls `merge_lane_direction`. The generated reverse carriageway also has a separate `can_overlay_reverse_lane` decision.

That gives player `LayRoadLine` several incompatible meanings: new road, same-axis repaint, direction update, partial upgrade, or perpendicular crossing. HPA-551 removes the repaint/upgrade meanings from multi-tile player authoring. Existing-road direction editing remains the separate single-tile direction-cycle interaction.

### Scenario authoring intentionally overlays

`author_scenario_road_line` is a different caller with a different contract. Crossroads composes four one-way arterials through the same central cells, and Small Town crosses two two-way roads. Those deterministic templates need merge-on-contact construction and do not represent a player build gesture.

Player `LayRoadLine` therefore gains strict contact preflight; `author_scenario_road_line` keeps its current merge policy. The implementation must not route template construction through the new player preflight.

### Junction correctness must be proven at four layers

Existing dual-road tests already have helpers for the expected 2 × 2 footprint and the four internal reciprocal edges. Automatic-junction routing, however, is compiled from live boundary ports.

A useful reproduction distinguishes:

1. automatic-junction footprint;
2. reciprocal internal road edges;
3. exact reciprocal external boundary ports;
4. compiled legal paths through the junction.

Only a RED result after all obsolete overlay fixtures have been rewritten can justify a production topology investigation.

## Product decisions

## 1. Demolish uses an inclusive rectangle

Add one shared pure helper in `src/ui/roadDrag.ts`:

```ts
export function rectanglePoints(start: Point, end: Point): Point[]
```

It returns every point in the inclusive bounds in deterministic row-major order: top to bottom, then left to right. Drag direction does not change the point list.

```text
(2,3) -> (4,4)
[(2,3), (3,3), (4,3), (2,4), (3,4), (4,4)]

(4,4) -> (2,3)
produces the same list
```

`createGameRuntime.ts` chooses geometry once:

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

Both `roadMutationForUi` and `commitDrag` use this helper.

| Tool | Drag geometry |
| --- | --- |
| Road | axis-locked line |
| Track | axis-locked line |
| Demolish | inclusive rectangle |
| Area | existing inclusive rectangle intent |

`overlayRenderer.ts` imports `rectanglePoints` for area preview and deletes its private duplicate. Demolish continues to render the authoritative road-mutation preview; no local renderer geometry fallback is added.

Single-tile demolition remains `removeAtTile`. A 1 × N or N × 1 rectangle remains behaviorally identical to the current line drag.

## 2. Player road contact is validated before cost or mutation

The overlap rule applies to multi-tile player `LayRoadLine`. It does not change `LayRoad`, `CycleRoadDirection`, or `author_scenario_road_line`.

For a valid multi-tile stroke, derive the requested axis and inspect every point in the complete requested footprint against the **original** map before authoring either lane or applying budget.

The footprint is:

- TwoWay: forward points;
- OneWay: forward points;
- DualBidirectional: forward points plus generated reverse-carriageway points.

When a footprint point is already a road:

| Existing road state | Result |
| --- | --- |
| Ordinary road with only the perpendicular connection axis | legal crossing |
| Ordinary road with any requested-axis connection | reject |
| Ordinary road with both axes | reject existing-junction overlap |
| Ordinary road with no established axis | reject ambiguous overlap |
| Structure-owned or roundabout-owned road | reject |

“Only the perpendicular axis” includes a perpendicular endpoint with one reciprocal edge, so the new stroke may form a T-junction as well as a through-crossing.

The first conflict returns:

```rust
GameplayRejection::at(RejectionCode::BlockedTile, point)
```

The existing “That tile is blocked.” copy remains sufficient.

### Ordering and atomicity

The preflight runs after stroke/offset overflow validation but before:

- one-way parallel-spacing validation;
- any `CostPolicy` authorization/application;
- `author_lane_tiles`;
- connection creation;
- automatic-junction refresh.

Consequences:

- same-axis OneWay overlay now returns `BlockedTile`, not `OneWayParallelTooClose`;
- a reverse-lane conflict rejects before the forward lane spends or builds;
- a partial overlap cannot build its empty tail;
- preview and commit share the same rejection through `road::apply_road_mutation`.

### Road extension and T-junctions

A player extends an existing road by starting the new drag on the adjacent empty tile. `connect_neighbor_endpoints` attaches the new sequence to the existing endpoint. Starting the stroke on the existing endpoint is same-axis overlap and rejects.

A perpendicular stroke may end on an existing endpoint. That is a legal T-junction and receives an explicit regression test.

### Single-tile Road click

A zero-length Road drag keeps the deferred click contract:

- empty tile: lay one two-way tile;
- ordinary road tile: cycle direction;
- structure-owned road tile: unchanged silent no-op.

## 3. Reuse existing Rust geometry and axis helpers

Add one named helper because validation and rejected preview both need the same complete footprint:

```rust
pub(crate) fn road_line_footprint(
    points: &[Point],
    preset: RoadPreset,
) -> Vec<Point>
```

Implement it by composing existing `reverse_lane_points` and `deduplicate_points`. Contact classification reuses existing `has_axis`; do not add a second equivalent axis predicate.

The helper is consumed by:

1. player `LayRoadLine` preflight;
2. `preview.rs::attempted_mutation_tiles` for rejected `LayRoadLine` previews.

For Dual rejection, preview must show both attempted carriageways, including a conflict that exists only on the generated reverse lane.

Validation reads the original map. Existing self-intersection/duplicate behavior inside one host-supplied mutation is outside the new existing-road contact rule and should not be accidentally changed.

## 4. Player and scenario authoring keep separate policies

After player preflight, an existing road encountered by player `author_lane_tiles` is already known to be an ordinary perpendicular crossing. The player path no longer calls `can_overlay_reverse_lane` or makes a second permissive contact decision.

Keep `merge_lane_direction` and `can_overlay_reverse_lane` available to `author_scenario_road_line`. Crossroads and Small Town must continue to construct and compile without passing through the player overlap policy.

This is two callers with two explicit policies, not a new abstraction:

```text
player LayRoadLine
  -> complete-footprint preflight
  -> empty tiles + approved perpendicular crossings only

scenario author_scenario_road_line
  -> existing deterministic merge-on-contact construction
```

No sandbox production code changes are expected.

## 5. Old overlay fixtures are deliberately rewritten

The old player contract is encoded beyond the three dual-upgrade recapture tests. Before the topology gate runs, retarget at least these fixtures:

### `crates/caelum-core/tests/transit_build.rs`

- `lay_road_line_dual_bidirectional_adds_left_reverse_lane_without_hijacking_existing_roads`
- `lay_road_line_one_way_is_idempotent_when_direction_already_matches`
- `lay_road_line_dual_bidirectional_skips_reverse_lane_when_tile_is_occupied`
- `lay_road_line_one_way_over_two_way_road_updates_direction`

These become atomic `BlockedTile` tests with unchanged snapshot/budget. The reverse-lane cases additionally prove the forward lane was not authored.

### `crates/caelum-core/tests/road_authoring.rs`

- `road_stroke_keeps_scanning_to_a_later_free_existing_road_overlay`
- `one_way_overlay_is_checked_before_merge_lane_direction`

The first becomes a partial-overlap atomicity test. The second expects `BlockedTile` before one-way spacing.

### `crates/caelum-core/tests/dual_road_routing.rs`

Remove or replace the three accepted upgrade fixtures:

- `recapture_dual_crossing_after_horizontal_then_vertical_upgrade_has_all_four_internal_edges`
- `recapture_dual_crossing_after_vertical_then_horizontal_upgrade_has_all_four_internal_edges`
- `recapture_dual_crossing_after_preexisting_one_way_overlay_has_all_four_internal_edges`

Rewrite the collinear continuation fixture so the second segment starts on the adjacent empty tile rather than repeating the previous endpoint.

`dual_intersection_engine` also currently overlays TwoWay on Dual approach lanes to make stop access bidirectional. Rewrite it by removing the selected Dual approach stretch and relaying TwoWay onto the resulting empty tiles before using it as the left-turn oracle. A RED turn after that rewrite is meaningful; a RED turn from a rejected fixture is not.

The implementation begins with a repository search for remaining overlay/repaint expectations and finishes by running the full Rust workspace suite. Do not weaken preflight to preserve an old test.

## 6. Dual-junction work is characterization-only until RED

Extend the existing dual-crossing assertions using current helpers:

- `assert_two_by_two_footprint`;
- `assert_complete_two_by_two_at`;
- `RoadStructure::port_keys`;
- `GameEngine::road_topology_for_test().find_path_between_access_tiles`.

Cover clean player-valid sequences:

- horizontal first, then vertical;
- vertical first, then horizontal;
- reversed horizontal input order;
- reversed vertical input order;
- adjacent-empty collinear extension before adding the crossing;
- the existing endpoint dual T-junction fixture.

For the canonical clean cross, assert the exact eight boundary ports and representative horizontal, vertical, and turning paths. The rewritten `dual_intersection_engine` remains the turning-path oracle.

### Decision gate

Run the complete matrix after fixture migration.

- If footprint, edges, ports, and paths are GREEN, commit characterization tests and make **no topology production change**.
- If RED, record the first failing layer and the exact fixture in the implementation PR. Investigate that seam before writing production code, and revise this plan with the confirmed minimal fix.

The plan intentionally contains no paste-ready internal-edge completion, port-repair, or transition-generation implementation. A generic 2 × 2 mesh completion remains rejected.

## Runtime data flow

### Rectangular demolition

```text
pointerdown
  -> UiState.drag { tool: remove, start, current: start }

pointermove
  -> setDragCurrent
  -> dragMutationPoints(remove, start, current)
  -> rectanglePoints
  -> existing RemoveAtTiles preview

pointerup
  -> commitDrag
  -> same dragMutationPoints helper
  -> existing RemoveAtTiles dispatch
```

### Player road line

```text
pointerup
  -> axisLockedLine
  -> LayRoadLine
  -> overflow validation
  -> road_line_footprint
  -> validate original-map contacts
  -> reject atomically OR author empty/approved crossing tiles
  -> refresh automatic junctions
  -> compile and commit topology
```

No TypeScript placement rule duplicates Rust contact classification.

## Testing strategy

### TypeScript

- `rectanglePoints`: row-major, reverse-drag invariant, 1 × 1, 1 × N, N × 1;
- runtime preview and commit dispatch the same rectangle;
- Road and Track still dispatch axis-locked lines;
- keep the existing “bulldozes a line with the remove tool drag” regression;
- run the existing overlay renderer suite after extracting the area helper; no new count-only renderer test is needed.

### Rust road authoring

- complete and partial same-axis overlap reject atomically;
- identical OneWay re-lay rejects rather than acting idempotently;
- TwoWay-to-OneWay repaint rejects;
- generated reverse-lane road conflict rejects before forward authoring;
- ambiguous isolated-road contact rejects;
- through-crossing and endpoint T-junction remain legal;
- Dual × Dual remains legal;
- existing junction and roundabout contact reject;
- adjacent-empty extension connects;
- rejected preview shows the full Dual footprint;
- preview and commit match;
- Crossroads and Small Town template construction remains valid.

### Junction characterization

- clean build orders and reverse input orders;
- expected 2 × 2 footprint;
- four internal reciprocal edges;
- exact eight live boundary ports;
- representative compiled straight and turn paths;
- no production topology change without post-migration RED evidence.

### Player smoke

Add the smoke to `tests/e2e/smoke.spec.ts`. Create the city explicitly with:

```ts
await createDefaultCity(page, "E2E City", "blankGrid");
```

Build two road rows away from template infrastructure, drag Demolish diagonally across a smaller rectangle, and assert every in-rectangle road is empty while the next road tile outside the rectangle remains.

## File scope

### Frontend production

- `src/ui/roadDrag.ts`
- `src/runtime/createGameRuntime.ts`
- `src/render/overlayRenderer.ts`

### Frontend tests

- `tests/runtime/roadDrag.test.ts`
- `tests/runtime/gameRuntime.test.ts`
- `tests/e2e/smoke.spec.ts`

### Rust production

- `crates/caelum-core/src/road.rs`
- `crates/caelum-core/src/preview.rs`
- `crates/caelum-core/src/road_topology.rs` only after confirmed RED evidence and an updated plan

### Rust tests

- `crates/caelum-core/tests/transit_build.rs`
- `crates/caelum-core/tests/road_authoring.rs`
- `crates/caelum-core/tests/dual_road_routing.rs`

Verification includes the existing `sandbox_coverage` and renderer tests even though those files should not require modification.

## Acceptance criteria

- Demolish previews and removes arbitrary inclusive N × M rectangles in every drag direction.
- Road and Track remain axis-locked.
- Same-axis, partial, ambiguous, existing-junction, and roundabout road contacts reject before cost or mutation.
- Both Dual carriageways are validated against the original map.
- Perpendicular through-crossings and endpoint T-junctions remain legal.
- Adjacent-empty extension remains usable.
- Single-click direction editing remains unchanged.
- Crossroads and Small Town continue to construct through scenario-only merge semantics.
- Every old overlay-as-success fixture is removed or retargeted; none is preserved by weakening preflight.
- A clean Dual × Dual crossing has its expected footprint, reciprocal internal edges, eight live ports, and legal compiled paths.
- No topology production diff lands without a RED result after fixture migration.
- Preview and commit agree for accepted and rejected road strokes.
- The implementation ships in the single HPA-551 PR.

## Non-goals

- Free-form, diagonal, curved, or L-shaped Road/Track drags.
- Player upgrade-in-place road repainting.
- Adding a player road arm through an existing automatic-junction footprint.
- Changing deterministic scenario road authoring.
- New road provenance, stroke identity, lane-capacity model, or generic junction framework.
- New undo/redo, backend, persistence, migration, or compatibility machinery.
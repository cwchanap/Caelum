# Build-Tool Road Safety and Rectangular Demolition Design

**Date:** 2026-08-25  
**Tracking:** HPA-551  
**Roadmap:** HPA-330  
**Delivery:** one implementation PR

## Goal

Make the existing build tools predictable during real map authoring without introducing a new editor framework:

1. Demolish removes the inclusive **N × M rectangle** between pointer-down and pointer-up.
2. A valid perpendicular road crossing, including dual-bidirectional × dual-bidirectional, produces a complete and traversable junction.
3. An axis-resolved multi-tile player road stroke cannot silently repaint or overlap an existing road. Reusing a road tile is legal only for a genuine perpendicular crossing.

The implementation stays inside the current frontend drag/runtime flow and the authoritative Rust road-mutation pipeline. Browser/WASM and Tauri continue to consume the same existing backend methods.

## Review disposition

The product shape remains unchanged. The implementation contract is tightened in six places:

- inventory every `LayRoadLine` core-test fixture before editing production code;
- classify fixtures as **contract** or **scenery**, because they require opposite treatment;
- keep built-in scenario road authoring on its existing merge-on-contact path;
- scope the strict player preflight to non-degenerate single-axis strokes, which is the only shape the UI emits;
- name the intentional road-contact atomicity versus non-road skip split;
- keep topology characterization-only until a post-migration RED result identifies a production seam.

No topology repair implementation is pre-authorized by this design.

## Verified current boundaries

### Demolish is constrained by frontend geometry

`UiState.drag` already stores an atomic gesture with `tool`, `start`, and `current`. The backend `removeAtTiles` operation already accepts an arbitrary point list and applies the existing full removal behavior for roads, track, buildings, transit nodes, and whole roundabouts.

The row-only behavior comes from `createGameRuntime.ts`: road-mutation preview construction and `commitDrag()` currently pass Road, Track, and Remove through `axisLockedLine`. `overlayRenderer.ts` already contains an inclusive row-major rectangle helper for area painting.

The smallest fix is to share that geometry and choose points by tool. No new controller method, backend intent, or Rust removal path is needed.

Demolish does not receive a renderer-side geometry fallback. `renderRoadMutationPreview` continues to draw only the authoritative Rust preview. This matters for large rectangle gestures: the player must see the exact changed/skipped/route-impact candidate that commit will apply, rather than an optimistic local outline in a game with no undo.

### Player road overlap is currently treated as an edit

`crates/caelum-core/src/road.rs::author_lane_tiles` currently accepts an existing road tile and calls `merge_lane_direction`. The generated reverse carriageway also has a separate `can_overlay_reverse_lane` decision.

That gives player `LayRoadLine` several incompatible meanings:

- build new road;
- repaint or upgrade a same-axis road;
- partially build while skipping an occupied reverse-lane tile;
- create a perpendicular crossing.

HPA-551 removes repaint, upgrade, and partial road-contact meanings from axis-resolved multi-tile player authoring. Existing-road direction editing remains the separate single-tile direction-cycle interaction.

### Structure contact is also changing meaning

Player line authoring currently skips roundabout-owned tiles and may merge direction state into other structure-owned road tiles. HPA-551 changes both cases to whole-stroke `BlockedTile` rejection for axis-resolved player strokes.

This is intentional. A structure footprint owns its road geometry and must not be partially repainted by the ordinary Road tool.

### Scenario authoring intentionally overlays

`author_scenario_road_line` is a different caller with a different contract. Crossroads composes four one-way arterials through shared central cells, and Small Town crosses two two-way roads. Those deterministic templates need merge-on-contact construction and do not represent a player build gesture.

Player `LayRoadLine` therefore gains strict contact preflight; `author_scenario_road_line` keeps its current merge policy. Template construction must not pass through the new player preflight.

### The UI and the host boundary accept different stroke shapes

The player UI emits a non-degenerate axis-locked line through `axisLockedLine`. The Rust wire boundary can still receive duplicate-point, bent, loop, or otherwise non-axis-locked `LayRoadLine` payloads, and existing tests exercise those shapes.

HPA-551 does not redesign that broader host contract. Strict contact preflight applies only when the points resolve to one non-zero axis. Degenerate or bent host strokes retain their current authoring/skip semantics. Existing duplicate and bent-stroke tests remain controls.

This is deliberately narrower than claiming every arbitrary host payload is overlap-safe. The player-facing guarantee is complete because the UI cannot emit the excluded shapes.

### Road contact and non-road obstruction use different mutation models

After HPA-551:

- existing-road contact covered by the player preflight rejects the whole axis-resolved stroke atomically;
- building occupancy, transit-node occupancy, blocked terrain, out-of-bounds tiles, and affordability continue through the existing per-tile skip/ordered-budget behavior.

The split is intentional. Repainting a road changes existing player-authored network state; skipping a non-road obstruction leaves that obstruction untouched while allowing the rest of the requested construction. HPA-551 does not broaden into an all-or-nothing road-building transaction.

### Junction correctness must be proven at four layers

Existing dual-road tests already have helpers for the expected 2 × 2 footprint and the four internal reciprocal edges. Automatic-junction routing, however, is compiled from live boundary ports.

A useful reproduction distinguishes:

1. automatic-junction footprint;
2. reciprocal internal road edges;
3. exact reciprocal external boundary ports;
4. compiled legal paths through the junction.

Only a RED result after obsolete contract fixtures and incidental scenery overlays have been rewritten can justify a production topology investigation.

## Product decisions

## 1. Demolish uses an inclusive rectangle

Move the existing row-major rectangle algorithm from `src/render/overlayRenderer.ts` into `src/ui/roadDrag.ts`:

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

`overlayRenderer.ts` imports `rectanglePoints` for area preview and deletes its private duplicate. Demolish continues to render the authoritative road-mutation preview.

Single-tile demolition remains `removeAtTile`. A 1 × N or N × 1 rectangle remains behaviorally identical to the current line drag.

## 2. Axis-resolved player road contact is validated before cost or mutation

The strict overlap rule applies to a multi-tile `LayRoadLine` whose points resolve to one non-zero axis. It does not change:

- `LayRoad`;
- `CycleRoadDirection`;
- `author_scenario_road_line`;
- duplicate-point or bent/loop host strokes that the player UI cannot emit.

Add one small private resolver for the preflight gate:

```rust
fn axis_resolved_stroke_direction(points: &[Point]) -> Option<Heading>
```

It returns a heading only when:

- at least one segment exists;
- every consecutive pair is adjacent and non-duplicate;
- every segment is on the same horizontal or vertical axis.

It does not replace `line_direction` or `canonical_line_direction`, because those existing helpers still own OneWay direction and Dual carriageway geometry for the broader host contract.

For an axis-resolved stroke, inspect every point in the complete requested footprint against the **original** map before authoring either lane or applying budget.

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
- a partial road overlap cannot build its empty tail;
- structure and roundabout contact reject the whole stroke;
- preview and commit share the same rejection through `road::apply_road_mutation`.

Non-road obstructions continue to skip per tile, and budget exhaustion continues to stop/skip in input order as today.

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

1. axis-resolved player `LayRoadLine` preflight;
2. `preview.rs::attempted_mutation_tiles` for rejected `LayRoadLine` previews.

For Dual rejection, preview must show both attempted carriageways, including a conflict that exists only on the generated reverse lane.

Validation reads the original map. Existing self-intersection and duplicate behavior inside one non-axis-resolved host mutation is intentionally outside the strict player contact rule.

## 4. Player and scenario authoring keep separate policies

After player preflight, an existing road encountered by player `author_lane_tiles` is already known to be an ordinary perpendicular crossing. The player path no longer calls `can_overlay_reverse_lane` or makes a second permissive contact decision.

Keep `merge_lane_direction` and `can_overlay_reverse_lane` available to `author_scenario_road_line`. Crossroads and Small Town must continue to construct and compile without passing through the player overlap policy.

This is two callers with two explicit policies, not a new abstraction:

```text
axis-resolved player LayRoadLine
  -> complete-footprint preflight
  -> empty tiles + approved perpendicular crossings only

scenario author_scenario_road_line
  -> existing deterministic merge-on-contact construction
```

No sandbox production code changes are expected.

## 5. Fixture discovery precedes production edits

Before changing `road.rs`, run:

```bash
rg -n 'LayRoadLine|lay_road_line' crates/caelum-core/tests
```

The current code search spans 24 core-test files. Record every hit in the PR under a fixture inventory with one of two dispositions:

### Contract fixture

The test asserts overlay, repaint, partial upgrade, or idempotent re-lay as the product behavior.

Action: retarget the assertion to the new `BlockedTile` contract or replace it with a legal clean-crossing/adjacent-extension fixture.

Known contract fixtures include:

- `transit_build.rs`
  - `lay_road_line_dual_bidirectional_adds_left_reverse_lane_without_hijacking_existing_roads`
  - `lay_road_line_one_way_is_idempotent_when_direction_already_matches`
  - `lay_road_line_dual_bidirectional_skips_reverse_lane_when_tile_is_occupied`
  - `lay_road_line_one_way_over_two_way_road_updates_direction`
- `road_authoring.rs`
  - `road_stroke_keeps_scanning_to_a_later_free_existing_road_overlay`
  - `one_way_overlay_is_checked_before_merge_lane_direction`
- `dual_road_routing.rs`
  - the three `recapture_dual_crossing_after_*_upgrade_*` / overlay reproductions
  - the collinear continuation fixture that repeats the prior endpoint

### Scenery fixture

The test’s real assertion is routing, persistence, topology, service behavior, or another feature; overlap occurs only while arranging its map.

Action: rebuild the setup legally and preserve the load-bearing assertion.

Known scenery fixtures include:

- `transit_router.rs::terminal_turnaround_recovers_after_a_roundabout_is_placed`
  - keep the 2 × 2 loop;
  - change the west approach to `(1..=2)` and the east approach to `(5..=6).rev()`;
  - rely on `connect_neighbor_endpoints` to attach to the loop;
  - keep the terminal-turnaround and roundabout-recovery assertions.
- `dual_road_routing.rs::dual_intersection_engine`
  - do not overlay TwoWay onto Dual approaches;
  - remove the selected approach stretch;
  - relay TwoWay onto the resulting empty tiles;
  - keep the stop-access and left-turn assertions.

Known controls that must remain unchanged include non-road partial skips, affordability ordering, duplicate-point strokes, and bent/self-overlapping host strokes. The inventory records them as controls rather than contract migrations.

A test must not be deleted merely because its setup contains overlap. Delete/retarget only when overlay itself is the contract under test.

The production preflight and every required fixture rewrite land at one green commit boundary. Run `cargo test --workspace` before that commit.

## 6. Original reproductions map to explicit replacements

The three upgrade-based recapture tests are not removed without trace. Record this mapping in the implementation PR and test comments:

| Original reproduction | Product-contract replacement | Legal topology replacement |
| --- | --- | --- |
| `recapture_dual_crossing_after_horizontal_then_vertical_upgrade_has_all_four_internal_edges` | same-axis/upgrade stroke rejects atomically | `horizontal_first_dual_intersection_has_all_four_internal_edges` upgraded to the full crossing contract |
| `recapture_dual_crossing_after_vertical_then_horizontal_upgrade_has_all_four_internal_edges` | same-axis/upgrade stroke rejects atomically | `vertical_first_dual_intersection_has_all_four_internal_edges` upgraded to the full crossing contract |
| `recapture_dual_crossing_after_preexisting_one_way_overlay_has_all_four_internal_edges` | OneWay/Dual repaint rejects atomically | clean horizontal-first Dual × Dual crossing plus reversed-input characterization |

If the legal replacements are GREEN after fixture migration, the original symptom is evidence of the now-forbidden overlay path rather than a missing clean-crossing topology repair.

## 7. Dual-junction work is characterization-only until RED

Extend the existing dual-crossing assertions using current helpers:

- `assert_two_by_two_footprint`;
- `assert_complete_two_by_two_at`;
- `RoadStructure::port_keys`;
- `GameEngine::road_topology_for_test().find_path_between_access_tiles`.

`port_keys()` already returns a sorted canonical vector, so exact equality checks the port set without depending on insertion/emission order.

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
- If RED, record the first failing layer and exact fixture in the implementation PR. Investigate that seam, revise this design and implementation plan with the confirmed minimal fix, and only then change production topology.

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
  -> Rust candidate changed/skipped/route impacts

pointerup
  -> commitDrag
  -> same dragMutationPoints helper
  -> existing RemoveAtTiles dispatch
```

### Axis-resolved player road line

```text
pointerup
  -> axisLockedLine
  -> LayRoadLine
  -> overflow validation
  -> axis_resolved_stroke_direction
  -> road_line_footprint
  -> validate original-map road contacts
  -> reject atomically OR author empty/approved crossing tiles
  -> refresh automatic junctions
  -> compile and commit topology
```

### Non-axis-resolved host road line

```text
host LayRoadLine payload
  -> existing overflow validation
  -> axis_resolved_stroke_direction returns None
  -> skip strict player road-contact preflight
  -> retain existing host authoring/skip behavior
```

No TypeScript placement rule duplicates Rust contact classification.

## Testing strategy

### TypeScript

- `rectanglePoints`: row-major, reverse-drag invariant, 1 × 1, 1 × N, N × 1;
- runtime preview and commit dispatch the same rectangle;
- Road and Track still dispatch axis-locked lines;
- keep the existing “bulldozes a line with the remove tool drag” regression;
- run the existing overlay renderer suite after extracting the area helper; no new count-only renderer test is needed.

### Rust player road authoring

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
- non-road blocked/building/transit-node tiles retain per-tile skip behavior;
- duplicate and bent host strokes retain their existing behavior;
- Crossroads and Small Town template construction remains valid.

### Fixture migration

- classify every core-test `LayRoadLine` hit before production changes;
- retarget contract fixtures;
- rebuild scenery fixtures legally;
- keep the terminal-turnaround recovery regression;
- keep the real dual left-turn oracle;
- run `cargo test --workspace` before each Rust commit boundary.

### Junction characterization

- clean build orders and reverse input orders;
- expected 2 × 2 footprint;
- four internal reciprocal edges;
- exact eight live boundary ports through canonical `port_keys()`;
- representative compiled straight and turn paths;
- no production topology change without post-migration RED evidence and a revised plan.

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
- `crates/caelum-core/tests/transit_router.rs`
- any additional file identified by the pre-edit `LayRoadLine` inventory

Verification includes the existing `sandbox_coverage` and renderer tests even when those files require no modification.

## Acceptance criteria

- Demolish previews and removes arbitrary inclusive N × M rectangles in every drag direction.
- Existing 1 × N demolition and single-tile demolition remain valid.
- Road and Track remain axis-locked.
- Every axis-resolved player road stroke validates all existing-road contacts against the original map.
- Same-axis, partial, ambiguous, existing-junction, and roundabout contacts reject before cost or mutation.
- Both carriageways of an axis-resolved Dual stroke are checked before authoring.
- Perpendicular through-crossings and endpoint T-junctions remain legal.
- Adjacent-empty extension remains usable.
- Non-road obstructions retain the existing per-tile skip/ordered-budget semantics.
- Degenerate and bent host-only strokes retain their current semantics and are not described as covered by the strict player preflight.
- Single-click direction editing remains unchanged.
- Crossroads and Small Town continue to construct through scenario-only merge semantics.
- Every core-test `LayRoadLine` hit is classified before production edits.
- Contract fixtures are retargeted; scenery fixtures preserve their original assertions through legal setup.
- The three original upgrade reproductions have documented contract and legal-topology replacements.
- A clean Dual × Dual crossing exposes the expected footprint, reciprocal internal edges, eight live ports, and legal compiled paths.
- No topology production diff lands without a RED result after fixture migration and a revised plan.
- Preview and commit agree for accepted and rejected road strokes.
- The implementation ships in the single HPA-551 PR.

## Non-goals

- Free-form, diagonal, curved, or L-shaped Road/Track drags in the player UI.
- Redesigning or rejecting arbitrary bent/duplicate host `LayRoadLine` payloads.
- Upgrade-in-place player road repainting.
- Adding a road arm through an existing automatic-junction footprint.
- New road provenance, stroke identity, lane-capacity model, or generic junction framework.
- New undo/redo or transaction framework.
- Save migration or backward compatibility for development snapshots.
- Broad refactoring outside the touched drag, fixture, and road-authoring seams.

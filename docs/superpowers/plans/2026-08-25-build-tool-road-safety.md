# Build-Tool Road Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add inclusive rectangular demolition, reject player road overlap atomically, preserve deterministic scenario construction, and characterize clean dual-road junction connectivity.

**Architecture:** TypeScript selects deterministic drag geometry and sends the existing intents. `caelum-core` performs one complete-footprint player-road preflight before spacing, cost, or mutation; built-in scenarios retain their separate merge-on-contact authoring path. Dual-junction production code remains unchanged unless the post-fixture characterization matrix is RED and the plan is revised with the confirmed failing seam.

**Tech Stack:** Rust (`caelum-core`), TypeScript, Svelte runtime/canvas rendering, Vitest, Playwright, Bun, Cargo

**Spec:** `docs/superpowers/specs/2026-08-25-build-tool-road-safety-design.md`

## Global Constraints

- Deliver implementation and tests in the existing **single HPA-551 PR**.
- Keep `GameBackend`, WASM, Tauri, `GameIntent`, and `DragGesture` interfaces unchanged.
- Road and Track remain axis-locked; only Demolish changes to rectangular geometry.
- Rust owns road-contact validity; do not classify overlap in TypeScript.
- Player multi-tile `LayRoadLine` may reuse an ordinary road tile only for a perpendicular crossing.
- Validate both Dual carriageways against the original map before one-way spacing, cost, or mutation.
- Keep single-tile `LayRoad` / `CycleRoadDirection` behavior unchanged.
- Keep `author_scenario_road_line` merge-on-contact behavior for Crossroads and Small Town.
- Reuse `has_axis`, `reverse_lane_points`, and `deduplicate_points`; do not add equivalent helpers.
- Use existing `BlockedTile`; add no rejection enum or message.
- Remove or rewrite old overlay-as-success fixtures; never weaken preflight to keep them green.
- Do not add production topology code from this plan. A post-migration RED result requires root-cause evidence and a plan update first.
- Add no dependency, save field, schema bump, migration, provenance model, compatibility wrapper, or generic road framework.

## File Structure

- `src/ui/roadDrag.ts` — shared line and rectangle point generation.
- `src/runtime/createGameRuntime.ts` — choose geometry once for preview and commit.
- `src/render/overlayRenderer.ts` — consume shared rectangle geometry for Area preview.
- `crates/caelum-core/src/road.rs` — player footprint derivation and contact preflight; scenario policy remains separate.
- `crates/caelum-core/src/preview.rs` — full rejected Dual footprint.
- `tests/runtime/roadDrag.test.ts` — pure rectangle ordering.
- `tests/runtime/gameRuntime.test.ts` — preview/commit geometry and existing line regression.
- `tests/e2e/smoke.spec.ts` — Blank Grid rectangular demolition journey.
- `crates/caelum-core/tests/road_authoring.rs` — overlap, T-junction, extension, and preview parity.
- `crates/caelum-core/tests/transit_build.rs` — retarget old line-overlay contracts.
- `crates/caelum-core/tests/dual_road_routing.rs` — valid fixture rewrite plus layered junction characterization.

---

### Task 1: Share Rectangle Geometry and Use It for Demolish

**Files:**
- Modify: `src/ui/roadDrag.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `src/render/overlayRenderer.ts`
- Modify: `tests/runtime/roadDrag.test.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`
- Modify: `tests/e2e/smoke.spec.ts`
- Verify unchanged: `tests/render/overlayRenderer.test.ts`

**Interfaces:**
- Produces: `rectanglePoints(start: Point, end: Point): Point[]`
- Produces locally: `dragMutationPoints(tool, start, current): Point[]`
- Preserves: `axisLockedLine`, `removeAtTile`, `removeAtTiles`

- [ ] **Step 1: Add failing pure rectangle tests**

Update `tests/runtime/roadDrag.test.ts`:

```ts
import { axisLockedLine, rectanglePoints } from "../../src/ui/roadDrag";

describe("rectanglePoints", () => {
  const expected = [
    { x: 2, y: 3 },
    { x: 3, y: 3 },
    { x: 4, y: 3 },
    { x: 2, y: 4 },
    { x: 3, y: 4 },
    { x: 4, y: 4 },
  ];

  it("returns an inclusive row-major rectangle", () => {
    expect(rectanglePoints({ x: 2, y: 3 }, { x: 4, y: 4 })).toEqual(
      expected,
    );
  });

  it("canonicalizes reverse drag direction", () => {
    expect(rectanglePoints({ x: 4, y: 4 }, { x: 2, y: 3 })).toEqual(
      expected,
    );
  });

  it("keeps 1x1, 1xN, and Nx1 rectangles inclusive", () => {
    expect(rectanglePoints({ x: 7, y: 8 }, { x: 7, y: 8 })).toEqual([
      { x: 7, y: 8 },
    ]);
    expect(rectanglePoints({ x: 1, y: 2 }, { x: 3, y: 2 })).toEqual([
      { x: 1, y: 2 },
      { x: 2, y: 2 },
      { x: 3, y: 2 },
    ]);
    expect(rectanglePoints({ x: 2, y: 1 }, { x: 2, y: 3 })).toEqual([
      { x: 2, y: 1 },
      { x: 2, y: 2 },
      { x: 2, y: 3 },
    ]);
  });
});
```

- [ ] **Step 2: Run the pure test and verify RED**

```bash
bunx vitest run --project runtime tests/runtime/roadDrag.test.ts
```

Expected: FAIL because `rectanglePoints` is not exported.

- [ ] **Step 3: Export the existing row-major rectangle algorithm**

Append to `src/ui/roadDrag.ts`:

```ts
/** Inclusive row-major rectangle. Drag direction does not affect ordering. */
export function rectanglePoints(start: Point, end: Point): Point[] {
  const minX = Math.min(start.x, end.x);
  const maxX = Math.max(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxY = Math.max(start.y, end.y);
  const points: Point[] = [];

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      points.push({ x, y });
    }
  }

  return points;
}
```

- [ ] **Step 4: Add a runtime preview/commit parity test**

Add `RoadMutation` to the existing backend-type imports in `tests/runtime/gameRuntime.test.ts`, then add:

```ts
it("uses the same inclusive rectangle for remove preview and commit", async () => {
  const previewMutations: RoadMutation[] = [];
  const backend = backendSpy();
  backend.previewRoadMutation = vi.fn(async (request) => {
    previewMutations.push(request.mutation);
    const changedTiles =
      request.mutation.type === "removeAtTiles"
        ? request.mutation.points
        : request.mutation.type === "removeAtTile"
          ? [request.mutation.point]
          : [];
    return {
      generation: request.generation,
      changedTiles,
      authoredTiles: [],
      generatedStructures: [],
      cost: 0,
      skippedTiles: [],
      routeImpacts: [],
      warnings: [],
      rejection: null,
    };
  });
  const runtime = await createGameRuntime({
    backend,
    hoverPreviewDebounceMs: 0,
  });

  runtime.setTool("remove");
  runtime.startDrag({ x: 2, y: 3 });
  runtime.setDragCurrent({ x: 4, y: 4 });

  const expected = [
    { x: 2, y: 3 },
    { x: 3, y: 3 },
    { x: 4, y: 3 },
    { x: 2, y: 4 },
    { x: 3, y: 4 },
    { x: 4, y: 4 },
  ];
  expect(previewMutations.at(-1)).toEqual({
    type: "removeAtTiles",
    points: expected,
  });

  await runtime.commitDrag();
  expect(backend.intents.at(-1)).toEqual({
    type: "removeAtTiles",
    points: expected,
  });
});
```

Keep the existing `bulldozes a line with the remove tool drag` test. A 1 × N rectangle remains an explicit regression.

- [ ] **Step 5: Run the runtime test and verify RED**

```bash
bunx vitest run --project runtime tests/runtime/gameRuntime.test.ts -t "same inclusive rectangle"
```

Expected: FAIL because Remove still uses `axisLockedLine`.

- [ ] **Step 6: Select drag geometry once for preview and commit**

Update the runtime import:

```ts
import { axisLockedLine, rectanglePoints } from "../ui/roadDrag";
```

Add beside the existing small pure runtime helpers:

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

In `roadMutationForUi`, replace the current `axisLockedLine` call with:

```ts
const points = dragMutationPoints(
  gesture.tool,
  gesture.start,
  gesture.current,
);
```

In `commitDrag`, keep the Area early return, then derive the same `points` and use it for the single-tile, Remove, Track, and Road branches. Road and Track still receive axis-locked points.

- [ ] **Step 7: Remove the private renderer duplicate**

In `overlayRenderer.ts`:

```ts
import { axisLockedLine, rectanglePoints } from "../ui/roadDrag";
```

Delete the private `rectanglePoints` function. Keep `planAreaPaintPreview` consuming the imported helper. Do not add a Remove renderer fallback; `renderRoadMutationPreview` continues to draw Rust-provided `changedTiles` / `skippedTiles`.

- [ ] **Step 8: Run focused TypeScript tests**

```bash
bunx vitest run --project runtime tests/runtime/roadDrag.test.ts tests/runtime/gameRuntime.test.ts
bunx vitest run --project ui tests/render/overlayRenderer.test.ts
```

Expected: PASS. No new count-only renderer assertion is required because geometry is locked by the pure helper and runtime mutation test.

- [ ] **Step 9: Add a Blank Grid player smoke**

Update imports in `tests/e2e/smoke.spec.ts` to include `runtimeSnapshot`. Add:

```ts
test("demolishes an inclusive rectangle in Blank Grid", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createDefaultCity(page, "E2E City", "blankGrid");
  const canvas = page.locator("canvas[data-runtime-canvas='true']");

  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 4, y: 4 }, { x: 8, y: 4 });
  await dragMapTiles(page, canvas, { x: 4, y: 6 }, { x: 8, y: 6 });

  await selectTool(page, "demolish");
  await dragMapTiles(page, canvas, { x: 4, y: 4 }, { x: 7, y: 6 });

  await expect
    .poll(async () => {
      const tiles = (await runtimeSnapshot(page)).state.map.tiles;
      const kind = (x: number, y: number) =>
        tiles.find((tile) => tile.x === x && tile.y === y)?.kind;
      return {
        top: [4, 5, 6, 7].map((x) => kind(x, 4)),
        bottom: [4, 5, 6, 7].map((x) => kind(x, 6)),
        outsideTop: kind(8, 4),
        outsideBottom: kind(8, 6),
      };
    })
    .toEqual({
      top: ["empty", "empty", "empty", "empty"],
      bottom: ["empty", "empty", "empty", "empty"],
      outsideTop: "road",
      outsideBottom: "road",
    });
});
```

- [ ] **Step 10: Run the focused player smoke**

```bash
bunx playwright test tests/e2e/smoke.spec.ts -g "demolishes an inclusive rectangle"
```

Expected: PASS without sleeps or Crossroads starter-road dependencies.

- [ ] **Step 11: Commit the demolition slice**

```bash
git add src/ui/roadDrag.ts src/runtime/createGameRuntime.ts src/render/overlayRenderer.ts tests/runtime/roadDrag.test.ts tests/runtime/gameRuntime.test.ts tests/e2e/smoke.spec.ts
git commit -m "feat: support rectangular demolition drags"
```

---

### Task 2: Add Atomic Player Road-Contact Preflight

**Files:**
- Modify: `crates/caelum-core/src/road.rs`
- Modify: `crates/caelum-core/tests/road_authoring.rs`
- Verify unchanged: `crates/caelum-core/src/sandbox.rs`
- Verify unchanged: `crates/caelum-core/tests/sandbox_coverage.rs`

**Interfaces:**
- Produces: `pub(crate) fn road_line_footprint(points: &[Point], preset: RoadPreset) -> Vec<Point>`
- Produces privately: `validate_road_line_contacts(map, footprint, requested_axis)`
- Preserves: `author_scenario_road_line`, `merge_lane_direction`, `can_overlay_reverse_lane`

- [ ] **Step 1: Add failing player-contact tests**

In `road_authoring.rs`, use its existing Blank Grid fixture pattern and add:

```rust
#[test]
fn partial_same_axis_overlap_rejects_before_building_the_empty_tail() {
    let mut engine = one_way_engine((3..=8).map(|x| point(x, 5)).collect());
    let before = engine.snapshot();

    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: (6..=12).map(|x| point(x, 5)).collect(),
        preset: RoadPreset::TwoWay,
    });

    assert!(!result.applied);
    assert_eq!(result.snapshot, before);
    assert_eq!(
        result.rejection.as_ref().map(|rejection| &rejection.code),
        Some(&RejectionCode::BlockedTile),
    );
    assert_eq!(result.rejection.unwrap().context.point, Some(point(6, 5)));
    assert_eq!(engine.snapshot().map.tile(point(9, 5)).unwrap().kind, "empty");
}

#[test]
fn dual_reverse_lane_road_contact_rejects_before_forward_authoring() {
    let mut engine = one_way_engine((3..=8).map(|x| point(x, 5)).collect());
    let before = engine.snapshot();

    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: (3..=8).map(|x| point(x, 6)).collect(),
        preset: RoadPreset::DualBidirectional,
    });

    assert!(!result.applied);
    assert_eq!(result.snapshot, before);
    assert_eq!(
        result.rejection.as_ref().map(|rejection| &rejection.code),
        Some(&RejectionCode::BlockedTile),
    );
    assert_eq!(engine.snapshot().map.tile(point(3, 6)).unwrap().kind, "empty");
}
```

- [ ] **Step 2: Add legal crossing, endpoint T-junction, and extension tests**

```rust
#[test]
fn perpendicular_through_crossing_remains_legal() {
    let mut engine = one_way_engine((3..=8).map(|x| point(x, 5)).collect());

    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: (2..=8).map(|y| point(6, y)).collect(),
        preset: RoadPreset::TwoWay,
    });

    assert!(result.applied, "crossing should apply: {result:?}");
    let tile = result.snapshot.map.tile(point(6, 5)).unwrap();
    for heading in [Heading::North, Heading::East, Heading::South, Heading::West] {
      assert!(tile.road_connections.contains(&heading));
    }
}

#[test]
fn perpendicular_endpoint_contact_forms_a_t_junction() {
    let mut engine = one_way_engine((3..=6).map(|x| point(x, 5)).collect());

    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: (2..=5).map(|y| point(6, y)).collect(),
        preset: RoadPreset::TwoWay,
    });

    assert!(result.applied, "T-junction should apply: {result:?}");
    let tile = result.snapshot.map.tile(point(6, 5)).unwrap();
    assert!(tile.road_connections.contains(&Heading::North));
    assert!(tile.road_connections.contains(&Heading::West));
    assert!(!tile.road_connections.contains(&Heading::South));
}

#[test]
fn adjacent_empty_road_extension_remains_legal() {
    let mut engine = one_way_engine((3..=6).map(|x| point(x, 5)).collect());

    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: (7..=10).map(|x| point(x, 5)).collect(),
        preset: RoadPreset::TwoWay,
    });

    assert!(result.applied, "extension should apply: {result:?}");
    assert!(result.snapshot.map.tile(point(6, 5)).unwrap()
        .road_connections.contains(&Heading::East));
    assert!(result.snapshot.map.tile(point(7, 5)).unwrap()
        .road_connections.contains(&Heading::West));
}
```

Use the file’s existing formatting and helper functions. The T-junction assertion may include the east edge already carried by the existing endpoint; the load-bearing new edge is North.

- [ ] **Step 3: Add structure-owned contact tests**

Add one automatic-junction case and one roundabout-owned case. Each must assert:

```rust
assert!(!result.applied);
assert_eq!(result.snapshot, before);
assert_eq!(
    result.rejection.as_ref().map(|rejection| &rejection.code),
    Some(&RejectionCode::BlockedTile),
);
```

Build the automatic junction from two clean perpendicular lines. Build the roundabout through the existing `PlaceRoundabout` fixture pattern used in this test target. The attempted player line must include a structure footprint tile.

- [ ] **Step 4: Run the focused tests and verify RED/unchanged controls**

```bash
cargo test -p caelum-core --test road_authoring partial_same_axis_overlap -- --nocapture
cargo test -p caelum-core --test road_authoring dual_reverse_lane_road_contact -- --nocapture
cargo test -p caelum-core --test road_authoring perpendicular_through_crossing -- --nocapture
cargo test -p caelum-core --test road_authoring perpendicular_endpoint_contact -- --nocapture
cargo test -p caelum-core --test road_authoring adjacent_empty_road_extension -- --nocapture
```

Expected: overlap tests RED; clean crossing, T-junction, and adjacent extension remain GREEN. A legal-control failure must be investigated before implementing preflight.

- [ ] **Step 5: Derive the complete footprint with existing helpers**

Add near `reverse_lane_points`:

```rust
pub(crate) fn road_line_footprint(points: &[Point], preset: RoadPreset) -> Vec<Point> {
    let mut footprint = points.to_vec();
    if preset == RoadPreset::DualBidirectional {
        if let Some(direction) = canonical_line_direction(points) {
            if !reverse_lane_offset_overflows(points, direction) {
                footprint.extend(reverse_lane_points(points, direction));
            }
        }
    }
    deduplicate_points(&mut footprint);
    footprint
}
```

This is the only new Dual geometry helper. Do not duplicate `reverse_lane_points` or `deduplicate_points`.

- [ ] **Step 6: Implement contact classification with existing `has_axis`**

Add:

```rust
fn validate_road_line_contacts(
    map: &GameMap,
    footprint: &[Point],
    requested_axis: Heading,
) -> GameplayResult<()> {
    let requested_horizontal = matches!(requested_axis, Heading::East | Heading::West);

    for point in footprint {
        let Some(tile) = map.tile(*point) else {
            continue;
        };
        if tile.kind != "road" {
            continue;
        }
        if tile.road_structure_id.is_some()
            || crate::roundabouts::is_roundabout_owned(map, *point)
        {
            return Err(GameplayRejection::at(RejectionCode::BlockedTile, *point));
        }

        let has_requested = has_axis(&tile.road_connections, requested_horizontal);
        let has_perpendicular = has_axis(&tile.road_connections, !requested_horizontal);
        if has_requested || !has_perpendicular {
            return Err(GameplayRejection::at(RejectionCode::BlockedTile, *point));
        }
    }

    Ok(())
}
```

This accepts only an ordinary road with perpendicular-axis evidence. Same-axis, mixed-axis, and axis-less roads reject.

- [ ] **Step 7: Call preflight before spacing, cost, or mutation**

In `lay_road_line`:

1. keep the existing empty-points and subtraction-overflow checks;
2. compute `forward` and `dual_direction` as today;
3. keep the existing reverse-lane-offset overflow rejection;
4. when `dual_direction` is `Some`, derive the footprint and call `validate_road_line_contacts`;
5. only then run `validate_one_way_parallel_spacing` and author lanes.

Use this shape:

```rust
let forward = line_direction(points);
let dual_direction = canonical_line_direction(points);
if preset == RoadPreset::DualBidirectional {
    if let Some(direction) = dual_direction {
        if reverse_lane_offset_overflows(points, direction) {
            return Err(GameplayRejection::at(
                RejectionCode::InvalidRoadStroke,
                points[0],
            ));
        }
    }
}
if let Some(requested_axis) = dual_direction {
    let footprint = road_line_footprint(points, preset);
    validate_road_line_contacts(&original.map, &footprint, requested_axis)?;
}
if preset == RoadPreset::OneWay {
    if let Some(direction) = forward {
        validate_one_way_parallel_spacing(&original.map, points, direction)?;
    }
}
```

Keeping the `Some` gate preserves the existing single-coordinate/duplicate-coordinate host behavior; the real UI supplies an axis-locked non-zero line for multi-tile drags.

- [ ] **Step 8: Remove the player reverse-lane policy without touching scenario authoring**

Remove `reverse_lane` from player `author_lane_tiles` and both player call sites. Delete only this player branch:

```rust
if reverse_lane && !can_overlay_reverse_lane(&existing, direction) {
    continue;
}
```

For an existing road after preflight, keep:

```rust
let Some(tile) = candidate.map.tile_mut(*point) else {
    continue;
};
merge_lane_direction(tile, direction);
lane.points.push(*point);
continue;
```

Do **not** delete or rename `merge_lane_direction` or `can_overlay_reverse_lane`; `author_scenario_road_line` still uses both for deterministic template construction.

- [ ] **Step 9: Run focused road and sandbox controls**

```bash
cargo test -p caelum-core --test road_authoring partial_same_axis_overlap -- --nocapture
cargo test -p caelum-core --test road_authoring dual_reverse_lane_road_contact -- --nocapture
cargo test -p caelum-core --test road_authoring perpendicular_ -- --nocapture
cargo test -p caelum-core --test road_authoring adjacent_empty_road_extension -- --nocapture
cargo test -p caelum-core --test road_authoring road_line_cannot_repaint -- --nocapture
cargo test -p caelum-core --test sandbox_coverage -- --nocapture
```

Expected: player-contact tests PASS and built-in sandbox tests remain PASS.

- [ ] **Step 10: Commit player preflight**

```bash
git add crates/caelum-core/src/road.rs crates/caelum-core/tests/road_authoring.rs
git commit -m "fix: reject player road overlap before authoring"
```

---

### Task 3: Retarget Overlay Fixtures and Complete Rejected Preview

**Files:**
- Modify: `crates/caelum-core/src/preview.rs`
- Modify: `crates/caelum-core/tests/transit_build.rs`
- Modify: `crates/caelum-core/tests/road_authoring.rs`
- Modify: `crates/caelum-core/tests/dual_road_routing.rs`

**Interfaces:**
- Consumes: `road::road_line_footprint`
- Preserves: scenario template authoring and accepted preview wire format
- Produces: full rejected Dual footprint

- [ ] **Step 1: Inventory every old player-overlay fixture before editing**

Run:

```bash
rg -n 'LayRoadLine|lay_road_line' crates/caelum-core/tests
rg -n 'overlay|upgrade|idempotent|already matches|existing road|skips reverse|updates direction|continuation seam' crates/caelum-core/tests
```

The known inventory that must be addressed is:

```text
transit_build.rs
  lay_road_line_dual_bidirectional_adds_left_reverse_lane_without_hijacking_existing_roads
  lay_road_line_one_way_is_idempotent_when_direction_already_matches
  lay_road_line_dual_bidirectional_skips_reverse_lane_when_tile_is_occupied
  lay_road_line_one_way_over_two_way_road_updates_direction

road_authoring.rs
  road_stroke_keeps_scanning_to_a_later_free_existing_road_overlay
  one_way_overlay_is_checked_before_merge_lane_direction

dual_road_routing.rs
  recapture_dual_crossing_after_horizontal_then_vertical_upgrade_has_all_four_internal_edges
  recapture_dual_crossing_after_vertical_then_horizontal_upgrade_has_all_four_internal_edges
  recapture_dual_crossing_after_preexisting_one_way_overlay_has_all_four_internal_edges
  recapture_dual_crossing_built_across_colinear_continuation_seam_has_all_four_internal_edges
  dual_intersection_engine TwoWay-on-Dual stop-access setup
```

Keep unrelated blocked-tile skips, budget exhaustion, duplicate-point, and scenario-template tests.

- [ ] **Step 2: Retarget `transit_build.rs` overlay tests**

Apply these dispositions:

- replace the two reverse-lane existing-road success tests with one atomic `BlockedTile` test that checks unchanged snapshot/budget and no forward lane;
- rewrite matching OneWay re-lay to expect `BlockedTile`, not idempotent unchanged;
- rewrite TwoWay-to-OneWay direction update to expect `BlockedTile`, not repaint.

Use the common assertion shape:

```rust
let before = engine.snapshot();
let result = engine.dispatch(GameIntent::LayRoadLine { points, preset });
assert!(!result.applied);
assert_eq!(result.snapshot, before);
assert_eq!(
    result.rejection.as_ref().map(|rejection| &rejection.code),
    Some(&RejectionCode::BlockedTile),
);
```

Delete the redundant second reverse-lane test after the surviving test covers a conflict on the generated carriageway and verifies the forward carriageway stayed empty.

- [ ] **Step 3: Retarget `road_authoring.rs` order/atomicity tests**

- delete `road_stroke_keeps_scanning_to_a_later_free_existing_road_overlay` when Task 2’s partial-overlap test covers its budget/empty-tail invariant;
- rename `one_way_overlay_is_checked_before_merge_lane_direction` to `one_way_overlap_rejects_before_parallel_spacing` and expect `BlockedTile` at the overlay point.

The latter locks the new validation order: overlap preflight wins before `OneWayParallelTooClose`.

- [ ] **Step 4: Rewrite dual-road fixtures to valid player sequences**

In `dual_road_routing.rs`:

- delete the three upgrade-in-place recapture tests;
- rewrite the continuation test so the second segment begins at `x = 10`, adjacent to the prior segment ending at `x = 9`;
- rename it `dual_crossing_after_adjacent_colinear_extension_has_all_four_internal_edges`.

Add a helper for stop-access fixture replacement:

```rust
fn replace_lane_stretch_with_two_way(engine: &mut GameEngine, points: Vec<Point>) {
    dispatch(
        engine,
        GameIntent::RemoveAtTiles {
            points: points.clone(),
        },
    );
    dispatch(
        engine,
        GameIntent::LayRoadLine {
            points,
            preset: RoadPreset::TwoWay,
        },
    );
}
```

In `dual_intersection_engine`, replace the two illegal TwoWay overlays with:

```rust
replace_lane_stretch_with_two_way(
    &mut engine,
    (8..=12).map(|x| point(x, 3)).collect(),
);
replace_lane_stretch_with_two_way(
    &mut engine,
    (4..=6).map(|y| point(6, y)).collect(),
);
```

Keep the stop positions and left-turn route oracle unchanged. The remove-then-relay sequence explicitly produces empty tiles before player `LayRoadLine`.

- [ ] **Step 5: Add rejected Dual preview parity**

In `road_authoring.rs`, add:

```rust
#[test]
fn dual_reverse_lane_overlap_preview_shows_both_carriageways() {
    let mut engine = one_way_engine((3..=6).map(|x| point(x, 5)).collect());
    let points: Vec<_> = (3..=6).map(|x| point(x, 6)).collect();
    let mutation = RoadMutation::LayRoadLine {
        points: points.clone(),
        preset: RoadPreset::DualBidirectional,
    };

    let preview = engine.preview_road_mutation(RoadMutationPreviewRequest {
        mutation,
        generation: 41,
    });

    assert_eq!(
        preview.rejection.as_ref().map(|rejection| &rejection.code),
        Some(&RejectionCode::BlockedTile),
    );
    assert_eq!(
        preview.changed_tiles,
        vec![
            point(3, 6),
            point(4, 6),
            point(5, 6),
            point(6, 6),
            point(3, 5),
            point(4, 5),
            point(5, 5),
            point(6, 5),
        ],
    );

    let before = engine.snapshot();
    let committed = engine.dispatch(GameIntent::LayRoadLine {
        points,
        preset: RoadPreset::DualBidirectional,
    });
    assert!(!committed.applied);
    assert_eq!(committed.snapshot, before);
    assert_eq!(committed.rejection, preview.rejection);
}
```

- [ ] **Step 6: Use the shared footprint for rejected line previews**

Change `preview.rs::attempted_mutation_tiles` to separate Road and Remove lines:

```rust
fn attempted_mutation_tiles(mutation: &RoadMutation) -> Vec<Point> {
    match mutation {
        RoadMutation::LayRoad { point }
        | RoadMutation::CycleRoadDirection { point }
        | RoadMutation::RemoveAtTile { point } => vec![*point],
        RoadMutation::LayRoadLine { points, preset } => {
            road::road_line_footprint(points, *preset)
        }
        RoadMutation::RemoveAtTiles { points } => points.clone(),
        RoadMutation::PlaceRoundabout { origin, .. } => vec![*origin],
    }
}
```

Accepted preview normalization and route-impact calculation stay unchanged.

- [ ] **Step 7: Run the rewritten targets and the full core suite**

```bash
cargo test -p caelum-core --test transit_build lay_road_line_ -- --nocapture
cargo test -p caelum-core --test road_authoring -- --nocapture
cargo test -p caelum-core --test dual_road_routing -- --nocapture
cargo test -p caelum-core --test sandbox_coverage -- --nocapture
cargo test -p caelum-core -- --nocapture
```

Expected: PASS. Any remaining old-contract failure is rewritten or removed; do not modify preflight to restore overlay.

- [ ] **Step 8: Re-run the inventory search**

```bash
rg -n 'overlay|upgrade|idempotent|already matches|existing road|skips reverse|updates direction|continuation seam' crates/caelum-core/tests
```

Review every remaining match. It may remain only when it describes scenario authoring, single-tile direction editing, removal/rebuild, or a non-road blocked-tile skip.

- [ ] **Step 9: Commit fixture migration and preview parity**

```bash
git add crates/caelum-core/src/preview.rs crates/caelum-core/tests/transit_build.rs crates/caelum-core/tests/road_authoring.rs crates/caelum-core/tests/dual_road_routing.rs
git commit -m "test: align road fixtures with no-overlap authoring"
```

---

### Task 4: Characterize Clean Dual Junctions and Verify the PR

**Files:**
- Modify: `crates/caelum-core/tests/dual_road_routing.rs`
- Do not modify from this plan: `crates/caelum-core/src/road_topology.rs`
- Verify all files changed in Tasks 1–3

**Interfaces:**
- Produces test helper: `assert_dual_crossing_contract`
- Produces test helper: `assert_access_path`
- No new production interface

- [ ] **Step 1: Extend the existing crossing helper with exact ports**

Add:

```rust
fn assert_dual_crossing_contract(snapshot: &GameSnapshot, top_left: Point) {
    assert_two_by_two_footprint(snapshot, top_left);
    assert_complete_two_by_two_at(snapshot, top_left);

    let junction = snapshot
        .map
        .road_structures
        .iter()
        .find(|structure| {
            structure.is_automatic_junction()
                && structure.footprint()
                    == [
                        top_left,
                        point(top_left.x + 1, top_left.y),
                        point(top_left.x, top_left.y + 1),
                        point(top_left.x + 1, top_left.y + 1),
                    ]
        })
        .expect("expected 2x2 automatic junction");

    assert_eq!(
        junction.port_keys(),
        vec![
            (top_left, Heading::North),
            (top_left, Heading::West),
            (point(top_left.x, top_left.y + 1), Heading::South),
            (point(top_left.x, top_left.y + 1), Heading::West),
            (point(top_left.x + 1, top_left.y), Heading::North),
            (point(top_left.x + 1, top_left.y), Heading::East),
            (point(top_left.x + 1, top_left.y + 1), Heading::East),
            (point(top_left.x + 1, top_left.y + 1), Heading::South),
        ],
    );
}
```

Copy the canonical order from the existing fixture assertion exactly.

- [ ] **Step 2: Add compiled access-path assertions**

```rust
fn assert_access_path(
    engine: &GameEngine,
    from: Point,
    to: Point,
    from_heading: Heading,
    to_heading: Heading,
) {
    let snapshot = engine.snapshot();
    let path = engine
        .road_topology_for_test()
        .find_path_between_access_tiles(
            &snapshot.map,
            from,
            to,
            Some(from_heading),
            Some(to_heading),
        )
        .unwrap_or_else(|reason| {
            panic!("expected path {from:?} -> {to:?}, got {reason:?}")
        });
    assert!(!path.road_steps().is_empty());
}
```

For the canonical `(6,2)` junction, assert:

```rust
assert_access_path(
    &engine,
    point(5, 3),
    point(8, 3),
    Heading::East,
    Heading::East,
);
assert_access_path(
    &engine,
    point(6, 1),
    point(6, 4),
    Heading::South,
    Heading::South,
);
```

Keep `dual_bidirectional_route_uses_the_legal_left_turn_and_lane` as the real turning-path assertion after its fixture rewrite.

- [ ] **Step 3: Apply the full contract to valid sequence fixtures**

Update these fixtures to call `assert_dual_crossing_contract` and the two access paths:

- horizontal-first clean crossing;
- vertical-first clean crossing;
- adjacent-empty collinear extension;
- existing dual endpoint T-junction.

Add reverse-input fixtures:

```rust
#[test]
fn reversed_horizontal_input_keeps_the_dual_crossing_contract() {
    let mut engine = blank_grid_engine();
    lay(
        &mut engine,
        (2..=12).rev().map(|x| point(x, 3)).collect(),
        RoadPreset::DualBidirectional,
    );
    lay(
        &mut engine,
        (0..=7).map(|y| point(6, y)).collect(),
        RoadPreset::DualBidirectional,
    );
    assert_dual_crossing_contract(&engine.snapshot(), point(6, 2));
}

#[test]
fn reversed_vertical_input_keeps_the_dual_crossing_contract() {
    let mut engine = blank_grid_engine();
    lay(
        &mut engine,
        (2..=12).map(|x| point(x, 3)).collect(),
        RoadPreset::DualBidirectional,
    );
    lay(
        &mut engine,
        (0..=7).rev().map(|y| point(6, y)).collect(),
        RoadPreset::DualBidirectional,
    );
    assert_dual_crossing_contract(&engine.snapshot(), point(6, 2));
}
```

Add the path assertions to both reverse-input tests as well.

- [ ] **Step 4: Run the characterization matrix before any topology edit**

```bash
cargo test -p caelum-core --test dual_road_routing horizontal_first_dual_intersection -- --nocapture
cargo test -p caelum-core --test dual_road_routing vertical_first_dual_intersection -- --nocapture
cargo test -p caelum-core --test dual_road_routing reversed_ -- --nocapture
cargo test -p caelum-core --test dual_road_routing adjacent_colinear_extension -- --nocapture
cargo test -p caelum-core --test dual_road_routing dual_t_junction -- --nocapture
cargo test -p caelum-core --test dual_road_routing dual_bidirectional_route_uses_the_legal_left_turn -- --nocapture
```

Read failures in this order:

1. footprint;
2. internal reciprocal edge;
3. exact boundary port;
4. compiled straight path;
5. route-preview turn.

- [ ] **Step 5: Follow the evidence gate**

When every command is GREEN:

```bash
git add crates/caelum-core/tests/dual_road_routing.rs
git commit -m "test: lock clean dual-road crossing connectivity"
```

When any command is RED:

1. leave `road.rs` and `road_topology.rs` unchanged;
2. record the first failing assertion, fixture sequence, tile/edge/port, and path reason in the implementation PR;
3. trace that exact seam under the systematic-debugging workflow;
4. update this plan with the confirmed minimal production change before implementing it.

Do not add a generic 2 × 2 completion helper, synthetic port insertion, or broadened transition generation from this plan.

- [ ] **Step 6: Run complete repository verification**

```bash
git diff --check
cargo fmt --all --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
bun run format:check
bun run check
bun run lint
bun run test:unit
bun run test:e2e
bun run build
```

Expected: every command exits 0. Report any environment/tooling failure separately from a code failure; do not claim the suite passed without the full output.

- [ ] **Step 7: Inspect the final PR scope**

```bash
git status --short
git diff --stat origin/main...HEAD
git diff --name-only origin/main...HEAD
```

Expected production scope:

```text
src/ui/roadDrag.ts
src/runtime/createGameRuntime.ts
src/render/overlayRenderer.ts
crates/caelum-core/src/road.rs
crates/caelum-core/src/preview.rs
```

Expected test scope:

```text
tests/runtime/roadDrag.test.ts
tests/runtime/gameRuntime.test.ts
tests/e2e/smoke.spec.ts
crates/caelum-core/tests/transit_build.rs
crates/caelum-core/tests/road_authoring.rs
crates/caelum-core/tests/dual_road_routing.rs
```

`crates/caelum-core/src/road_topology.rs`, host adapters, persistence, schemas, and sandbox production files should be absent unless a separately documented RED investigation revised this plan.
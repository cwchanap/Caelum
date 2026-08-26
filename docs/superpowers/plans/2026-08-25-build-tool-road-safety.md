# Build-Tool Road Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add inclusive rectangular demolition, reject axis-resolved player road overlap atomically, preserve deterministic scenario and host-only stroke behavior, and characterize clean dual-road junction connectivity.

**Architecture:** TypeScript selects deterministic drag geometry and sends the existing intents. Before changing Rust authoring, inventory every core-test `LayRoadLine` use and classify it as a product-contract fixture or incidental scenery. `caelum-core` then applies one complete-footprint preflight only to non-degenerate single-axis player strokes; scenario authoring and bent/degenerate host strokes retain their existing paths. Production topology stays unchanged unless the post-migration characterization matrix is RED and this plan is revised with the confirmed seam.

**Tech Stack:** Rust (`caelum-core`), TypeScript, Svelte runtime/canvas rendering, Vitest, Playwright, Bun, Cargo

**Spec:** `docs/superpowers/specs/2026-08-25-build-tool-road-safety-design.md`

## Global Constraints

- Deliver implementation and tests in the existing **single HPA-551 PR**.
- Keep `GameBackend`, WASM, Tauri, `GameIntent`, and `DragGesture` interfaces unchanged.
- Road and Track remain axis-locked; only Demolish changes to rectangular geometry.
- Rust owns road-contact validity; do not classify overlap in TypeScript.
- Strict preflight applies only to adjacent, non-degenerate points that all travel in one cardinal direction—the shape emitted by `axisLockedLine`.
- Validate both Dual carriageways against the original map before one-way spacing, cost, or mutation.
- Keep single-tile `LayRoad` / `CycleRoadDirection` behavior unchanged.
- Keep bent, loop, duplicate, and backtracking host-stroke behavior unchanged.
- Keep `author_scenario_road_line` merge-on-contact behavior for Crossroads and Small Town.
- Reuse `heading_between`, `has_axis`, `reverse_lane_points`, and `deduplicate_points`; do not add equivalent helpers.
- Use existing `BlockedTile`; add no rejection enum or message.
- Existing-road contact rejects atomically; non-road obstruction and affordability retain current per-tile skip/ordered-budget semantics.
- Classify every core-test `LayRoadLine` hit before editing production code.
- Do not commit a Rust step until `cargo test --workspace` is GREEN.
- Do not add production topology code from this plan. A post-migration RED result requires root-cause evidence and a plan update first.
- Add no dependency, save field, schema bump, migration, provenance model, compatibility wrapper, or generic road framework.

## File Structure

- `src/ui/roadDrag.ts` — shared line and rectangle point generation.
- `src/runtime/createGameRuntime.ts` — choose geometry once for preview and commit.
- `src/render/overlayRenderer.ts` — consume shared rectangle geometry for Area preview.
- `crates/caelum-core/src/road.rs` — axis-resolved player footprint/contact preflight; scenario and host-only policies remain separate.
- `crates/caelum-core/src/preview.rs` — full rejected Dual footprint.
- `tests/runtime/roadDrag.test.ts` — pure rectangle ordering.
- `tests/runtime/gameRuntime.test.ts` — preview/commit geometry and existing line regression.
- `tests/e2e/smoke.spec.ts` — Blank Grid rectangular demolition journey.
- `crates/caelum-core/tests/road_authoring.rs` — overlap, T-junction, extension, non-road skip, host controls, and preview parity.
- `crates/caelum-core/tests/transit_build.rs` — retarget old line-overlay contracts.
- `crates/caelum-core/tests/dual_road_routing.rs` — legal fixture rewrite, reproduction mapping, and layered junction characterization.
- `crates/caelum-core/tests/transit_router.rs` — rebuild incidental loop approaches without overlap while preserving turnaround recovery.
- Any additional test file identified by the mandatory pre-edit inventory — either unchanged with a recorded “clean/disjoint” disposition or legally rebuilt while preserving its original assertion.

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
- Consumed by: the existing Rust removal preview and dispatch paths

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

- [ ] **Step 3: Move the existing row-major rectangle algorithm**

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

Keep `bulldozes a line with the remove tool drag`. A 1 × N rectangle remains a separate regression.

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

Delete the private `rectanglePoints` function. Keep `planAreaPaintPreview` consuming the imported helper.

Do not add a Remove renderer fallback. `renderRoadMutationPreview` remains the only source of changed/skipped/route-impact preview geometry.

- [ ] **Step 8: Run focused TypeScript tests**

```bash
bunx vitest run --project runtime tests/runtime/roadDrag.test.ts tests/runtime/gameRuntime.test.ts
bunx vitest run --project ui tests/render/overlayRenderer.test.ts
```

Expected: PASS. No count-only renderer assertion is added because geometry is already locked by the pure helper and runtime mutation test.

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

### Task 2: Inventory, Implement, and Migrate the Atomic Player Road Preflight

**Files:**
- Modify: `crates/caelum-core/src/road.rs`
- Modify: `crates/caelum-core/tests/road_authoring.rs`
- Modify: `crates/caelum-core/tests/transit_build.rs`
- Modify: `crates/caelum-core/tests/dual_road_routing.rs`
- Modify: `crates/caelum-core/tests/transit_router.rs`
- Modify only when identified by the inventory: another `crates/caelum-core/tests/*.rs` scenery fixture
- Verify unchanged: `crates/caelum-core/src/sandbox.rs`
- Verify unchanged: `crates/caelum-core/tests/sandbox_coverage.rs`

**Interfaces:**
- Produces privately: `axis_resolved_stroke_direction(points: &[Point]) -> Option<Heading>`
- Produces: `pub(crate) fn road_line_footprint(points: &[Point], preset: RoadPreset) -> Vec<Point>`
- Produces privately: `validate_road_line_contacts(map, footprint, requested_axis)`
- Preserves: `author_scenario_road_line`, `merge_lane_direction`, `can_overlay_reverse_lane`
- Preserves: current duplicate/bent/loop host mutation behavior

- [ ] **Step 0: Inventory every core-test line fixture before production edits**

Run:

```bash
rg -n 'LayRoadLine|lay_road_line' crates/caelum-core/tests
```

The current code search spans 24 core-test files. Add this section to PR #54 before editing `road.rs`:

```markdown
## LayRoadLine fixture inventory

| File / fixture | Class | Disposition |
| --- | --- | --- |
| transit_router.rs / terminal_turnaround_recovers_after_a_roundabout_is_placed | scenery | shorten both OneWay approaches so they attach from adjacent empty tiles; keep turnaround assertions |
| dual_road_routing.rs / dual_intersection_engine TwoWay approach conversions | scenery | remove selected Dual stretches, relay TwoWay on empty tiles; keep stop/turn assertions |
| transit_build.rs / lay_road_line_dual_bidirectional_adds_left_reverse_lane_without_hijacking_existing_roads | contract | retarget to atomic BlockedTile |
| transit_build.rs / lay_road_line_one_way_is_idempotent_when_direction_already_matches | contract | retarget to atomic BlockedTile |
| transit_build.rs / lay_road_line_dual_bidirectional_skips_reverse_lane_when_tile_is_occupied | contract | retarget to atomic BlockedTile and assert forward lane absent |
| transit_build.rs / lay_road_line_one_way_over_two_way_road_updates_direction | contract | retarget to atomic BlockedTile |
| road_authoring.rs / road_stroke_keeps_scanning_to_a_later_free_existing_road_overlay | contract | replace with partial-overlap atomicity |
| road_authoring.rs / one_way_overlay_is_checked_before_merge_lane_direction | contract | expect BlockedTile before spacing |
| dual_road_routing.rs / three upgrade/overlay recaptures | contract + symptom evidence | map to atomic rejection plus clean full-contract fixtures |
| dual_road_routing.rs / collinear continuation seam | contract setup | start the extension on the adjacent empty tile |
| transit_build.rs / lay_road_line_dual_bidirectional_skips_building_occupied_reverse_tile | non-road skip control | keep unchanged |
| road_authoring.rs / partial_stroke_skips_invalid_tiles_in_input_order | non-road skip control | keep unchanged |
| road_authoring.rs / budget_limited_road_stroke_diverges_only_by_ordered_affordability | affordability control | keep unchanged |
| road_authoring.rs / duplicate_road_points_contribute_nominal_cost_once | host-control | keep unchanged |
| road_authoring.rs / dual_bidirectional_overlapping_carriageways_charge_each_new_tile_once | host-control | keep unchanged |
| every remaining hit | clean/disjoint, host-control, contract, scenery, non-road skip, or affordability | record one explicit disposition; do not leave an unclassified hit |
```

Classification rules:

```text
contract:
  overlay/repaint/partial-upgrade/idempotent re-lay is the assertion
  -> retarget to BlockedTile or a legal clean equivalent

scenery:
  routing/persistence/service/topology behavior is the assertion
  -> rebuild the map legally and keep the assertion

host-control:
  duplicate/bent/loop payload behavior is the assertion
  -> preserve unchanged; strict player preflight must not run

clean/disjoint:
  no existing-road contact
  -> no code change; record that it remains covered by cargo test --workspace
```

Do not begin Step 1 until every hit has a disposition in the PR.

- [ ] **Step 1: Add failing player-contact and legal-control tests**

In `road_authoring.rs`, add:

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

- [ ] **Step 2: Add explicit scope and partial-application controls**

Keep `partial_stroke_skips_invalid_tiles_in_input_order`,
`budget_limited_road_stroke_diverges_only_by_ordered_affordability`,
`duplicate_road_points_contribute_nominal_cost_once`, and
`dual_bidirectional_overlapping_carriageways_charge_each_new_tile_once`.

Add one control proving that a degenerate host payload does not enter the strict player preflight:

```rust
#[test]
fn duplicate_point_host_stroke_retains_existing_merge_semantics() {
    let initial = create_initial_snapshot();
    let prepared = apply_road_mutation(
        &initial,
        &RoadMutation::LayRoad {
            point: point(2, 2),
        },
    )
    .expect("fixture road should apply")
    .snapshot;

    let result = apply_road_mutation(
        &prepared,
        &RoadMutation::LayRoadLine {
            points: vec![point(2, 2), point(2, 2), point(3, 2)],
            preset: RoadPreset::TwoWay,
        },
    )
    .expect("degenerate host stroke keeps existing semantics");

    assert_eq!(result.snapshot.map.tile(point(2, 2)).unwrap().kind, "road");
    assert_eq!(result.snapshot.map.tile(point(3, 2)).unwrap().kind, "road");
    assert_eq!(result.cost, ROAD_COST);
}
```

Add structure-owned tests. Each must assert whole-stroke `BlockedTile` and unchanged snapshot:

```rust
assert!(!result.applied);
assert_eq!(result.snapshot, before);
assert_eq!(
    result.rejection.as_ref().map(|rejection| &rejection.code),
    Some(&RejectionCode::BlockedTile),
);
```

Build the automatic junction from clean perpendicular lines. Build the roundabout through the existing `PlaceRoundabout` fixture pattern. The attempted line must include one owned footprint tile.

- [ ] **Step 3: Run RED and unchanged controls before implementation**

```bash
cargo test -p caelum-core --test road_authoring partial_same_axis_overlap -- --nocapture
cargo test -p caelum-core --test road_authoring dual_reverse_lane_road_contact -- --nocapture
cargo test -p caelum-core --test road_authoring perpendicular_ -- --nocapture
cargo test -p caelum-core --test road_authoring adjacent_empty_road_extension -- --nocapture
cargo test -p caelum-core --test road_authoring partial_stroke_skips_invalid_tiles_in_input_order -- --nocapture
cargo test -p caelum-core --test road_authoring duplicate_point_host_stroke -- --nocapture
```

Expected:

- overlap tests: RED;
- through-crossing, T-junction, extension, non-road skip, and host-control tests: GREEN.

Investigate any legal/control failure before changing production code.

- [ ] **Step 4: Add the narrow axis-resolved preflight gate**

Add near `line_direction`:

```rust
fn axis_resolved_stroke_direction(points: &[Point]) -> Option<Heading> {
    let mut pairs = points.windows(2);
    let first = pairs.next()?;
    let direction = heading_between(first[0], first[1])?;
    pairs
        .all(|pair| heading_between(pair[0], pair[1]) == Some(direction))
        .then_some(direction)
}
```

This accepts the exact straight adjacent-point shape emitted by `axisLockedLine`, including a complete line supplied in reverse order. It returns `None` for duplicate, bent, loop, jumping, or backtracking payloads.

Do not change `line_direction` or `canonical_line_direction`; they continue to own the broader host behavior.

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

1. keep empty-points and subtraction-overflow checks;
2. compute `forward` and `dual_direction` as today;
3. keep reverse-lane-offset overflow rejection for Dual;
4. call strict contact validation only when `axis_resolved_stroke_direction(points)` is `Some`;
5. only then run OneWay parallel-spacing validation and author lanes.

Use:

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
if let Some(requested_axis) = axis_resolved_stroke_direction(points) {
    let footprint = road_line_footprint(points, preset);
    validate_road_line_contacts(&original.map, &footprint, requested_axis)?;
}
if preset == RoadPreset::OneWay {
    if let Some(direction) = forward {
        validate_one_way_parallel_spacing(&original.map, points, direction)?;
    }
}
```

This ordering makes axis-resolved road overlap `BlockedTile` before `OneWayParallelTooClose`, budget, or mutation. Non-road tiles are not rejected by this validator and continue through existing skip semantics.

- [ ] **Step 8: Remove only the player reverse-lane policy**

Remove `reverse_lane` from player `author_lane_tiles` and both player call sites. Delete only:

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

Do **not** delete or rename `merge_lane_direction` or `can_overlay_reverse_lane`; `author_scenario_road_line` still uses both.

- [ ] **Step 9: Rebuild known scenery fixtures legally**

In `transit_router.rs::terminal_turnaround_recovers_after_a_roundabout_is_placed`, replace the overlapping approaches:

```rust
points: (1..=3).map(|x| point(x, 3)).collect(),
```

with:

```rust
points: (1..=2).map(|x| point(x, 3)).collect(),
```

and replace:

```rust
points: (4..=6).rev().map(|x| point(x, 3)).collect(),
```

with:

```rust
points: (5..=6).rev().map(|x| point(x, 3)).collect(),
```

Keep every turnaround, route-rejection, roundabout-placement, recovered-path, and movement assertion unchanged.

In `dual_road_routing.rs::dual_intersection_engine`, replace each TwoWay-on-Dual overlay with remove-then-relay:

```rust
let horizontal_two_way: Vec<_> = (8..=12).map(|x| point(x, 3)).collect();
dispatch(
    &mut engine,
    GameIntent::RemoveAtTiles {
        points: horizontal_two_way.clone(),
    },
);
dispatch(
    &mut engine,
    GameIntent::LayRoadLine {
        points: horizontal_two_way,
        preset: RoadPreset::TwoWay,
    },
);

let vertical_two_way: Vec<_> = (4..=6).map(|y| point(6, y)).collect();
dispatch(
    &mut engine,
    GameIntent::RemoveAtTiles {
        points: vertical_two_way.clone(),
    },
);
dispatch(
    &mut engine,
    GameIntent::LayRoadLine {
        points: vertical_two_way,
        preset: RoadPreset::TwoWay,
    },
);
```

Preserve the stop anchors, preferred-heading assertions, route preview, and legal left-turn/lane assertions.

Apply the same “legal setup, same assertion” rule to every additional scenery fixture identified in Step 0.

- [ ] **Step 10: Retarget known contract fixtures**

Use this exact disposition table:

| Existing test | Replacement contract |
| --- | --- |
| `lay_road_line_dual_bidirectional_adds_left_reverse_lane_without_hijacking_existing_roads` | rename to reverse-lane existing-road contact rejection; assert `BlockedTile`, unchanged snapshot/budget, no forward tile |
| `lay_road_line_one_way_is_idempotent_when_direction_already_matches` | identical line re-lay rejects `BlockedTile`; unchanged snapshot/budget |
| `lay_road_line_dual_bidirectional_skips_reverse_lane_when_tile_is_occupied` | whole Dual rejects `BlockedTile`; existing tile unchanged; no forward tile |
| `lay_road_line_one_way_over_two_way_road_updates_direction` | repaint rejects `BlockedTile`; use single-tile direction cycling as the retained edit behavior |
| `road_stroke_keeps_scanning_to_a_later_free_existing_road_overlay` | replace with `partial_same_axis_overlap_rejects_before_building_the_empty_tail` |
| `one_way_overlay_is_checked_before_merge_lane_direction` | expect `BlockedTile`, not `OneWayParallelTooClose` |
| collinear continuation fixture repeating endpoint | start second segment at the adjacent empty tile |
| three upgrade/overlay recaptures | remove after adding the explicit mapping below and the atomic rejection coverage |

For every atomic rejection test, assert all four:

```rust
assert!(!result.applied);
assert_eq!(result.snapshot, before);
assert_eq!(
    result.rejection.as_ref().map(|rejection| &rejection.code),
    Some(&RejectionCode::BlockedTile),
);
assert_eq!(engine.snapshot().budget, before.budget);
```

For reverse-lane conflicts, also assert a representative forward tile remains `"empty"`.

Add this mapping comment beside the clean dual-crossing tests and to the PR body:

```text
horizontal-then-vertical upgrade reproduction
  -> atomic upgrade rejection
  -> horizontal_first_dual_intersection full clean contract

vertical-then-horizontal upgrade reproduction
  -> atomic upgrade rejection
  -> vertical_first_dual_intersection full clean contract

pre-existing OneWay overlay reproduction
  -> atomic OneWay/Dual repaint rejection
  -> clean horizontal-first + reversed-input Dual characterization
```

- [ ] **Step 11: Run focused controls and the full workspace before committing**

```bash
cargo test -p caelum-core --test road_authoring -- --nocapture
cargo test -p caelum-core --test transit_build -- --nocapture
cargo test -p caelum-core --test transit_router terminal_turnaround_recovers_after_a_roundabout_is_placed -- --nocapture
cargo test -p caelum-core --test dual_road_routing dual_bidirectional_route_uses_the_legal_left_turn_and_lane -- --nocapture
cargo test -p caelum-core --test sandbox_coverage -- --nocapture
cargo test --workspace
```

Expected: every command exits 0. Do not commit a preflight change while any fixture remains red.

- [ ] **Step 12: Commit the green preflight and fixture migration**

```bash
git add crates/caelum-core/src/road.rs crates/caelum-core/tests/road_authoring.rs crates/caelum-core/tests/transit_build.rs crates/caelum-core/tests/dual_road_routing.rs crates/caelum-core/tests/transit_router.rs
git add crates/caelum-core/tests
git commit -m "fix: reject player road overlap before authoring"
```

`git add crates/caelum-core/tests` intentionally includes any additional scenery fixture changed after the Step 0 inventory. Review `git diff --cached --name-only` before committing and ensure no unrelated test file is staged.

---

### Task 3: Keep Rejected Dual Preview and Commit in Parity

**Files:**
- Modify: `crates/caelum-core/src/preview.rs`
- Modify: `crates/caelum-core/tests/road_authoring.rs`

**Interfaces:**
- Consumes: `road::road_line_footprint`
- Preserves: accepted preview wire format and route-impact calculation
- Produces: complete attempted Dual footprint for rejected previews

- [ ] **Step 1: Add a failing full-footprint parity test**

Add to `road_authoring.rs`:

```rust
#[test]
fn dual_reverse_lane_overlap_preview_and_commit_share_rejection_and_footprint() {
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

- [ ] **Step 2: Run the parity test and verify RED**

```bash
cargo test -p caelum-core --test road_authoring dual_reverse_lane_overlap_preview_and_commit -- --nocapture
```

Expected: FAIL because rejected `LayRoadLine` preview currently contains only supplied forward points.

- [ ] **Step 3: Use the shared complete footprint in rejected previews**

Change `preview.rs::attempted_mutation_tiles`:

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

Do not change accepted preview normalization, route impacts, warnings, or backend types.

- [ ] **Step 4: Run parity and full workspace verification**

```bash
cargo test -p caelum-core --test road_authoring dual_reverse_lane_overlap_preview_and_commit -- --nocapture
cargo test -p caelum-core --test road_authoring one_way_spacing_rejection_matches_preview_and_commit -- --nocapture
cargo test --workspace
```

Expected: PASS.

- [ ] **Step 5: Commit preview parity**

```bash
git add crates/caelum-core/src/preview.rs crates/caelum-core/tests/road_authoring.rs
git commit -m "fix: preview the complete dual-road footprint"
```

---

### Task 4: Characterize Clean Dual-Junction Connectivity and Close Verification

**Files:**
- Modify: `crates/caelum-core/tests/dual_road_routing.rs`
- Modify: PR #54 body with fixture inventory and reproduction mapping
- Do not modify: `crates/caelum-core/src/road.rs` for topology repair
- Do not modify: `crates/caelum-core/src/road_topology.rs` unless this plan is first revised after RED evidence

**Interfaces:**
- Produces test helper: `assert_dual_crossing_contract(snapshot, top_left)`
- Produces test helper: `assert_access_path(engine, from, to, from_heading, to_heading)`
- Consumes canonical sorted `RoadStructure::port_keys()`
- No new public production interface

- [ ] **Step 1: Strengthen the reusable clean-crossing assertion**

Add:

```rust
fn assert_dual_crossing_contract(snapshot: &GameSnapshot, top_left: Point) {
    assert_two_by_two_footprint(snapshot, top_left);
    assert_complete_two_by_two_at(snapshot, top_left);

    let expected_footprint = [
        top_left,
        point(top_left.x + 1, top_left.y),
        point(top_left.x, top_left.y + 1),
        point(top_left.x + 1, top_left.y + 1),
    ];
    let structure = snapshot
        .map
        .road_structures
        .iter()
        .find(|structure| {
            structure.is_automatic_junction()
                && structure.footprint() == expected_footprint
        })
        .expect("expected 2x2 automatic junction");

    assert_eq!(
        structure.port_keys(),
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

`port_keys()` already sorts actual keys; keep the expected vector in the same `Point, Heading` canonical order. No extra sort is required.

- [ ] **Step 2: Add compiled path assertions**

Add:

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

For the canonical crossing at top-left `(6, 2)`, assert:

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

Keep `dual_bidirectional_route_uses_the_legal_left_turn_and_lane` as the representative turn assertion.

- [ ] **Step 3: Map original reproductions to legal replacements in code**

Add this comment above the clean matrix:

```rust
// HPA-551 reproduction mapping:
// - horizontal->vertical upgrade: product behavior is now BlockedTile;
//   horizontal_first_dual_intersection_* is the legal topology equivalent.
// - vertical->horizontal upgrade: product behavior is now BlockedTile;
//   vertical_first_dual_intersection_* is the legal topology equivalent.
// - pre-existing OneWay overlay: product behavior is now BlockedTile;
//   clean horizontal-first plus reversed-input tests retain junction evidence.
```

Update `horizontal_first_dual_intersection_has_all_four_internal_edges` and
`vertical_first_dual_intersection_has_all_four_internal_edges` to call
`assert_dual_crossing_contract` and both straight-path assertions.

Rename them to:

```text
horizontal_first_dual_intersection_satisfies_the_full_crossing_contract
vertical_first_dual_intersection_satisfies_the_full_crossing_contract
```

- [ ] **Step 4: Add reverse-input and adjacent-extension fixtures**

Add:

```rust
#[test]
fn reversed_horizontal_stroke_satisfies_the_full_crossing_contract() {
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
}

#[test]
fn reversed_vertical_stroke_satisfies_the_full_crossing_contract() {
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
}
```

Update the adjacent-empty collinear extension fixture to call `assert_dual_crossing_contract`.

**Decision-gate outcome (recorded after the Step 5 matrix ran):** the existing
endpoint dual T-junction fixture does **not** call `assert_dual_crossing_contract`.
Its first run was RED at layer 3 with six actual ports versus the eight-port
crossing vector. Investigation confirmed the production topology is correct: the
fixture's vertical dual terminates at the junction, there is no road south of the
2 × 2, and boundary ports exist only at junction edges that meet road tiles — a
three-arm endpoint junction therefore has exactly six ports. The minimal
confirmed seam is the test assertion, not production code. The T-junction fixture
instead asserts the same 2 × 2 footprint and reciprocal internal edges plus its
exact six-port canonical set (in `port_keys()` canonical order):

```rust
vec![
    (top_left, Heading::North),
    (top_left, Heading::West),
    (point(top_left.x, top_left.y + 1), Heading::West),
    (point(top_left.x + 1, top_left.y), Heading::North),
    (point(top_left.x + 1, top_left.y), Heading::East),
    (point(top_left.x + 1, top_left.y + 1), Heading::East),
]
```

Rename it to `dual_t_junction_at_vertical_endpoint_satisfies_the_t_junction_contract`.

- [ ] **Step 5: Run the characterization matrix before any topology edit**

```bash
cargo test -p caelum-core --test dual_road_routing horizontal_first_dual_intersection -- --nocapture
cargo test -p caelum-core --test dual_road_routing vertical_first_dual_intersection -- --nocapture
cargo test -p caelum-core --test dual_road_routing reversed_ -- --nocapture
cargo test -p caelum-core --test dual_road_routing adjacent_empty -- --nocapture
cargo test -p caelum-core --test dual_road_routing dual_t_junction -- --nocapture
cargo test -p caelum-core --test dual_road_routing dual_bidirectional_route_uses_the_legal_left_turn -- --nocapture
```

Interpret the first failing layer:

1. footprint;
2. internal reciprocal edge;
3. canonical eight-port set;
4. compiled straight path;
5. existing route-preview turn.

When all commands are GREEN, continue to Step 6 with no production topology diff.

When any command is RED:

1. do not edit `road.rs` or `road_topology.rs`;
2. add the exact failing fixture, assertion, actual value, and first failing layer to PR #54;
3. revise the design and this plan with the minimal confirmed seam;
4. only then implement and verify a production correction in the same HPA-551 PR.

- [ ] **Step 6: Run full repository verification**

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
bun run format:check
bun run check
bun run lint
bun run test:unit
bunx playwright test tests/e2e/smoke.spec.ts -g "demolishes an inclusive rectangle"
```

Every command must exit 0. Do not represent skipped GitHub CI as a passing source verification.

- [ ] **Step 7: Review the one-PR diff against the acceptance contract**

Run:

```bash
git diff --check
git diff --stat main...HEAD
git diff --name-only main...HEAD
```

Confirm:

```text
- one HPA-551 branch and PR
- no backend/host interface change
- no persistence/schema/dependency change
- no new rejection enum
- no scenario authoring regression
- no topology production diff unless Step 5 was RED and the plan was revised first
- every LayRoadLine test hit has a recorded disposition
- contract fixtures retargeted
- scenery fixtures preserve their original assertion
- non-road skip and host-only controls remain
```

- [ ] **Step 8: Commit characterization and verification evidence**

```bash
git add crates/caelum-core/tests/dual_road_routing.rs
git commit -m "test: lock clean dual-road crossing connectivity"
```

Update PR #54 with:

```markdown
## HPA-551 verification

- Fixture inventory: complete; every core-test LayRoadLine hit classified
- Contract fixtures: retargeted
- Scenery fixtures: rebuilt legally
- Original reproduction mapping: recorded
- Clean dual topology: footprint / internal edges / ports / paths GREEN
- Topology production change: none
- cargo test --workspace: PASS
- TypeScript checks/unit tests: PASS
- Blank Grid demolition smoke: PASS
```

Use the actual command results. When Step 5 required a plan revision and a proven production fix, replace “none” with the exact changed seam and its RED/GREEN evidence.

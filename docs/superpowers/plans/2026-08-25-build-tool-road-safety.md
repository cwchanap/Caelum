# Build-Tool Road Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add inclusive rectangular demolition, reject ambiguous/same-axis road overlap atomically, and prove clean dual-road crossings are fully traversable.

**Architecture:** Keep pointer/gesture state unchanged. TypeScript selects deterministic drag geometry and sends the existing intents; `caelum-core` validates the complete road footprint before budget or map mutation and remains the only gameplay authority. Junction production code changes only when a new layered Rust fixture proves the failing edge, port, or compiled-path seam.

**Tech Stack:** Rust (`caelum-core`), TypeScript, Svelte runtime/canvas rendering, Vitest, Playwright, Bun, Cargo

**Spec:** `docs/superpowers/specs/2026-08-25-build-tool-road-safety-design.md`

## Global Constraints

- Deliver all implementation and tests in **one PR for HPA-551**; internal commits are review checkpoints, not separate PRs.
- Keep `GameBackend`, WASM, and Tauri interfaces unchanged.
- Keep the current `DragGesture`; add no new editor state or controller method.
- Road and Track remain axis-locked. Only Demolish changes to rectangular drag geometry.
- Rust owns road-contact validity; do not duplicate overlap classification in TypeScript.
- A multi-tile road stroke may reuse an ordinary road tile only when that tile has the perpendicular axis and not the requested axis.
- Reject the complete road stroke before cost or mutation on same-axis, mixed-axis, structure-owned, roundabout-owned, or axis-less road contact.
- Keep single-tile Road click behavior unchanged.
- Use existing `blockedTile`; add no rejection enum unless an observed implementation failure proves the message unusable.
- Do not add topology repair code without a RED layered crossing fixture.
- Breaking the old upgrade-in-place behavior is intentional; delete or rewrite tests that specify it.
- Add no dependency, save field, schema bump, migration, provenance model, or compatibility wrapper.

## File Structure

- `src/ui/roadDrag.ts` — pure shared line and rectangle point generation.
- `src/runtime/createGameRuntime.ts` — choose drag geometry once for preview and commit.
- `src/render/overlayRenderer.ts` — consume shared rectangle geometry; render authoritative remove previews.
- `crates/caelum-core/src/road.rs` — derive complete road footprint, preflight contacts, and author approved crossings.
- `crates/caelum-core/src/preview.rs` — render the complete attempted Dual footprint on rejection.
- `crates/caelum-core/src/road_topology.rs` — conditional only when the new path assertion is RED after edges and ports are correct.
- `tests/runtime/roadDrag.test.ts` — pure rectangle ordering and direction invariance.
- `tests/runtime/gameRuntime.test.ts` — preview/commit intent geometry and unchanged Road/Track behavior.
- `tests/render/overlayRenderer.test.ts` — area helper extraction and rectangular removal overlay.
- `crates/caelum-core/tests/road_authoring.rs` — atomic road-contact policy and preview parity.
- `crates/caelum-core/tests/dual_road_routing.rs` — layered dual-crossing contract and root-cause gate.
- `tests/e2e/commandShelf.spec.ts` — player-level diagonal Demolish drag.

---

### Task 1: Share Rectangle Geometry and Dispatch Rectangular Demolition

**Files:**
- Modify: `src/ui/roadDrag.ts:1-25`
- Modify: `src/runtime/createGameRuntime.ts:1117-1145, 1409-1465`
- Modify: `src/render/overlayRenderer.ts:20-65, 414-458`
- Test: `tests/runtime/roadDrag.test.ts`
- Test: `tests/runtime/gameRuntime.test.ts`
- Test: `tests/render/overlayRenderer.test.ts`

**Interfaces:**
- Produces: `rectanglePoints(start: Point, end: Point): Point[]`
- Produces locally in `createGameRuntime.ts`: `dragMutationPoints(tool: "road" | "track" | "remove", start: Point, current: Point): Point[]`
- Preserves: `axisLockedLine(start: Point, end: Point): Point[]`
- Consumed by: Task 5 Playwright smoke

- [ ] **Step 1: Add failing pure rectangle tests**

Update the import and add a dedicated suite in `tests/runtime/roadDrag.test.ts`:

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

  it("keeps single-row, single-column, and single-tile rectangles inclusive", () => {
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
    expect(rectanglePoints({ x: 7, y: 8 }, { x: 7, y: 8 })).toEqual([
      { x: 7, y: 8 },
    ]);
  });
});
```

- [ ] **Step 2: Run the pure test and verify RED**

Run:

```bash
bunx vitest run --project runtime tests/runtime/roadDrag.test.ts
```

Expected: FAIL because `rectanglePoints` is not exported.

- [ ] **Step 3: Implement the pure rectangle helper**

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

- [ ] **Step 4: Add failing runtime intent tests**

In `tests/runtime/gameRuntime.test.ts`, replace the line-only Demolish expectation with rectangle coverage and retain explicit Road/Track line checks:

```ts
it("dispatches the same inclusive rectangle for remove preview and commit", async () => {
  const previewMutations: RoadMutation[] = [];
  const backend = backendSpy();
  backend.previewRoadMutation = vi.fn(async (request) => {
    previewMutations.push(request.mutation);
    return {
      generation: request.generation,
      changedTiles:
        request.mutation.type === "removeAtTiles"
          ? request.mutation.points
          : [],
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

it("keeps road and track drags axis-locked", async () => {
  const backend = backendSpy();
  const runtime = await createGameRuntime({ backend });

  runtime.setTool("road");
  runtime.startDrag({ x: 2, y: 3 });
  runtime.setDragCurrent({ x: 5, y: 4 });
  await runtime.commitDrag();
  expect(backend.intents.at(-1)).toMatchObject({
    type: "layRoadLine",
    points: [
      { x: 2, y: 3 },
      { x: 3, y: 3 },
      { x: 4, y: 3 },
      { x: 5, y: 3 },
    ],
  });

  runtime.setTool("track");
  runtime.startDrag({ x: 2, y: 3 });
  runtime.setDragCurrent({ x: 3, y: 6 });
  await runtime.commitDrag();
  expect(backend.intents.at(-1)).toEqual({
    type: "layTrackLine",
    points: [
      { x: 2, y: 3 },
      { x: 2, y: 4 },
      { x: 2, y: 5 },
      { x: 2, y: 6 },
    ],
  });
});
```

Add `RoadMutation` to the existing backend-type import in that test file.

- [ ] **Step 5: Run runtime tests and verify RED**

Run:

```bash
bunx vitest run --project runtime tests/runtime/roadDrag.test.ts tests/runtime/gameRuntime.test.ts
```

Expected: `roadDrag.test.ts` passes after Step 3; the new runtime rectangle expectation FAILS because Remove still uses `axisLockedLine`.

- [ ] **Step 6: Use one geometry selector for preview and commit**

Update the import in `createGameRuntime.ts`:

```ts
import { axisLockedLine, rectanglePoints } from "../ui/roadDrag";
```

Add beside the other small pure runtime helpers:

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

In `roadMutationForUi`, replace:

```ts
const points = axisLockedLine(gesture.start, gesture.current);
```

with:

```ts
const points = dragMutationPoints(
  gesture.tool,
  gesture.start,
  gesture.current,
);
```

In `commitDrag`, derive `points` only after the Area early-return:

```ts
const points = dragMutationPoints(
  gesture.tool,
  gesture.start,
  gesture.current,
);
if (points.length <= 1) {
  // existing single-tile branch, using points[0]
}
```

Rename the remaining local `line` references in that method to `points`. Road and Track still receive `axisLockedLine`; Remove receives `rectanglePoints`.

- [ ] **Step 7: Extract renderer rectangle geometry without changing rendering ownership**

In `overlayRenderer.ts`, import both helpers:

```ts
import { axisLockedLine, rectanglePoints } from "../ui/roadDrag";
```

Delete the private `rectanglePoints` implementation. Keep `planAreaPaintPreview` unchanged except that it now consumes the imported helper. Do not add a local Remove fallback; `renderRoadMutationPreview` remains the source of changed/skipped removal tiles.

- [ ] **Step 8: Add a render regression for rectangular removal preview**

In `tests/render/overlayRenderer.test.ts`, construct a Remove drag and a matching authoritative preview:

```ts
it("renders every tile in a rectangular remove preview", () => {
  const state = createTestGameState();
  const ui = {
    ...createUiState(),
    activeTool: "remove" as const,
    drag: {
      tool: "remove" as const,
      start: { x: 2, y: 3 },
      current: { x: 4, y: 4 },
    },
    roadMutationPreview: {
      generation: 1,
      changedTiles: rectanglePoints({ x: 2, y: 3 }, { x: 4, y: 4 }),
      authoredTiles: [],
      generatedStructures: [],
      cost: 0,
      skippedTiles: [],
      routeImpacts: [],
      warnings: [],
      rejection: null,
    },
  };

  renderOverlays(ctx, state, ui);

  expect(ctx.fillRect).toHaveBeenCalledTimes(6);
});
```

Use the file’s existing `ctx`, state factory, and overlay-render entrypoint rather than creating a second canvas harness. Import `rectanglePoints` from `src/ui/roadDrag`.

- [ ] **Step 9: Run focused TypeScript tests and verify GREEN**

Run:

```bash
bunx vitest run --project runtime tests/runtime/roadDrag.test.ts tests/runtime/gameRuntime.test.ts
bunx vitest run --project ui tests/render/overlayRenderer.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit the rectangular demolition slice**

```bash
git add src/ui/roadDrag.ts src/runtime/createGameRuntime.ts src/render/overlayRenderer.ts tests/runtime/roadDrag.test.ts tests/runtime/gameRuntime.test.ts tests/render/overlayRenderer.test.ts
git commit -m "feat: support rectangular demolition drags"
```

---

### Task 2: Reject Road Overlap Before Authoring

**Files:**
- Modify: `crates/caelum-core/src/road.rs:160-360`
- Modify: `crates/caelum-core/tests/road_authoring.rs`
- Modify: `crates/caelum-core/tests/dual_road_routing.rs` to remove old upgrade-in-place expectations

**Interfaces:**
- Produces: `pub(crate) fn road_line_footprint(points: &[Point], preset: RoadPreset) -> Vec<Point>`
- Produces privately: `validate_road_line_contacts(map: &GameMap, footprint: &[Point], requested_axis: Heading) -> GameplayResult<()>`
- Consumed by: Task 3 rejected-preview footprint
- Preserves: `GameIntent::LayRoadLine`, `RoadPreset`, `BlockedTile`

- [ ] **Step 1: Add a blank-grid helper and failing overlap tests**

In `crates/caelum-core/tests/road_authoring.rs`, add or reuse:

```rust
fn blank_grid_engine() -> GameEngine {
    let mut request = caelum_core::canonical_default_request();
    request.template_id = "blankGrid".to_string();
    GameEngine::from_sandbox_request(request)
        .expect("blank grid fixture request should remain valid")
}

fn lay_line(engine: &mut GameEngine, points: Vec<Point>, preset: RoadPreset) {
    let result = engine.dispatch(GameIntent::LayRoadLine { points, preset });
    assert!(result.applied, "fixture line should apply: {result:?}");
}
```

Add these tests:

```rust
#[test]
fn same_axis_road_overlap_rejects_the_complete_stroke_atomically() {
    let mut engine = blank_grid_engine();
    lay_line(
        &mut engine,
        (3..=8).map(|x| point(x, 5)).collect(),
        RoadPreset::TwoWay,
    );
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
    assert_eq!(
        result.rejection.and_then(|rejection| rejection.context.point),
        Some(point(6, 5)),
    );
    assert_eq!(engine.snapshot().map.tile(point(9, 5)).unwrap().kind, "empty");
}

#[test]
fn dual_reverse_lane_overlap_rejects_before_the_forward_lane_is_built() {
    let mut engine = blank_grid_engine();
    lay_line(
        &mut engine,
        (3..=10).map(|x| point(x, 5)).collect(),
        RoadPreset::TwoWay,
    );
    let before = engine.snapshot();

    let result = engine.dispatch(GameIntent::LayRoadLine {
        // East-canonical Dual at y=6 generates its reverse lane at y=5.
        points: (3..=10).map(|x| point(x, 6)).collect(),
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
fn perpendicular_crossing_remains_legal() {
    let mut engine = blank_grid_engine();
    lay_line(
        &mut engine,
        (3..=10).map(|x| point(x, 5)).collect(),
        RoadPreset::TwoWay,
    );

    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: (2..=8).map(|y| point(6, y)).collect(),
        preset: RoadPreset::TwoWay,
    });

    assert!(result.applied, "perpendicular crossing should apply: {result:?}");
    let crossing = result.snapshot.map.tile(point(6, 5)).unwrap();
    assert!(crossing.road_connections.contains(&Heading::East));
    assert!(crossing.road_connections.contains(&Heading::West));
    assert!(crossing.road_connections.contains(&Heading::North));
    assert!(crossing.road_connections.contains(&Heading::South));
}

#[test]
fn road_extension_starts_on_the_adjacent_empty_tile() {
    let mut engine = blank_grid_engine();
    lay_line(
        &mut engine,
        (3..=6).map(|x| point(x, 5)).collect(),
        RoadPreset::TwoWay,
    );

    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: (7..=10).map(|x| point(x, 5)).collect(),
        preset: RoadPreset::TwoWay,
    });

    assert!(result.applied, "adjacent extension should apply: {result:?}");
    assert!(result
        .snapshot
        .map
        .tile(point(6, 5))
        .unwrap()
        .road_connections
        .contains(&Heading::East));
    assert!(result
        .snapshot
        .map
        .tile(point(7, 5))
        .unwrap()
        .road_connections
        .contains(&Heading::West));
}
```

- [ ] **Step 2: Add failing structure-contact tests**

Add two focused tests using existing fixture helpers where available:

```rust
#[test]
fn road_line_cannot_repaint_an_existing_automatic_junction() {
    let mut engine = blank_grid_engine();
    lay_line(
        &mut engine,
        (3..=10).map(|x| point(x, 5)).collect(),
        RoadPreset::TwoWay,
    );
    lay_line(
        &mut engine,
        (2..=8).map(|y| point(6, y)).collect(),
        RoadPreset::TwoWay,
    );
    let before = engine.snapshot();

    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: (4..=8).map(|x| point(x, 5)).collect(),
        preset: RoadPreset::TwoWay,
    });

    assert!(!result.applied);
    assert_eq!(result.snapshot, before);
    assert_eq!(
        result.rejection.as_ref().map(|rejection| &rejection.code),
        Some(&RejectionCode::BlockedTile),
    );
}

#[test]
fn road_line_cannot_repaint_a_roundabout_footprint() {
    let mut engine = blank_grid_engine();
    let placed = engine.dispatch(GameIntent::PlaceRoundabout {
        origin: point(8, 7),
        size: RoundaboutSize::Compact2x2,
    });
    assert!(placed.applied, "roundabout fixture should apply: {placed:?}");
    let before = engine.snapshot();

    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: (6..=11).map(|x| point(x, 7)).collect(),
        preset: RoadPreset::TwoWay,
    });

    assert!(!result.applied);
    assert_eq!(result.snapshot, before);
    assert_eq!(
        result.rejection.as_ref().map(|rejection| &rejection.code),
        Some(&RejectionCode::BlockedTile),
    );
}
```

If the roundabout placement fixture requires compatible approach roads, reuse the existing roundabout fixture builder from this test module; keep the assertion target on a structure-owned footprint tile.

- [ ] **Step 3: Run the overlap tests and verify RED**

Run:

```bash
cargo test -p caelum-core --test road_authoring road_overlap -- --nocapture
cargo test -p caelum-core --test road_authoring dual_reverse_lane_overlap -- --nocapture
cargo test -p caelum-core --test road_authoring road_line_cannot_repaint -- --nocapture
```

Expected before implementation: same-axis, reverse-lane, and structure-contact tests FAIL because existing roads are currently merged or skipped rather than rejecting the whole stroke. Perpendicular crossing and adjacent extension should remain GREEN.

- [ ] **Step 4: Implement complete-footprint derivation**

In `road.rs`, add near the direction/offset helpers:

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

Keep overflow rejection in `lay_road_line` before this footprint is trusted for mutation.

- [ ] **Step 5: Implement the one authoritative contact validator**

Add these private helpers:

```rust
fn connection_has_axis(connections: &[Heading], horizontal: bool) -> bool {
    connections.iter().any(|heading| {
        matches!(heading, Heading::East | Heading::West) == horizontal
    })
}

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

        let has_requested_axis =
            connection_has_axis(&tile.road_connections, requested_horizontal);
        let has_perpendicular_axis =
            connection_has_axis(&tile.road_connections, !requested_horizontal);
        if has_requested_axis || !has_perpendicular_axis {
            return Err(GameplayRejection::at(RejectionCode::BlockedTile, *point));
        }
    }

    Ok(())
}
```

This accepts only ordinary roads with perpendicular-axis evidence and rejects same-axis, mixed-axis, and axis-less roads.

- [ ] **Step 6: Call preflight before every mutating/cost path**

In `lay_road_line`, after stroke and reverse-offset overflow validation, derive the canonical requested axis and complete footprint:

```rust
let requested_axis = canonical_line_direction(points).ok_or_else(|| {
    GameplayRejection::at(RejectionCode::InvalidRoadStroke, points[0])
})?;
let footprint = road_line_footprint(points, preset);
validate_road_line_contacts(&original.map, &footprint, requested_axis)?;
```

Place this before `validate_one_way_parallel_spacing`, `author_lane_tiles`, and any cost application. Preserve `line_direction(points)` for the actual OneWay arrow direction; the canonical axis is only for axis/contact classification and Dual geometry.

- [ ] **Step 7: Remove the second reverse-lane policy**

Change:

```rust
fn author_lane_tiles(
    candidate: &mut GameSnapshot,
    original: &GameSnapshot,
    points: &[Point],
    direction: Option<Heading>,
    reverse_lane: bool,
) -> GameplayResult<AuthoredLane>
```

to:

```rust
fn author_lane_tiles(
    candidate: &mut GameSnapshot,
    original: &GameSnapshot,
    points: &[Point],
    direction: Option<Heading>,
) -> GameplayResult<AuthoredLane>
```

Update both call sites. Delete `can_overlay_reverse_lane`. For `existing.kind == "road"`, call a renamed crossing-only helper:

```rust
fn author_approved_crossing(tile: &mut Tile) {
    debug_assert!(tile.road_structure_id.is_none());
    tile.one_way = None;
}
```

The preflight has already proved the existing tile is a perpendicular ordinary road. Do not re-run a weaker contact test here.

- [ ] **Step 8: Rewrite upgrade-in-place tests to the new contract**

In `dual_road_routing.rs`:

- delete `recapture_dual_crossing_after_horizontal_then_vertical_upgrade_has_all_four_internal_edges`;
- delete `recapture_dual_crossing_after_vertical_then_horizontal_upgrade_has_all_four_internal_edges`;
- delete `recapture_dual_crossing_after_preexisting_one_way_overlay_has_all_four_internal_edges`;
- rewrite `recapture_dual_crossing_built_across_colinear_continuation_seam_has_all_four_internal_edges` so the second Dual segment begins at the adjacent empty column, not on the previous endpoint:

```rust
lay(
    &mut engine,
    (2..=9).map(|x| point(x, 3)).collect(),
    RoadPreset::DualBidirectional,
);
lay(
    &mut engine,
    (10..=12).map(|x| point(x, 3)).collect(),
    RoadPreset::DualBidirectional,
);
```

Rename it to `dual_crossing_after_adjacent_colinear_extension_has_all_four_internal_edges`.

The deleted accepted-behavior cases are replaced by the atomic rejection tests in `road_authoring.rs`; do not preserve them as compatibility tests.

- [ ] **Step 9: Run focused Rust tests and verify GREEN**

Run:

```bash
cargo test -p caelum-core --test road_authoring road_overlap -- --nocapture
cargo test -p caelum-core --test road_authoring dual_reverse_lane_overlap -- --nocapture
cargo test -p caelum-core --test road_authoring perpendicular_crossing -- --nocapture
cargo test -p caelum-core --test road_authoring road_extension -- --nocapture
cargo test -p caelum-core --test road_authoring road_line_cannot_repaint -- --nocapture
cargo test -p caelum-core --test dual_road_routing dual_crossing_after_adjacent_colinear_extension -- --nocapture
```

Expected: PASS. Verify the rejection snapshots equal the pre-dispatch snapshot and the empty tail/forward lane was not built.

- [ ] **Step 10: Commit the authoritative overlap rule**

```bash
git add crates/caelum-core/src/road.rs crates/caelum-core/tests/road_authoring.rs crates/caelum-core/tests/dual_road_routing.rs
git commit -m "fix: reject road overlap before authoring"
```

---

### Task 3: Keep Rejected Dual-Road Preview and Commit in Parity

**Files:**
- Modify: `crates/caelum-core/src/preview.rs:600-660`
- Test: `crates/caelum-core/tests/road_authoring.rs`

**Interfaces:**
- Consumes: `road::road_line_footprint(points, preset)` from Task 2
- Preserves: `RoadMutationPreviewResponse`
- Produces: complete `changed_tiles` footprint for rejected Dual road previews

- [ ] **Step 1: Add a failing preview/commit parity test**

Add to `road_authoring.rs`:

```rust
#[test]
fn dual_reverse_lane_overlap_preview_and_commit_reject_the_same_full_footprint() {
    let mut engine = blank_grid_engine();
    lay_line(
        &mut engine,
        (3..=6).map(|x| point(x, 5)).collect(),
        RoadPreset::TwoWay,
    );
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
            point(3, 6), point(4, 6), point(5, 6), point(6, 6),
            point(3, 5), point(4, 5), point(5, 5), point(6, 5),
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

Run:

```bash
cargo test -p caelum-core --test road_authoring dual_reverse_lane_overlap_preview_and_commit -- --nocapture
```

Expected: FAIL because `attempted_mutation_tiles` currently returns only the supplied forward points for `LayRoadLine`.

- [ ] **Step 3: Use the shared complete footprint in rejected previews**

Change `preview.rs::attempted_mutation_tiles` from the combined line/remove match to explicit arms:

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

Do not change accepted preview normalization, route-impact calculation, or wire types.

- [ ] **Step 4: Run preview and road-authoring tests and verify GREEN**

Run:

```bash
cargo test -p caelum-core --test road_authoring dual_reverse_lane_overlap_preview_and_commit -- --nocapture
cargo test -p caelum-core --test road_authoring one_way_spacing_rejection_matches_preview_and_commit -- --nocapture
```

Expected: PASS. The existing OneWay preview/commit parity remains unchanged.

- [ ] **Step 5: Commit preview parity**

```bash
git add crates/caelum-core/src/preview.rs crates/caelum-core/tests/road_authoring.rs
git commit -m "fix: preview the complete dual-road footprint"
```

---

### Task 4: Reproduce and Localize Dual-Junction Connectivity

**Files:**
- Modify: `crates/caelum-core/tests/dual_road_routing.rs`
- Conditional modify: `crates/caelum-core/src/road.rs`
- Conditional modify: `crates/caelum-core/src/road_topology.rs`

**Interfaces:**
- Consumes: clean Dual road authoring and adjacent-extension contract from Task 2
- Produces test helper: `assert_dual_crossing_contract(snapshot: &GameSnapshot, top_left: Point)`
- Produces test helper: `assert_crossing_path(engine: &GameEngine, from: Point, to: Point, from_heading: Heading, to_heading: Heading)`
- No new public production interface

- [ ] **Step 1: Strengthen the reusable crossing assertion**

In `dual_road_routing.rs`, add:

```rust
fn assert_dual_crossing_contract(snapshot: &GameSnapshot, top_left: Point) {
    assert_two_by_two_footprint(snapshot, top_left);
    assert_complete_two_by_two_at(snapshot, top_left);

    let structure = snapshot
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

Keep the vector sorted in the same canonical order as existing `port_keys()` assertions. If the current helper order differs, copy the existing clean-fixture order exactly rather than sorting only in the test.

- [ ] **Step 2: Add compiled straight-path assertions**

Add:

```rust
fn assert_crossing_path(
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

For the existing crossing at top-left `(6, 2)`, call it for the two through corridors:

```rust
assert_crossing_path(
    &engine,
    point(5, 3),
    point(8, 3),
    Heading::East,
    Heading::East,
);
assert_crossing_path(
    &engine,
    point(6, 1),
    point(6, 4),
    Heading::South,
    Heading::South,
);
```

Retain the existing route-preview left-turn test; it provides the representative turning-path assertion using real stops and route resolution.

- [ ] **Step 3: Add the small build-order/input-order matrix**

Update the existing horizontal-first and vertical-first tests to call `assert_dual_crossing_contract` and both straight-path assertions. Add two reverse-input fixtures:

```rust
#[test]
fn reversed_horizontal_stroke_keeps_the_dual_crossing_contract() {
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
    assert_crossing_path(&engine, point(5, 3), point(8, 3), Heading::East, Heading::East);
    assert_crossing_path(&engine, point(6, 1), point(6, 4), Heading::South, Heading::South);
}

#[test]
fn reversed_vertical_stroke_keeps_the_dual_crossing_contract() {
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
    assert_crossing_path(&engine, point(5, 3), point(8, 3), Heading::East, Heading::East);
    assert_crossing_path(&engine, point(6, 1), point(6, 4), Heading::South, Heading::South);
}
```

Also update `dual_crossing_after_adjacent_colinear_extension_has_all_four_internal_edges` from Task 2 to call the full contract helper, not only the internal-edge helper.

- [ ] **Step 4: Run the layered fixtures before touching production topology**

Run:

```bash
cargo test -p caelum-core --test dual_road_routing horizontal_first_dual_intersection -- --nocapture
cargo test -p caelum-core --test dual_road_routing vertical_first_dual_intersection -- --nocapture
cargo test -p caelum-core --test dual_road_routing reversed_ -- --nocapture
cargo test -p caelum-core --test dual_road_routing adjacent_colinear_extension -- --nocapture
cargo test -p caelum-core --test dual_road_routing dual_bidirectional_route_uses_the_legal_left_turn -- --nocapture
```

Interpret the first failing layer exactly:

1. footprint assertion;
2. reciprocal internal edge assertion;
3. exact boundary-port assertion;
4. compiled straight path;
5. existing route-preview turn.

If every command is GREEN, skip Steps 5–7 and proceed to Step 8. That is the expected outcome when the reported broken map required an overlay sequence now rejected by Task 2.

- [ ] **Step 5: Internal-edge RED branch — repair only an already-classified 2 × 2 component**

Execute this step only when the footprint is exactly the expected contiguous 2 × 2 automatic-junction candidate and one of the four internal reciprocal edges is missing.

Add a private helper in `road.rs`:

```rust
fn complete_two_by_two_internal_edges(map: &mut GameMap, footprint: &[Point]) -> bool {
    if footprint.len() != 4 {
        return false;
    }
    let min_x = footprint.iter().map(|point| point.x).min().unwrap();
    let max_x = footprint.iter().map(|point| point.x).max().unwrap();
    let min_y = footprint.iter().map(|point| point.y).min().unwrap();
    let max_y = footprint.iter().map(|point| point.y).max().unwrap();
    if max_x - min_x != 1 || max_y - min_y != 1 {
        return false;
    }

    let top_left = Point { x: min_x, y: min_y };
    for (point, heading) in [
        (top_left, Heading::East),
        (top_left, Heading::South),
        (Point { x: min_x + 1, y: min_y }, Heading::South),
        (Point { x: min_x, y: min_y + 1 }, Heading::East),
    ] {
        connect(map, point, heading);
    }
    true
}
```

Call it only inside `refresh_automatic_junctions` after the component has both horizontal and vertical live boundary-port axes. Restart the refresh iteration after completion so ports are derived from the repaired reciprocal graph. Do not call it for closed loops, single-axis artifacts, or arbitrary 2 × 2 road blocks.

Re-run all Step 4 commands. Continue only when all are GREEN.

- [ ] **Step 6: Boundary-port RED branch — repair the missing reciprocal attachment, not the port list cosmetically**

Execute this step only when all four internal reciprocal edges are present but an expected boundary port is absent.

For the missing expected `(point, edge)`:

1. assert in the test that the footprint tile contains `edge`;
2. assert that `offset(point, edge)` is an ordinary road;
3. assert that the outside road contains `opposite(edge)`.

The first failed assertion identifies the authoring connection that must be restored in `connect_authored_sequence` or `connect_neighbor_endpoints`. Fix that reciprocal edge creation and keep `refresh_automatic_junctions` port derivation unchanged; it already derives ports from live reciprocal edges.

Add the exact reciprocal assertion to the failing fixture so the regression cannot be hidden by later structure compilation. Re-run all Step 4 commands.

- [ ] **Step 7: Compiled-path RED branch — fix only live port transition filtering**

Execute this step only when footprint, internal edges, all eight boundary ports, and outside reciprocal connections are correct but `find_path_between_access_tiles` or the existing route-preview turn fails.

In `road_topology.rs::compile_automatic_junction_transitions`, preserve the current entry/exit port iteration and change only the failed live-map predicate shown by the fixture. Add a focused transition assertion using the existing hidden `transition_for` seam:

```rust
let topology = engine.road_topology_for_test();
assert!(topology
    .transition_for(
        RoadState {
            position: point(6, 3),
            incoming_heading: Heading::East,
        },
        Heading::South,
    )
    .is_some());
```

Use the actual missing entry/outgoing pair reported by the failing path; do not broaden transition generation to every port pair that violates `lane_accepts`.

Re-run all Step 4 commands.

- [ ] **Step 8: Run the full dual-road test target**

Run:

```bash
cargo test -p caelum-core --test dual_road_routing -- --nocapture
```

Expected: PASS.

- [ ] **Step 9: Commit the characterization gate and any proven root fix**

When production topology was unchanged:

```bash
git add crates/caelum-core/tests/dual_road_routing.rs
git commit -m "test: lock dual-road crossing connectivity"
```

When one RED branch required production code:

```bash
git add crates/caelum-core/src/road.rs crates/caelum-core/src/road_topology.rs crates/caelum-core/tests/dual_road_routing.rs
git commit -m "fix: repair dual-road crossing connectivity"
```

Stage only the production file actually changed; do not create an empty or speculative topology diff.

---

### Task 5: Add Player-Level Demolition Coverage and Verify the One-PR Slice

**Files:**
- Modify: `tests/e2e/commandShelf.spec.ts`
- Verify all files changed in Tasks 1–4

**Interfaces:**
- Consumes: `dragMapTiles`, `runtimeSnapshot`, `selectBuildLeaf`, and the existing command-shelf Demolish control
- Produces: player-visible rectangular demolition smoke

- [ ] **Step 1: Add a failing Playwright smoke**

Append to `tests/e2e/commandShelf.spec.ts`:

```ts
test("demolishes an inclusive rectangle while preserving tiles outside it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createDefaultCity(page);
  const canvas = page.locator("canvas[data-runtime-canvas='true']");

  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 4, y: 6 }, { x: 8, y: 6 });
  await dragMapTiles(page, canvas, { x: 4, y: 8 }, { x: 8, y: 8 });

  await page.getByTestId("command-tool-demolish").click();
  await dragMapTiles(page, canvas, { x: 4, y: 6 }, { x: 7, y: 8 });

  await expect
    .poll(async () => {
      const tiles = (await runtimeSnapshot(page)).state.map.tiles;
      const kind = (x: number, y: number) =>
        tiles.find((tile) => tile.x === x && tile.y === y)?.kind;
      return {
        removedTop: [4, 5, 6, 7].map((x) => kind(x, 6)),
        removedBottom: [4, 5, 6, 7].map((x) => kind(x, 8)),
        outsideTop: kind(8, 6),
        outsideBottom: kind(8, 8),
      };
    })
    .toEqual({
      removedTop: ["empty", "empty", "empty", "empty"],
      removedBottom: ["empty", "empty", "empty", "empty"],
      outsideTop: "road",
      outsideBottom: "road",
    });
});
```

This proves the diagonal drag spans multiple rows and does not collapse to the dominant axis.

- [ ] **Step 2: Run the focused E2E test**

Run:

```bash
bunx playwright test tests/e2e/commandShelf.spec.ts -g "demolishes an inclusive rectangle"
```

Expected after Task 1: PASS. If it fails, inspect the pointer gesture and final runtime snapshot; do not add timing sleeps. Reuse the existing polling helper pattern.

- [ ] **Step 3: Run focused TypeScript and Rust suites**

```bash
bunx vitest run --project runtime tests/runtime/roadDrag.test.ts tests/runtime/gameRuntime.test.ts
bunx vitest run --project ui tests/render/overlayRenderer.test.ts
cargo test -p caelum-core --test road_authoring -- --nocapture
cargo test -p caelum-core --test dual_road_routing -- --nocapture
```

Expected: PASS.

- [ ] **Step 4: Run repository verification**

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
bun run format:check
bun run check
bun run lint
bun run test:unit
bun run test:e2e
bun run build
```

Expected: every command exits 0. `bun` pre-hooks rebuild WASM when Rust sources are newer, so do not manually copy generated artifacts into Git.

- [ ] **Step 5: Review the final diff against HPA-551**

Confirm the diff has:

- one shared `rectanglePoints` helper;
- one runtime geometry selector used by preview and commit;
- no new backend/controller/save interface;
- one Rust complete-footprint preflight before cost/mutation;
- no upgrade-in-place compatibility path;
- complete rejected Dual preview footprint;
- layered crossing tests;
- topology production changes only when a test was RED;
- one Playwright player smoke.

Remove unrelated formatting or refactoring before committing.

- [ ] **Step 6: Commit the player smoke and final verification state**

```bash
git add tests/e2e/commandShelf.spec.ts
git commit -m "test: cover rectangular demolition end to end"
```

- [ ] **Step 7: Update the existing HPA-551 PR rather than opening another PR**

Push every Task 1–5 commit to the branch already linked to HPA-551. Update the same PR body with:

```markdown
## Implementation

- rectangular Demolish preview and commit geometry
- atomic complete-footprint road overlap preflight
- full Dual rejected-preview footprint
- layered dual-junction edge/port/path coverage

## Verification

- `cargo fmt --all --check`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cargo test --workspace`
- `bun run format:check`
- `bun run check`
- `bun run lint`
- `bun run test:unit`
- `bun run test:e2e`
- `bun run build`
```

Do not open a second implementation PR for HPA-551.

# Playtest Road Authoring and Route-Build UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the five post-Phase-5 playtest blockers—structure-direction feedback, parallel one-way authoring, the suspected incomplete 2×2 dual-road crossing, map-blocking route drafting, and the Demolish shortcut—in one implementation PR.

**Architecture:** Keep road semantics in `caelum-core::road`. First make "no traversable lateral link between parallel one-way lanes" a topology invariant enforced both when connecting endpoints and when canonicalizing existing edges (inherited links are stripped where arrow-aligned continuation identifies them; graph-indistinguishable residue stays as a dormant, untraversable stub); then layer the requested 3-tile **standalone OneWay build policy** on top as a separate Rust preflight shared by preview and commit. Route drafting keeps its current runtime state and relaxes only Lines ↔ collapsed visibility. The dual-junction production repair remains conditional on a RED missing-edge reproduction.

**Tech Stack:** Rust / `caelum-core`, TypeScript, Svelte, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-22-playtest-road-route-ux-design.md`

## Global Constraints

- Deliver everything in **one implementation PR**; internal commits may be separate.
- Structure-owned road cells are silent no-ops for direction cycling; ordinary authored road tiles remain editable.
- Parallel one-way lanes must never gain a traversable perpendicular lateral link. Newly authored links are prevented; inherited links are stripped by canonicalization where arrow-aligned continuation identifies them, and structurally indistinguishable residue (downstream lane ends) stays serialized but untraversable via `lane_accepts`.
- `RoadPreset::OneWay` has a **3-tile standalone build policy** where longitudinal spans overlap: distances 1 and 2 reject, distance 3 allows.
- The 3-tile policy is not a global map invariant. `CycleRoadDirection` and `DualBidirectional` remain outside that placement preflight.
- `DualBidirectional` keeps its generated adjacent paired carriageway.
- A later standalone OneWay beside an existing same-axis Dual carriageway at distance 1/2 rejects because the standalone OneWay preflight sees that lane.
- Close parallel segments with no longitudinal overlap remain legal.
- Perpendicular one-way intersections remain legal.
- While a route draft exists, only Lines ↔ collapsed (`null`) destination changes are allowed; Build/Data/City and Select/Demolish remain gated.
- Escape still cancels an active route draft.
- Demolish uses bare **D** only; **X** is removed with no alias.
- Do not add a rule engine, new intersection type, topology representation, HUD redesign, collapse state, shortcut-preference system, schema bump, migration, persistence change, or dependency.
- **No 2×2 junction repair helper may be added until a build-order fixture is RED specifically on a missing internal edge inside an already-classified contiguous 2×2 automatic junction.**

## Review decisions locked into this plan

- The same-direction endpoint condition in `connect_neighbor_endpoints` is real, but do not assume the old "pruning destroys the through road" mechanism: current endpoint-join cleanup can preserve the lateral bridge. Test the unwanted final graph directly.
- A connection-time guard alone is insufficient because a TwoWay endpoint bridge can later become parallel one-way through direction edits. Canonicalization strips inherited links where arrow-aligned continuation distinguishes them from protected ring transients; a downstream-end parallel-lane pair is the same arrow/edge-labeled graph as that transient, so its residue stays as a dormant stub rather than paying for serialized stroke provenance.
- The 3-tile distance remains the requested product policy even though only adjacency is a direct connection hazard.
- Do not call the 3-tile validator from `CycleRoadDirection`; that would couple a build policy into intermediate direction-cycle states. Topology safety is handled independently.
- Structure-owned direction clicks stay silent rather than showing replacement copy.
- The route E2E must prove actual panel occlusion; simple stops already selectable with Lines open are invalid fixtures.

---

## File Map

### Rust road authority

- Modify `crates/caelum-core/src/road.rs`
  - structure-owned direction no-op;
  - shared lateral-parallel-one-way predicate;
  - prevent new lateral endpoint links and strip inherited ones during canonicalization, leaving only graph-indistinguishable dormant stubs;
  - standalone OneWay 3-tile placement preflight;
  - only if Task 4 proves RED: bounded 2×2 automatic-junction completion.
- Modify `crates/caelum-core/src/rejection.rs`
  - remove `InvalidDirectionChange`;
  - add `OneWayParallelTooClose`.
- Modify `crates/caelum-core/tests/road_authoring.rs`
  - rewrite structure-direction rejection contract;
  - add new-link and inherited-link parallel-one-way topology regressions;
  - add standalone spacing matrix and preview/commit parity.
- Modify `crates/caelum-core/tests/engine_topology.rs`
  - rewrite direction/cache contract to silent no-op + cache unchanged.
- Modify `crates/caelum-core/tests/dual_road_routing.rs`
  - permanent horizontal-first and vertical-first four-edge assertions;
  - retain footprint/ports/legal-turn behavior.
- Modify `crates/caelum-core/tests/model_wire_format.rs`
  - update exhaustive rejection wire values.

### Thin frontend/runtime

- Modify `src/domain/types.ts`
  - remove `invalidDirectionChange`, add `oneWayParallelTooClose`.
- Modify `src/runtime/rejectionMessages.ts`
  - remove obsolete direction message;
  - add spacing copy.
- Modify `src/runtime/createGameRuntime.ts`
  - allow only Lines/null destination toggles while a draft is active.
- Modify `src/components/hud/CommandShelf.svelte`
  - Lines is the only operable destination during a draft.
- Modify `src/App.svelte`
  - Lines is closable while drafting;
  - D replaces X for Demolish.
- Modify `tests/runtime/rejectionMessages.test.ts`
- Modify `tests/runtime/gameRuntime.test.ts`
- Modify `tests/ui/commandShelf.test.ts`
- Modify `tests/ui/appShell.test.ts`
- Modify `tests/e2e/helpers.ts`
  - update stale pinned-Lines comment;
  - export tile-center viewport helper.
- Modify `tests/e2e/routes.spec.ts`
  - geometry-backed occlusion proof.

No new production module or public runtime controller method is planned.

---

### Task 1: Make structure direction clicks quiet and delete the dead rejection

**Files:**
- Modify: `crates/caelum-core/src/road.rs`
- Modify: `crates/caelum-core/src/rejection.rs`
- Modify: `crates/caelum-core/tests/road_authoring.rs`
- Modify: `crates/caelum-core/tests/engine_topology.rs`
- Modify: `crates/caelum-core/tests/model_wire_format.rs`
- Modify: `src/domain/types.ts`
- Modify: `src/runtime/rejectionMessages.ts`
- Modify: `tests/runtime/rejectionMessages.test.ts`

**Interfaces:**
- Consumes: `RoadMutation::CycleRoadDirection`, `GameEngine::commit_snapshot_and_topology`, current rejection wire.
- Produces: `cycle_road_direction(...) -> GameplayResult<bool>`; no current `InvalidDirectionChange` value.

- [ ] **Step 1: Rewrite the existing road-authoring test RED**

Replace `cycling_a_structure_tile_is_rejected_atomically`:

```rust
#[test]
fn cycling_a_structure_tile_is_a_silent_no_op() {
    let (mut engine, _) = crossing_engine();
    let before = engine.snapshot();

    let result = engine.dispatch(GameIntent::CycleRoadDirection {
        point: point(14, 8),
    });

    assert!(!result.applied);
    assert!(result.rejection.is_none());
    assert_eq!(result.snapshot, before);
}
```

Retain ordinary-road cycle coverage.

- [ ] **Step 2: Rewrite the topology-cache test RED**

Replace `rejected_direction_change_mutates_neither_snapshot_nor_cache`:

```rust
#[test]
fn structure_direction_no_op_mutates_neither_snapshot_nor_cache() {
    let mut engine = crossing_engine();
    let before_snapshot = engine.snapshot();
    let before_topology = engine.road_topology_for_test().clone();

    let result = engine.dispatch(GameIntent::CycleRoadDirection {
        point: point(14, 8),
    });

    assert!(!result.applied);
    assert!(result.rejection.is_none());
    assert_eq!(engine.snapshot(), before_snapshot);
    assert_eq!(engine.road_topology_for_test(), &before_topology);
}
```

- [ ] **Step 3: Run both tests RED**

```bash
cargo test -p caelum-core --test road_authoring cycling_a_structure_tile_is_a_silent_no_op -- --exact
cargo test -p caelum-core --test engine_topology structure_direction_no_op_mutates_neither_snapshot_nor_cache -- --exact
```

Expected: FAIL because structure cells still return `InvalidDirectionChange`.

- [ ] **Step 4: Implement quiet no-op through the existing reducer**

```rust
RoadMutation::CycleRoadDirection { point } => {
    if cycle_road_direction(candidate, *point)? {
        changed_tiles.push(*point);
    }
    0
}
```

```rust
fn cycle_road_direction(
    candidate: &mut GameSnapshot,
    point: Point,
) -> GameplayResult<bool> {
    let Some(tile) = candidate.map.tile(point) else {
        return Err(GameplayRejection::at(RejectionCode::OutOfBounds, point));
    };
    if tile.kind != "road" {
        return Err(GameplayRejection::at(RejectionCode::RoadRequired, point));
    }
    if tile.road_structure_id.is_some() {
        return Ok(false);
    }

    let next = match tile.one_way {
        None => Some(Heading::North),
        Some(Heading::North) => Some(Heading::East),
        Some(Heading::East) => Some(Heading::South),
        Some(Heading::South) => Some(Heading::West),
        Some(Heading::West) => None,
    };
    let Some(tile) = candidate.map.tile_mut(point) else {
        return Err(GameplayRejection::at(RejectionCode::OutOfBounds, point));
    };
    tile.one_way = next;
    Ok(true)
}
```

Do **not** add the 3-tile placement validator here. Task 2 will make direction-edit outcomes topologically safe without changing cycle semantics.

- [ ] **Step 5: Delete `InvalidDirectionChange` from current contracts**

Remove the Rust enum value, TypeScript union member, message mapping, and current wire/message-test expectations. Do not replace it with another structure-direction toast.

- [ ] **Step 6: Run GREEN gates**

```bash
cargo test -p caelum-core --test road_authoring
cargo test -p caelum-core --test engine_topology
cargo test -p caelum-core --test model_wire_format
bun run test:unit -- tests/runtime/rejectionMessages.test.ts
```

- [ ] **Step 7: Commit Task 1**

```bash
git add -- \
  crates/caelum-core/src/road.rs \
  crates/caelum-core/src/rejection.rs \
  crates/caelum-core/tests/road_authoring.rs \
  crates/caelum-core/tests/engine_topology.rs \
  crates/caelum-core/tests/model_wire_format.rs \
  src/domain/types.ts \
  src/runtime/rejectionMessages.ts \
  tests/runtime/rejectionMessages.test.ts
git commit -m "fix: make structure direction clicks quiet"
```

---

### Task 2: Make parallel-one-way lateral-link removal a topology invariant

> **Revised during review:** the invariant is stated as "never retain a *traversable* lateral link." Canonicalization strips inherited links only when arrow-aligned lane continuation distinguishes them from protected 2×2-loop transients; downstream-end residue is graph-indistinguishable from those transients, so it stays serialized as a dormant stub (untraversable via `lane_accepts`). Removing retention-time stripping outright was tested and rejected: without it, a retained upstream bridge steers direction-cycle rebuilds into pruning the lane's own through edge. `direction_edit_endpoints_strip_upstream_and_keep_downstream_lateral_links` pins both outcomes.

**Files:**

**Files:**
- Modify: `crates/caelum-core/src/road.rs`
- Modify: `crates/caelum-core/tests/road_authoring.rs`

**Interfaces:**
- Consumes: `connect_neighbor_endpoints`, `canonicalize_authored_roads`, `same_axis`.
- Produces: private `is_lateral_parallel_one_way_link`; no public type/rejection.

- [ ] **Step 1: Add a RED regression for a newly-created same-direction lateral link**

Use a public path that remains legal after the Task 3 build policy:

```rust
#[test]
fn adjacent_same_direction_one_way_lanes_do_not_connect_laterally() {
    let mut engine = GameEngine::new();

    let standalone = engine.dispatch(GameIntent::LayRoadLine {
        points: (3..=10).rev().map(|x| point(x, 5)).collect(),
        preset: RoadPreset::OneWay,
    });
    assert!(standalone.applied, "fixture OneWay should apply: {standalone:?}");

    // East-canonical Dual at y=7 generates a westbound reverse lane at y=6,
    // adjacent to the westbound standalone lane at y=5.
    let dual = engine.dispatch(GameIntent::LayRoadLine {
        points: (3..=10).map(|x| point(x, 7)).collect(),
        preset: RoadPreset::DualBidirectional,
    });
    assert!(dual.applied, "fixture Dual should apply: {dual:?}");

    let map = &engine.snapshot().map;
    for x in [3, 10] {
        let outer = map.tile(point(x, 5)).expect("standalone endpoint");
        let inner = map.tile(point(x, 6)).expect("dual reverse endpoint");
        assert_eq!(outer.one_way, Some(Heading::West));
        assert_eq!(inner.one_way, Some(Heading::West));
        assert!(!outer.road_connections.contains(&Heading::South));
        assert!(!inner.road_connections.contains(&Heading::North));
        assert!(outer
            .road_connections
            .iter()
            .any(|edge| matches!(edge, Heading::East | Heading::West)));
        assert!(inner
            .road_connections
            .iter()
            .any(|edge| matches!(edge, Heading::East | Heading::West)));
    }
}
```

Current cleanup may preserve the unwanted two-tile endpoint join instead of pruning it; test the desired final graph rather than an assumed cleanup failure.

- [ ] **Step 2: Add a RED regression for a TwoWay endpoint link inherited through direction edits**

```rust
#[test]
fn direction_edit_removes_inherited_parallel_one_way_lateral_link() {
    let mut engine = GameEngine::new();
    for y in [5, 6] {
        let result = engine.dispatch(GameIntent::LayRoadLine {
            points: (3..=10).map(|x| point(x, y)).collect(),
            preset: RoadPreset::TwoWay,
        });
        assert!(result.applied, "fixture TwoWay should apply: {result:?}");
    }

    let before = engine.snapshot();
    assert!(before
        .map
        .tile(point(3, 5))
        .expect("upper endpoint")
        .road_connections
        .contains(&Heading::South));

    // None -> North -> East on each endpoint.
    for point in [point(3, 5), point(3, 6)] {
        assert!(engine.dispatch(GameIntent::CycleRoadDirection { point }).applied);
        assert!(engine.dispatch(GameIntent::CycleRoadDirection { point }).applied);
    }

    let map = &engine.snapshot().map;
    let upper = map.tile(point(3, 5)).expect("upper endpoint");
    let lower = map.tile(point(3, 6)).expect("lower endpoint");
    assert_eq!(upper.one_way, Some(Heading::East));
    assert_eq!(lower.one_way, Some(Heading::East));
    assert!(!upper.road_connections.contains(&Heading::South));
    assert!(!lower.road_connections.contains(&Heading::North));
    assert!(upper.road_connections.contains(&Heading::East));
    assert!(lower.road_connections.contains(&Heading::East));
}
```

If the existing endpoint bridge is at `x=10` rather than `x=3`, use that endpoint consistently and keep the setup assertion.

- [ ] **Step 3: Run both topology tests RED**

```bash
cargo test -p caelum-core --test road_authoring adjacent_same_direction_one_way_lanes_do_not_connect_laterally -- --exact
cargo test -p caelum-core --test road_authoring direction_edit_removes_inherited_parallel_one_way_lateral_link -- --exact
```

- [ ] **Step 4: Add one shared private predicate**

```rust
fn is_lateral_parallel_one_way_link(
    current: Option<Heading>,
    neighbor: Option<Heading>,
    heading: Heading,
) -> bool {
    match (current, neighbor) {
        (Some(current), Some(neighbor)) => {
            same_axis(current, neighbor) && !same_axis(heading, current)
        }
        _ => false,
    }
}
```

- [ ] **Step 5: Prevent new links in `connect_neighbor_endpoints`**

Replace the opposite-direction-only condition with:

```rust
if is_lateral_parallel_one_way_link(current_one_way, neighbor.one_way, heading) {
    continue;
}
```

Update the comment to describe all parallel one-way lanes.

- [ ] **Step 6: Normalize inherited links in `canonicalize_authored_roads`**

Carry `one_way` in the existing temporary snapshot:

```rust
let connections: Vec<_> = map
    .tiles
    .iter()
    .map(|tile| {
        (
            Point { x: tile.x, y: tile.y },
            tile.one_way,
            tile.road_connections.clone(),
        )
    })
    .collect();
```

Filter reciprocal edges before writing them back:

```rust
for (point, current_one_way, headings) in connections {
    let valid: Vec<_> = headings
        .into_iter()
        .filter(|heading| {
            if !reciprocal_connection(map, point, *heading) {
                return false;
            }
            let neighbor_one_way = map
                .tile(offset(point, *heading))
                .and_then(|neighbor| neighbor.one_way);
            !is_lateral_parallel_one_way_link(
                current_one_way,
                neighbor_one_way,
                *heading,
            )
        })
        .collect();
    if let Some(tile) = map.tile_mut(point) {
        tile.road_connections = valid;
    }
}
```

This uses the existing canonicalization pass rather than adding another whole-map framework.

- [ ] **Step 7: Run topology GREEN gates**

```bash
cargo test -p caelum-core --test road_authoring
cargo test -p caelum-core --test dual_road_routing
cargo test -p caelum-core --test road_topology
cargo test -p caelum-core --test roundabouts
```

- [ ] **Step 8: Commit Task 2**

```bash
git add -- crates/caelum-core/src/road.rs crates/caelum-core/tests/road_authoring.rs
git commit -m "fix: normalize parallel one-way lateral links"
```

---

### Task 3: Add the 3-tile standalone OneWay build policy

**Files:**
- Modify: `crates/caelum-core/src/road.rs`
- Modify: `crates/caelum-core/src/rejection.rs`
- Modify: `crates/caelum-core/tests/road_authoring.rs`
- Modify: `crates/caelum-core/tests/model_wire_format.rs`
- Modify: `src/domain/types.ts`
- Modify: `src/runtime/rejectionMessages.ts`
- Modify: `tests/runtime/rejectionMessages.test.ts`

**Interfaces:**
- Consumes: `RoadPreset::OneWay`, `line_direction`, `same_axis`, pre-mutation `GameMap`, shared `apply_road_mutation` path.
- Produces: `RejectionCode::OneWayParallelTooClose`, `MIN_PARALLEL_ONE_WAY_SPACING_TILES`, private validator.

- [ ] **Step 1: Add complete spacing matrix RED**

```rust
fn one_way_engine(points: Vec<Point>) -> GameEngine {
    let mut engine = GameEngine::new();
    let result = engine.dispatch(GameIntent::LayRoadLine {
        points,
        preset: RoadPreset::OneWay,
    });
    assert!(result.applied, "fixture OneWay should apply: {result:?}");
    engine
}
```

```rust
#[test]
fn standalone_one_way_spacing_is_three_tiles_and_longitudinally_local() {
    for y in [6, 7] {
        let mut engine = one_way_engine((3..=10).map(|x| point(x, 5)).collect());
        let before = engine.snapshot();
        let result = engine.dispatch(GameIntent::LayRoadLine {
            points: (3..=10).map(|x| point(x, y)).collect(),
            preset: RoadPreset::OneWay,
        });
        assert!(!result.applied);
        assert_eq!(
            result.rejection.as_ref().map(|rejection| &rejection.code),
            Some(&RejectionCode::OneWayParallelTooClose),
        );
        assert_eq!(result.snapshot, before);
    }

    let mut distance_three = one_way_engine((3..=10).map(|x| point(x, 5)).collect());
    assert!(distance_three.dispatch(GameIntent::LayRoadLine {
        points: (3..=10).map(|x| point(x, 8)).collect(),
        preset: RoadPreset::OneWay,
    }).applied);

    let mut non_overlapping = one_way_engine((3..=6).map(|x| point(x, 5)).collect());
    assert!(non_overlapping.dispatch(GameIntent::LayRoadLine {
        points: (8..=12).map(|x| point(x, 6)).collect(),
        preset: RoadPreset::OneWay,
    }).applied);

    let mut crossing = one_way_engine((3..=10).map(|x| point(x, 5)).collect());
    assert!(crossing.dispatch(GameIntent::LayRoadLine {
        points: (2..=8).map(|y| point(6, y)).collect(),
        preset: RoadPreset::OneWay,
    }).applied);
}
```

Distance 2 remains rejected because the requested policy is 3 tiles; Task 2 owns graph safety.

- [ ] **Step 2: Lock Dual and merge-path behavior RED**

Add:

```rust
#[test]
fn standalone_one_way_checks_existing_dual_lane_but_dual_self_authoring_remains_legal() {
    let mut engine = GameEngine::new();
    let dual = engine.dispatch(GameIntent::LayRoadLine {
        points: (3..=10).map(|x| point(x, 10)).collect(),
        preset: RoadPreset::DualBidirectional,
    });
    assert!(dual.applied, "Dual must self-author its paired lane: {dual:?}");

    let before = engine.snapshot();
    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: (3..=10).map(|x| point(x, 12)).collect(),
        preset: RoadPreset::OneWay,
    });
    assert!(!result.applied);
    assert_eq!(
        result.rejection.as_ref().map(|rejection| &rejection.code),
        Some(&RejectionCode::OneWayParallelTooClose),
    );
    assert_eq!(result.snapshot, before);
}
```

Add `one_way_overlay_is_checked_before_merge_lane_direction`: base OneWay at `y=5`, TwoWay at `y=7`, then attempt OneWay overlay at `y=7`; expect atomic `OneWayParallelTooClose` before merge.

- [ ] **Step 3: Add preview/commit parity RED**

Use the same close overlapping OneWay mutation for preview and dispatch; expect `OneWayParallelTooClose` from both.

- [ ] **Step 4: Run spacing tests RED**

```bash
cargo test -p caelum-core --test road_authoring standalone_one_way_spacing_is_three_tiles_and_longitudinally_local -- --exact
cargo test -p caelum-core --test road_authoring standalone_one_way_checks_existing_dual_lane_but_dual_self_authoring_remains_legal -- --exact
cargo test -p caelum-core --test road_authoring one_way_overlay_is_checked_before_merge_lane_direction -- --exact
```

- [ ] **Step 5: Implement preflight before authoring/cost**

```rust
const MIN_PARALLEL_ONE_WAY_SPACING_TILES: i32 = 3;

fn perpendicular_point(point: Point, direction: Heading, delta: i32) -> Option<Point> {
    match direction {
        Heading::East | Heading::West => Some(Point {
            x: point.x,
            y: point.y.checked_add(delta)?,
        }),
        Heading::North | Heading::South => Some(Point {
            x: point.x.checked_add(delta)?,
            y: point.y,
        }),
    }
}

fn validate_one_way_parallel_spacing(
    map: &GameMap,
    points: &[Point],
    direction: Heading,
) -> GameplayResult<()> {
    for point in points {
        for distance in 1..MIN_PARALLEL_ONE_WAY_SPACING_TILES {
            for delta in [-distance, distance] {
                let Some(nearby_point) = perpendicular_point(*point, direction, delta) else {
                    continue;
                };
                let Some(nearby) = map.tile(nearby_point) else {
                    continue;
                };
                if nearby.kind == "road"
                    && nearby
                        .one_way
                        .is_some_and(|existing| same_axis(existing, direction))
                {
                    return Err(GameplayRejection::at(
                        RejectionCode::OneWayParallelTooClose,
                        *point,
                    ));
                }
            }
        }
    }
    Ok(())
}
```

No unnecessary `as i32` casts; clippy runs with `-D warnings`.

In `lay_road_line`, before `author_lane_tiles`:

```rust
let forward = line_direction(points);
let dual_direction = canonical_line_direction(points);
if preset == RoadPreset::OneWay {
    if let Some(direction) = forward {
        validate_one_way_parallel_spacing(&original.map, points, direction)?;
    }
}
```

Do not call this from `CycleRoadDirection`.

- [ ] **Step 6: Add rejection wire/copy**

Add `OneWayParallelTooClose`, `"oneWayParallelTooClose"`, and:

```ts
case "oneWayParallelTooClose":
  return "Keep parallel one-way roads at least 3 tiles apart.";
```

Update Rust wire and TypeScript message tests.

- [ ] **Step 7: Run Task 3 GREEN gates**

```bash
cargo test -p caelum-core --test road_authoring
cargo test -p caelum-core --test model_wire_format
bun run test:unit -- tests/runtime/rejectionMessages.test.ts
```

- [ ] **Step 8: Commit Task 3**

```bash
git add -- \
  crates/caelum-core/src/road.rs \
  crates/caelum-core/src/rejection.rs \
  crates/caelum-core/tests/road_authoring.rs \
  crates/caelum-core/tests/model_wire_format.rs \
  src/domain/types.ts \
  src/runtime/rejectionMessages.ts \
  tests/runtime/rejectionMessages.test.ts
git commit -m "fix: enforce standalone one-way spacing"
```

---

### Task 4: Reproduce the dual 2×2 missing-edge bug before repairing it

**Files:**
- Modify: `crates/caelum-core/tests/dual_road_routing.rs`
- Conditionally modify: `crates/caelum-core/src/road.rs` only after RED.

**Interfaces:**
- Produces always: permanent horizontal-first/vertical-first four-edge assertions.
- Produces only after RED: private `connect_complete_two_by_two_junction`.

- [ ] **Step 1: Add reciprocal-edge helpers**

Add `assert_reciprocal_edge` and `assert_complete_two_by_two` for:

```text
(6,2) East
(6,2) South
(7,2) South
(6,3) East
```

Keep existing exact four-cell footprint and eight-port assertions.

- [ ] **Step 2: Add vertical-first fixture and both tests**

Build the same Dual crossing with vertical first, horizontal second. Add one test per order calling `assert_complete_two_by_two`.

- [ ] **Step 3: Run hard diagnostic gate**

```bash
cargo test -p caelum-core --test dual_road_routing horizontal_first_dual_intersection_has_all_four_internal_edges -- --exact
cargo test -p caelum-core --test dual_road_routing vertical_first_dual_intersection_has_all_four_internal_edges -- --exact
```

Outcome A: RED missing edge inside expected four-cell automatic junction -> Step 4.

Outcome B: both GREEN -> commit tests, no helper, recapture actual playtest topology before claiming blocker fixed.

Outcome C: different invariant fails -> retain useful characterization and rescope; no forced helper.

- [ ] **Step 4: Only for outcome A, add bounded helper**

`road.rs` already imports `BTreeSet` and `HashSet`; preserve/add them explicitly if refactoring changes imports.

```rust
fn connect_complete_two_by_two_junction(map: &mut GameMap, footprint: &[Point]) {
    if footprint.len() != 4 {
        return;
    }
    let xs: BTreeSet<i32> = footprint.iter().map(|point| point.x).collect();
    let ys: BTreeSet<i32> = footprint.iter().map(|point| point.y).collect();
    if xs.len() != 2 || ys.len() != 2 {
        return;
    }
    let xs: Vec<_> = xs.into_iter().collect();
    let ys: Vec<_> = ys.into_iter().collect();
    if xs[1].checked_sub(xs[0]) != Some(1) || ys[1].checked_sub(ys[0]) != Some(1) {
        return;
    }

    let footprint: HashSet<Point> = footprint.iter().copied().collect();
    for point in footprint.iter().copied() {
        for heading in [Heading::East, Heading::South] {
            if footprint.contains(&offset(point, heading)) {
                connect(map, point, heading);
            }
        }
    }
}
```

Run only for already-classified automatic junctions before ownership assignment. Do not alter ports, Task 2's parallel-one-way invariant, or roundabouts.

- [ ] **Step 5: Run Task 4 suite**

Outcome A:

```bash
cargo test -p caelum-core --test dual_road_routing
cargo test -p caelum-core --test road_authoring
cargo test -p caelum-core --test road_topology
cargo test -p caelum-core --test roundabouts
```

Outcome B/C: run `cargo test -p caelum-core --test dual_road_routing` after retaining characterization.

- [ ] **Step 6: Commit permanent evidence**

Always commit build-order tests. Commit `road.rs` helper only in Outcome A. If B/C, recapture/amend the bounded diagnosis in the same implementation PR or stop/rescope before merge.

---

### Task 5: Let Lines collapse during a route draft while every other command stays gated

**Files:**
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `src/components/hud/CommandShelf.svelte`
- Modify: `src/App.svelte`
- Modify: `tests/runtime/gameRuntime.test.ts`
- Modify: `tests/ui/commandShelf.test.ts`
- Modify: `tests/ui/appShell.test.ts`
- Modify: `tests/e2e/helpers.ts`

- [ ] **Step 1: Rewrite runtime draft gate RED**

Update the existing route-draft gate test. Lock Lines -> null, blocked Build while collapsed, Lines -> open, draft identity preserved, and existing overlay/tool/build-leaf/second-edit gates unchanged. Add collapsed `handleEscape()` -> draft cancelled.

- [ ] **Step 2: Rewrite CommandShelf pinned-Lines test RED**

Lines has no `aria-disabled="true"`; Build/Data/City and Select/Demolish remain disabled/inert. Clicking active Lines emits `onSetDestination(null)`.

- [ ] **Step 3: Run runtime/shelf RED**

```bash
bun run test:unit -- tests/runtime/gameRuntime.test.ts tests/ui/commandShelf.test.ts
```

- [ ] **Step 4: Relax only `setCommandDestination`**

```ts
setCommandDestination(destination: CommandDestination | null) {
  if (dead) return getSnapshot();
  if (
    ui.routeDraft !== null &&
    destination !== null &&
    destination !== "lines"
  ) {
    return getSnapshot();
  }
  const nextDestination =
    destination === ui.activeCommandDestination ? null : destination;
  // retain existing cleanup/commit logic
```

- [ ] **Step 5: Make Lines sole shelf exception**

Allow Lines in `activate`; apply draft-time `aria-disabled` only to non-Lines destinations. Keep `activateTool` blocked.

- [ ] **Step 6: Make Lines panel closable**

Use `canClose={true}` for Lines. Rewrite current app-shell "pins Lines" characterization; do not leave stale behavior.

- [ ] **Step 7: Update E2E helper comment**

Replace the stale disabled-but-expanded Lines explanation with:

```ts
// Active route drafts keep Lines enabled so it can collapse/reopen. Other
// command destinations remain aria-disabled; fail fast when one of those is
// closed instead of clicking a known no-op and waiting for aria-expanded.
```

- [ ] **Step 8: Run Task 5 GREEN**

```bash
bun run test:unit -- \
  tests/runtime/gameRuntime.test.ts \
  tests/ui/commandShelf.test.ts \
  tests/ui/appShell.test.ts
```

- [ ] **Step 9: Commit Task 5**

```bash
git add -- \
  src/runtime/createGameRuntime.ts \
  src/components/hud/CommandShelf.svelte \
  src/App.svelte \
  tests/runtime/gameRuntime.test.ts \
  tests/ui/commandShelf.test.ts \
  tests/ui/appShell.test.ts \
  tests/e2e/helpers.ts
git commit -m "fix: keep route drafting map accessible"
```

---

### Task 6: Replace X with D for Demolish

**Files:**
- Modify: `src/App.svelte`
- Modify: `tests/ui/appShell.test.ts`

- [ ] **Step 1: Rewrite existing keyboard test RED**

Rename B/R/T/X/V -> B/R/T/D/V. Assert X does not call remove, D does. Use existing `Rename Harbour City` textbox after clearing `runtime.setTool` mock to prove D in input does nothing.

- [ ] **Step 2: Run RED**

```bash
bun run test:unit -- tests/ui/appShell.test.ts
```

- [ ] **Step 3: Replace binding**

```ts
if (key === "d") {
  setSnapshot(runtime.setTool("remove"));
  return;
}
```

Delete X branch, no alias.

- [ ] **Step 4: Run GREEN**

```bash
bun run test:unit -- tests/ui/appShell.test.ts
```

- [ ] **Step 5: Commit Task 6**

```bash
git add -- src/App.svelte tests/ui/appShell.test.ts
git commit -m "fix: bind demolish to d"
```

---

### Task 7: Prove actual panel occlusion and finish the single PR

**Files:**
- Modify: `tests/e2e/helpers.ts`
- Modify: `tests/e2e/routes.spec.ts`

- [ ] **Step 1: Export tile viewport center helper**

```ts
export async function mapTileViewportPoint(
  canvas: Locator,
  tile: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error("Game canvas does not have a visible bounding box");
  }
  const { scale, offsetX, offsetY } = boardTransform(box);
  return {
    x: box.x + offsetX + (tile.x + 0.5) * tileSize * scale,
    y: box.y + offsetY + (tile.y + 0.5) * tileSize * scale,
  };
}
```

- [ ] **Step 2: Add geometry-backed route E2E**

Use stops `[3,7,11,15,19] × y=3` beside a TwoWay road `x=2..20, y=4`. Open Lines/New Bus. Compute each stop center and the panel bounding box. Require one covered and one exposed candidate.

Assert the covered center is actually panel-owned:

```ts
expect(
  await page.evaluate(({ x, y }) => {
    const top = document.elementFromPoint(x, y);
    return top?.closest('[data-testid="command-panel"]') !== null;
  }, covered.point),
).toBe(true);
```

Select exposed stop while open -> waypoint 0. Close Lines. Select covered stop -> reopen Lines -> waypoint 1. Do not use the already-exposed simple-route pair as occlusion proof.

- [ ] **Step 3: Run focused E2E**

```bash
bunx playwright test tests/e2e/routes.spec.ts
```

- [ ] **Step 4: Run complete Rust verification**

```bash
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

- [ ] **Step 5: Run complete frontend/browser verification**

```bash
bun run format:check
bun run check
bun run lint
bun run test:unit
bun run test:e2e
bun run build
```

- [ ] **Step 6: Run leftover/scope scans**

```bash
git grep -n -E 'InvalidDirectionChange|invalidDirectionChange' -- \
  crates/caelum-core/src crates/caelum-core/tests src tests || true
git grep -n 'key === "x"' -- src/App.svelte tests || true
git status --short
git diff --stat origin/main...HEAD
```

- [ ] **Step 7: Commit E2E proof**

```bash
git add -- tests/e2e/helpers.ts tests/e2e/routes.spec.ts
git commit -m "test: prove route drafting exposes covered map stops"
```

- [ ] **Step 8: Open exactly one implementation PR**

Suggested title:

```text
fix: address road authoring and route-build playtest blockers
```

PR body must report all five fixes, the separate topology-vs-spacing decision, the dual RED-gate outcome, the real occlusion proof, and full verification results.

---

## Risks / Execution Boundaries

- **Do not conflate spacing with topology safety.** Task 2 must pass even for configurations Task 3 does not prevent.
- **Do not globalize the 3-tile policy.** Direction-cycle intermediate states make that a separate UX design problem.
- **Do not ship a green-only 2×2 mesh.** Build-order tests are permanent; production helper requires RED.
- **Do not accept an already-exposed-stop E2E.** Geometry must prove the panel owns the selected tile center.
- **Do not replace the removed direction tip with new copy.** Silence is intentional for structure-owned cells.

## Self-Review Checklist

- [ ] Existing road-authoring and engine-topology direction rejection tests are rewritten.
- [ ] `InvalidDirectionChange` is deleted from current contracts.
- [ ] Structure silence is explicitly intentional.
- [ ] Task 2 tests both prevention of a new same-direction lateral link and the strip-upstream / dormant-downstream outcome of an inherited TwoWay->OneWay link.
- [ ] Shared lateral-link predicate is used by connection and canonicalization, with canonicalization requiring arrow-aligned continuation, not copied with drifting conditions.
- [ ] Existing opposite-direction Dual anti-U-turn behavior remains covered.
- [ ] 3 tiles remains the requested policy: distance 1/2 reject, 3 allow.
- [ ] Spec does not claim distance 2 is mechanically unsafe.
- [ ] Spacing is described as standalone-OneWay-tool scoped, not a global invariant.
- [ ] Non-overlap, perpendicular, Dual self-authoring, OneWay-beside-Dual, merge-path, and preview/commit cases are locked.
- [ ] No spacing validator is added to direction cycling.
- [ ] Horizontal-first/vertical-first dual tests are committed regardless of RED/GREEN.
- [ ] No 2×2 helper without RED missing edge.
- [ ] CommandShelf pinned-Lines test is rewritten.
- [ ] E2E helper comment no longer describes Lines as disabled/pinned.
- [ ] E2E proves actual panel ownership at the covered stop center.
- [ ] App keyboard contract changes X -> D and locks X off.
- [ ] D in City rename input is ignored.
- [ ] No unnecessary `as i32` cast in spacing loop.
- [ ] `BTreeSet`/`HashSet` imports are explicit if conditional helper is implemented.
- [ ] No new controller API, persistence state, schema, dependency, rule engine, intersection type, topology representation, or HUD redesign.
- [ ] One implementation branch -> one PR.

## Execution Handoff

Execute all tasks on one implementation branch. The dual 2×2 blocker is not considered fixed merely because characterization is green; if both build orders start green, recapture the real playtest topology before merge.
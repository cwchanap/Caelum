# Roadside Stop Core and Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move normal bus stops from road tiles to roadside passenger anchors, persist a single authoritative road access, migrate legacy snapshots safely, and route bus legs through the exact access tile with typed failures.

**Architecture:** `caelum-core` remains authoritative. A new `stop_access` module derives, validates, migrates, and normalizes `StopRoadAccess`; `RoadTopology` gains a tile-constrained typed finder; `network` maps typed failures into route legs. `GameEngine::from_snapshot` is the legacy-load entry point, while `commit_network_mutation` re-normalizes access after mid-session map edits.

**Tech Stack:** Rust 2021, Serde, `caelum-core`, WASM Bindgen, Tauri 2, Cargo integration tests.

## Global Constraints

- Keep `SNAPSHOT_SCHEMA_VERSION = 2`; deserialize missing `roadAccess`/`failureReason` with defaults.
- Rust owns stop placement, migration, access validity, routing, route diagnostics, vehicle coordinates, and gameplay rejection codes.
- `Stop.position` is the passenger coordinate; `StopRoadAccess.road_point` is the bus/vehicle coordinate.
- Pin bus routing to `road_point`, never to one lifelong heading; `preferred_heading` only ranks ties and renders the indicator.
- Opposing lanes never connect mid-block; legal direction changes use compiled junction, terminal reversal, or roundabout transitions.
- Preview and commit must both call `network::resolve_route_legs` and produce structurally identical paths.
- Preserve immutable snapshot semantics and reference-equality dispatch.
- Run Rust fmt/clippy/tests after each task; do not change metro track routing.

---

## File Map

- Create `crates/caelum-core/src/stop_access.rs`: stop access derivation, validation, migration, and normalization.
- Modify `crates/caelum-core/src/model.rs`: `StopRoadAccess`, `LegFailureReason`, optional wire fields.
- Modify `crates/caelum-core/src/lib.rs`: export new public wire types; register `stop_access` internally.
- Modify `crates/caelum-core/src/rejection.rs`: `NoRoadAccess` placement rejection.
- Modify `crates/caelum-core/src/transit.rs`: roadside `add_bus_stop`, passenger/vehicle coordinate lookups.
- Modify `crates/caelum-core/src/buildings.rs`: terminal access derivation and restore.
- Modify `crates/caelum-core/src/transit_nodes.rs`: restore hooks install freshly derived stop access.
- Modify `crates/caelum-core/src/engine.rs`: `from_snapshot`, map-change normalization, route recomputation order.
- Modify `crates/caelum-core/src/road.rs`: expose reciprocal-connection helper within the crate.
- Modify `crates/caelum-core/src/road_topology.rs`: typed constrained finder and typed reversal; remove dead finder.
- Modify `crates/caelum-core/src/network.rs`: access-aware typed route resolution.
- Modify `crates/caelum-core/src/route_lifecycle.rs`: bus vehicle world/parking uses `road_point`.
- Modify `crates/caelum-core/src/router.rs`, `platforms.rs`, `trips.rs`: passenger-coordinate and migration rebasing.
- Modify `crates/caelum-wasm/src/lib.rs`, `src-tauri/src/lib.rs`: expose snapshot-load entry point without adding save/load UI.
- Create `crates/caelum-core/tests/stop_migration.rs`, `dual_road_routing.rs`.
- Extend `crates/caelum-core/tests/model_wire_format.rs`, `transit_build.rs`, `road_topology.rs`, `route_editing.rs`, `route_resilience.rs`.

---

### Task 1: Wire Model and Failure Types

**Files:**
- Modify: `crates/caelum-core/src/model.rs`
- Modify: `crates/caelum-core/src/rejection.rs`
- Modify: `crates/caelum-core/src/lib.rs`
- Test: `crates/caelum-core/tests/model_wire_format.rs`

**Interfaces:**
- Produces: `StopRoadAccess { road_point: Point, preferred_heading: Option<Heading> }`.
- Produces: `LegFailureReason::{NoRoadAccess, NetworkDisconnected, NoLegalEntryHeading, NoLegalExitHeading, NoLegalTurnaround}`.
- Produces: `Stop.road_access: Option<StopRoadAccess>` and `RouteLegPath.failure_reason: Option<LegFailureReason>`.
- Produces: `RejectionCode::NoRoadAccess` for placement failures.

- [ ] **Step 1: Write failing wire-format tests**

Add tests that deserialize legacy JSON without the fields and round-trip populated values:

```rust
#[test]
fn stop_road_access_is_optional_for_v2_snapshots() {
    let stop: Stop = serde_json::from_value(json!({
        "id": "stop-001",
        "kind": "busStop",
        "status": "present",
        "position": { "x": 4, "y": 5 },
        "platforms": []
    })).unwrap();
    assert_eq!(stop.road_access, None);
}

#[test]
fn route_leg_failure_reason_round_trips() {
    let leg = RouteLegPath {
        from_waypoint_id: "stop-001".into(),
        to_waypoint_id: "stop-002".into(),
        direction: ServiceDirection::Outbound,
        kind: RouteLegKind::Service,
        status: RouteLegStatus::NetworkDisconnected,
        current_path: None,
        last_valid_path: None,
        estimated_seconds: None,
        failure_reason: Some(LegFailureReason::NoRoadAccess),
    };
    assert_eq!(serde_json::from_value::<RouteLegPath>(serde_json::to_value(&leg).unwrap()).unwrap(), leg);
}
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `cargo test -p caelum-core --test model_wire_format stop_road_access -- --nocapture`

Expected: compile failure because `StopRoadAccess`, `road_access`, and `failure_reason` do not exist.

- [ ] **Step 3: Add the wire types and defaults**

Add to `model.rs`:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopRoadAccess {
    pub road_point: Point,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_heading: Option<Heading>,
}

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

Add optional fields:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub failure_reason: Option<LegFailureReason>,

#[serde(default, skip_serializing_if = "Option::is_none")]
pub road_access: Option<StopRoadAccess>,
```

Add `NoRoadAccess` to `RejectionCode` and re-export `LegFailureReason`/`StopRoadAccess` from `lib.rs` beside the existing model exports.

- [ ] **Step 4: Fix every existing Rust struct literal explicitly**

Add `road_access: None` to existing `Stop` fixtures/constructors and `failure_reason: None` to existing `RouteLegPath` literals. Do not add compatibility constructors.

- [ ] **Step 5: Run format and wire tests**

Run: `cargo fmt --all && cargo test -p caelum-core --test model_wire_format`

Expected: all model wire-format tests pass; legacy v2 JSON yields `None`.

- [ ] **Step 6: Commit**

```bash
git add crates/caelum-core/src/model.rs crates/caelum-core/src/rejection.rs crates/caelum-core/src/lib.rs crates/caelum-core/tests/model_wire_format.rs
git commit -m "feat(core): add bus stop access and route failure wire types"
```

---

### Task 2: Access Derivation and Roadside Placement

**Files:**
- Create: `crates/caelum-core/src/stop_access.rs`
- Modify: `crates/caelum-core/src/lib.rs`
- Modify: `crates/caelum-core/src/road.rs`
- Modify: `crates/caelum-core/src/road_topology.rs`
- Modify: `crates/caelum-core/src/transit.rs`
- Modify: `crates/caelum-core/src/buildings.rs`
- Modify: `crates/caelum-core/src/transit_nodes.rs`
- Test: `crates/caelum-core/tests/transit_build.rs`

**Interfaces:**
- Consumes: `StopRoadAccess`, `RejectionCode::NoRoadAccess` from Task 1.
- Produces:

```rust
pub(crate) fn derive_stop_access(map: &GameMap, anchor: Point) -> Option<StopRoadAccess>;
pub(crate) fn derive_stop_access_for_footprint(map: &GameMap, footprint: &[Point]) -> Option<StopRoadAccess>;
pub(crate) fn stop_footprint(snapshot: &GameSnapshot, stop: &Stop) -> Vec<Point>;
pub(crate) fn is_valid_access(map: &GameMap, footprint: &[Point], access: StopRoadAccess) -> bool;
```

- [ ] **Step 1: Write failing placement tests**

Cover normal stops, terminals, restore, and unusable roads:

```rust
#[test]
fn add_bus_stop_uses_empty_anchor_and_adjacent_road_access() {
    let mut engine = fixture_engine_with_two_way_road(&[point(4, 5), point(5, 5)]);
    let result = engine.dispatch(GameIntent::AddBusStop { point: point(4, 4) });
    assert!(result.applied, "{result:?}");
    let stop = &result.snapshot.transit.stops[0];
    assert_eq!(stop.position, point(4, 4));
    assert_eq!(stop.road_access.unwrap().road_point, point(4, 5));
    assert_eq!(result.snapshot.map.tile(stop.position).unwrap().kind, "empty");
}

#[test]
fn add_bus_stop_rejects_an_on_road_click() {
    let mut engine = fixture_engine_with_two_way_road(&[point(4, 5), point(5, 5)]);
    let result = engine.dispatch(GameIntent::AddBusStop { point: point(4, 5) });
    assert_eq!(result.rejection.unwrap().code, RejectionCode::BlockedTile);
}

#[test]
fn add_bus_stop_rejects_an_isolated_adjacent_road() {
    let mut engine = fixture_engine_with_isolated_road(point(4, 5));
    let result = engine.dispatch(GameIntent::AddBusStop { point: point(4, 4) });
    assert_eq!(result.rejection.unwrap().code, RejectionCode::NoRoadAccess);
}
```

Also add a terminal whose road touches only a far-edge footprint tile and a restore test that rebuilds the terminal at the same origin with a different rotation.

- [ ] **Step 2: Run focused placement tests and verify failure**

Run: `cargo test -p caelum-core --test transit_build add_bus_stop -- --nocapture`

Expected: current on-road placement behavior fails the new assertions.

- [ ] **Step 3: Implement deterministic usable-road helpers**

In `stop_access.rs`, scan candidates in deterministic order and require a reciprocal transition:

```rust
fn usable_road(map: &GameMap, point: Point) -> bool {
    map.tile(point).is_some_and(|tile| {
        tile.kind == "road"
            && tile.road_structure_id.is_none()
            && canonical_headings().into_iter().any(|heading| {
                lane_accepts(tile.one_way, heading)
                    && reciprocal_connection(map, point, heading)
            })
    })
}

pub(crate) fn derive_stop_access_for_footprint(
    map: &GameMap,
    footprint: &[Point],
) -> Option<StopRoadAccess> {
    let road_point = footprint.iter().flat_map(|point| {
        canonical_headings().into_iter().map(|heading| offset(*point, heading))
    }).find(|point| usable_road(map, *point))?;
    let tile = map.tile(road_point)?;
    let preferred_heading = canonical_headings().into_iter().find(|heading| {
        lane_accepts(tile.one_way, *heading) && tile.road_connections.contains(heading)
    }).or_else(|| canonical_headings().into_iter().find(|heading| lane_accepts(tile.one_way, *heading)));
    Some(StopRoadAccess { road_point, preferred_heading })
}
```

Expose `lane_accepts`, `is_road`, and `reciprocal_connection` as `pub(crate)`; do not duplicate their logic.

- [ ] **Step 4: Rewrite `add_bus_stop` for roadside anchors**

Validate that the clicked tile is empty/unoccupied/no transit node and call `derive_stop_access`. Store the anchor and access:

```rust
let access = derive_stop_access(&state.map, *point)
    .ok_or_else(|| GameplayRejection::at(RejectionCode::NoRoadAccess, *point))?;

allocated.transit.stops.push(Stop {
    id: stop_id.clone(),
    kind: BusStopKind::BusStop,
    status: TransitNodeStatus::Present,
    position: *point,
    road_access: Some(access),
    platforms: bus_platforms(&stop_id, BusStopKind::BusStop),
});
```

Return `BlockedTile` for non-empty/occupied anchors and `NoRoadAccess` for an empty anchor without usable access. Keep `BUS_STOP_COST` unchanged.

- [ ] **Step 5: Install access on terminal create and restore**

Derive from `occupied_tiles` before calling `restore_or_create_node`; after allocation or restoration, use `matching_present_node_id` to set the found stop's `road_access = Some(access)`. Keep `restore_or_create_node` generic for metro rather than embedding bus-only behavior.

- [ ] **Step 6: Run focused tests, fmt, and clippy**

Run:

```bash
cargo fmt --all
cargo test -p caelum-core --test transit_build
cargo clippy -p caelum-core --all-targets -- -D warnings
```

Expected: roadside placement, terminal footprint, and restore tests pass.

- [ ] **Step 7: Commit**

```bash
git add crates/caelum-core/src/stop_access.rs crates/caelum-core/src/lib.rs crates/caelum-core/src/road.rs crates/caelum-core/src/road_topology.rs crates/caelum-core/src/transit.rs crates/caelum-core/src/buildings.rs crates/caelum-core/src/transit_nodes.rs crates/caelum-core/tests/transit_build.rs
git commit -m "feat(core): place bus stops on roadside anchors"
```

---

### Task 3: Legacy Snapshot Migration and Dependent-State Rebase

**Files:**
- Modify: `crates/caelum-core/src/stop_access.rs`
- Modify: `crates/caelum-core/src/engine.rs`
- Modify: `crates/caelum-core/src/route_lifecycle.rs`
- Modify: `crates/caelum-core/src/router.rs`
- Modify: `crates/caelum-core/src/platforms.rs`
- Modify: `crates/caelum-core/src/transit.rs`
- Modify: `crates/caelum-core/src/trips.rs`
- Modify: `crates/caelum-wasm/src/lib.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `crates/caelum-core/tests/stop_migration.rs`
- Test: `crates/caelum-core/tests/route_resilience.rs`

**Interfaces:**
- Consumes: Task 2 access helpers.
- Produces:

```rust
pub(crate) fn normalize_snapshot_stops(snapshot: GameSnapshot) -> GameplayResult<GameSnapshot>;
pub fn GameEngine::from_snapshot(snapshot: GameSnapshot) -> GameplayResult<Self>;
```

- [ ] **Step 1: Write failing migration tests**

Build a legacy snapshot with an on-road stop, waiting trip, route plan, and parked bus. Assert:

```rust
let engine = GameEngine::from_snapshot(legacy).unwrap();
let snapshot = engine.snapshot();
let stop = &snapshot.transit.stops[0];
assert_eq!(stop.position, point(4, 4));
assert_eq!(stop.road_access.unwrap().road_point, point(4, 5));
assert_eq!(waiting_trip(&snapshot).position, TripPosition::from((4, 4)));
assert_eq!(parked_bus(&snapshot).parked_position, Some(TripPosition::from((4, 5))));
assert_eq!(waiting_trip(&snapshot).route_plan.as_ref().unwrap().legs[0].to, point(4, 4));
```

Add a no-free-neighbor case asserting `position == road_access.road_point` and `is_valid_access == true`.

- [ ] **Step 2: Run the migration test and verify failure**

Run: `cargo test -p caelum-core --test stop_migration -- --nocapture`

Expected: compile failure because `GameEngine::from_snapshot` and normalization do not exist.

- [ ] **Step 3: Implement deterministic normalization**

Process present stops in stable stop-id order. For a legacy on-road `BusStop`, reserve the first free N/E/S/W empty anchor; otherwise retain the on-road fallback. Record moves as `{ stop_id, old_position, new_position, road_point }` and revalidate/rederive access for already-roadside stops. `is_valid_access` must accept either adjacency or the single-tile `position == road_point` fallback.

- [ ] **Step 4: Rebase dependent passenger and vehicle state**

For each move:

```rust
if trip.status == TripStatus::Waiting && trip.position == old_position.into() {
    trip.position = new_position.into();
}
for leg in trip.route_plan.iter_mut().flat_map(|plan| &mut plan.legs) {
    if leg.mode == TransitMode::Bus && leg.from == old_position { leg.from = new_position; }
    if leg.mode == TransitMode::Bus && leg.to == old_position { leg.to = new_position; }
}
```

Update adjacent walk-leg endpoints that connect to a moved bus leg, but never rewrite `ActiveTrip.origin`, `ActiveTrip.destination`, `Sim.home`, or `Sim.workplace` solely by coordinate equality. Change bus `present_node_world`/parking targets to use `road_access.road_point`; keep platform waiter indexes on passenger `Stop.position`.

- [ ] **Step 5: Add the explicit engine load entry point**

```rust
pub fn from_snapshot(snapshot: GameSnapshot) -> GameplayResult<Self> {
    let snapshot = stop_access::normalize_snapshot_stops(snapshot)?;
    let road_topology = RoadTopology::compile(&snapshot.map)?;
    Ok(Self { snapshot, road_topology })
}
```

Expose a WASM/Tauri wrapper that accepts a serialized `GameSnapshot` and replaces/constructs managed engine state through `from_snapshot`. Do not add save/load UI in this plan.

- [ ] **Step 6: Normalize map-changing candidates before route recomputation**

In `commit_network_mutation`, compute `map_changed`; if true, run `normalize_snapshot_stops(network_candidate.snapshot)` before `RoadTopology::compile` and `route_lifecycle::recompute_all_routes`. Preserve rejection atomicity: a normalization/topology error returns a rejected result and leaves `self.snapshot`/`self.road_topology` untouched.

- [ ] **Step 7: Run migration and resilience tests**

Run:

```bash
cargo fmt --all
cargo test -p caelum-core --test stop_migration
cargo test -p caelum-core --test route_resilience
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: migration/dependent-state tests pass; existing route resilience remains green.

- [ ] **Step 8: Commit**

```bash
git add crates/caelum-core/src/stop_access.rs crates/caelum-core/src/engine.rs crates/caelum-core/src/route_lifecycle.rs crates/caelum-core/src/router.rs crates/caelum-core/src/platforms.rs crates/caelum-core/src/transit.rs crates/caelum-core/src/trips.rs crates/caelum-wasm/src/lib.rs src-tauri/src/lib.rs crates/caelum-core/tests/stop_migration.rs crates/caelum-core/tests/route_resilience.rs
git commit -m "feat(core): migrate legacy stops to roadside access"
```

---

### Task 4: Tile-Constrained Typed Road Finder

**Files:**
- Modify: `crates/caelum-core/src/road_topology.rs`
- Test: `crates/caelum-core/tests/road_topology.rs`
- Test: `crates/caelum-core/tests/network_paths.rs`

**Interfaces:**
- Consumes: `LegFailureReason` from Task 1.
- Produces:

```rust
pub fn find_path_between_access_tiles(
    &self,
    map: &GameMap,
    from_tile: Point,
    to_tile: Point,
    from_preferred: Option<Heading>,
    to_preferred: Option<Heading>,
) -> Result<TransitPath, LegFailureReason>;

pub fn find_terminal_reversal(
    &self,
    terminal: Point,
    previous_exit_heading: Heading,
    next_required_entry_heading: Heading,
) -> Result<TransitPath, LegFailureReason>;
```

- [ ] **Step 1: Write failing finder tests**

Add tests for:

```rust
assert_eq!(topology.find_path_between_access_tiles(&map, a, b, None, None), Err(LegFailureReason::NetworkDisconnected));
assert_eq!(topology.find_path_between_access_tiles(&map, isolated, b, None, None), Err(LegFailureReason::NoLegalEntryHeading));
assert_eq!(topology.find_path_between_access_tiles(&map, a, a, None, None).unwrap().step_count(), 0);
```

Add a paired-lane fixture proving the finder never starts/goals on the adjacent parallel tile and a reversal fixture for each typed error.

- [ ] **Step 2: Run tests and verify failure**

Run: `cargo test -p caelum-core --test road_topology -- --nocapture`

Expected: compile failure because the typed finder does not exist.

- [ ] **Step 3: Implement tile-constrained Dijkstra**

Seed only `road_start_states(self, from_tile)`, rank `from_preferred` first without excluding other states, accept only `state.position == to_tile`, and preserve `movement_count > 0` unless `from_tile == to_tile`.

Return:

```rust
if starts.is_empty() { return Err(LegFailureReason::NoLegalEntryHeading); }
// exhausted heap
Err(LegFailureReason::NetworkDisconnected)
```

- [ ] **Step 4: Convert terminal reversal to typed errors**

Classify missing outgoing exit transitions as `NoLegalExitHeading`, missing reachable entry states as `NoLegalEntryHeading`, and exhausted finite reversal search as `NoLegalTurnaround`. Remove `find_reversal_between` after callers move in Task 5.

- [ ] **Step 5: Migrate legacy topology tests**

Move production-behavior tests from `find_path` to `find_path_between_access_tiles`. If a few endpoint-expansion tests intentionally exercise old behavior, retain `find_path` as `#[doc(hidden)]`; do not use `#[cfg(test)]`, because Cargo integration tests compile the library dependency without its test cfg.

- [ ] **Step 6: Run topology tests and clippy**

Run:

```bash
cargo fmt --all
cargo test -p caelum-core --test road_topology
cargo test -p caelum-core --test network_paths
cargo clippy -p caelum-core --all-targets -- -D warnings
```

- [ ] **Step 7: Commit**

```bash
git add crates/caelum-core/src/road_topology.rs crates/caelum-core/tests/road_topology.rs crates/caelum-core/tests/network_paths.rs
git commit -m "feat(core): add typed access-tile road routing"
```

---

### Task 5: Access-Aware Network Resolution and Route Diagnostics

**Files:**
- Modify: `crates/caelum-core/src/network.rs`
- Modify: `crates/caelum-core/src/route_lifecycle.rs`
- Modify: `crates/caelum-core/src/route_editor.rs`
- Test: `crates/caelum-core/tests/route_editing.rs`
- Test: `crates/caelum-core/tests/route_preview.rs`

**Interfaces:**
- Consumes: Task 4 typed finder/reversal.
- Produces: `resolve_route_legs` with `RouteLegPath.failure_reason` populated.

- [ ] **Step 1: Write failing typed-resolution tests**

Create fixtures for `NoRoadAccess`, `NoLegalEntryHeading`, `NetworkDisconnected`, `NoLegalExitHeading`, and `NoLegalTurnaround`. Assert coarse status remains `NetworkDisconnected` for all typed failures and `MissingNode` keeps `failure_reason == None`.

- [ ] **Step 2: Run route tests and verify failure**

Run: `cargo test -p caelum-core --test route_editing failure_reason -- --nocapture`

Expected: failure because all `None` paths currently collapse to `NetworkDisconnected` without a reason.

- [ ] **Step 3: Replace `Option` routing with a typed result**

Use:

```rust
type TransitPathResult = Result<TransitPath, LegFailureReason>;

fn resolve_service_path(...) -> TransitPathResult;
fn resolve_terminal_reversal(...) -> TransitPathResult;
```

Handle absent/tombstoned waypoints before routing; map absent access to `NoRoadAccess`; call `find_path_between_access_tiles(&snapshot.map, from.road_point, to.road_point, from.preferred_heading, to.preferred_heading)`; assign `failure_reason` from `Err(reason)`.

- [ ] **Step 4: Implement zero-step terminal heading fallback**

When a bounding service path has no steps, choose the terminal access's `preferred_heading`; if absent, choose the first N/E/S/W state with a usable transition. Return `NoLegalExitHeading`/`NoLegalEntryHeading` if no deterministic state exists. Remove `terminal_reversal_access_points`, `shared_service_access_tile`, and the distinct-tile reversal branch.

- [ ] **Step 5: Preserve preview/commit route shape**

Keep both preview and create/update calling `resolve_route_legs`. Assert exact equality of leg key, status, failure reason, road-step positions/headings/movements, and `total_travel_seconds`.

- [ ] **Step 6: Run route tests**

Run:

```bash
cargo fmt --all
cargo test -p caelum-core --test route_editing
cargo test -p caelum-core --test route_preview
cargo clippy -p caelum-core --all-targets -- -D warnings
```

- [ ] **Step 7: Commit**

```bash
git add crates/caelum-core/src/network.rs crates/caelum-core/src/route_lifecycle.rs crates/caelum-core/src/route_editor.rs crates/caelum-core/tests/route_editing.rs crates/caelum-core/tests/route_preview.rs
git commit -m "feat(core): resolve bus routes through explicit access tiles"
```

---

### Task 6: Dual-Road End-to-End Regression Fixtures

**Files:**
- Create: `crates/caelum-core/tests/dual_road_routing.rs`
- Modify: `crates/caelum-core/tests/route_resilience.rs`
- Modify: `crates/caelum-core/tests/transit_router.rs`

**Interfaces:**
- Consumes: Tasks 2–5 public gameplay behavior.
- Produces: full `GameIntent` regressions for HPA-309 acceptance.

- [ ] **Step 1: Write the failing dual-road scenario**

Using only `GameIntent`, draw intersecting dual-bidirectional roads, assert the generated automatic-junction footprint/ports, place roadside stops on differently oriented approaches, preview, and save a route.

Assert concrete steps:

```rust
let steps = route(&engine.snapshot()).legs[0].current_path.as_ref().unwrap().road_steps();
assert!(steps.iter().any(|step| step.position == expected_entry && step.movement == MovementKind::LeftTurn));
assert!(steps.iter().all(|step| lane_accepts(tile_at(step.position).one_way, step.leaving_heading)));
assert!(!steps.iter().any(|step| forbidden_parallel_lane_tiles.contains(&step.position)));
```

- [ ] **Step 2: Add Shuttle and Loop regressions**

Assert an A→B→C Shuttle resolves outbound and return on a normal two-way road; a missing terminal turnaround produces `NoLegalTurnaround` and becomes connected after adding a junction/roundabout. Assert a failed Loop closing service leg is `NetworkDisconnected`, not `NoLegalTurnaround`.

- [ ] **Step 3: Run the new test and diagnose fixture errors**

Run: `cargo test -p caelum-core --test dual_road_routing -- --nocapture`

Expected after Tasks 2–5: PASS. If it fails, fix production code only when the concrete road steps prove a real contract violation; do not loosen assertions to “some turn exists.”

- [ ] **Step 4: Run the relevant Rust regression set**

Run:

```bash
cargo test -p caelum-core --test dual_road_routing
cargo test -p caelum-core --test route_resilience
cargo test -p caelum-core --test transit_router
```

- [ ] **Step 5: Commit**

```bash
git add crates/caelum-core/tests/dual_road_routing.rs crates/caelum-core/tests/route_resilience.rs crates/caelum-core/tests/transit_router.rs
git commit -m "test(core): cover roadside stops across dual-road junctions"
```

---

### Task 7: Rust Workspace Verification

**Files:**
- Verify only; modify production/test files only to fix observed failures.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: CI-ready Rust/WASM/Tauri foundation for the frontend plan.

- [ ] **Step 1: Run formatting**

Run: `cargo fmt --all --check`

Expected: exit 0.

- [ ] **Step 2: Run all Rust tests**

Run: `cargo test --workspace`

Expected: all core, wasm, and Tauri tests pass.

- [ ] **Step 3: Run strict clippy**

Run: `cargo clippy --workspace --all-targets -- -D warnings`

Expected: exit 0 with no warnings.

- [ ] **Step 4: Build the workspace**

Run: `cargo build --workspace`

Expected: exit 0.

- [ ] **Step 5: Inspect the final diff**

Run: `git status --short && git diff --check && git diff --stat`

Expected: only Task 1–6 files changed; no generated WASM artifacts are tracked.

- [ ] **Step 6: Finish with a clean verification state**

If Steps 1–5 required a source change, return to that source file's owning task, rerun its focused test/commit step, and then repeat Steps 1–5. Do not create a catch-all verification commit.

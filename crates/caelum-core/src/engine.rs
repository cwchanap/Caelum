use crate::areas;
use crate::buildings;
use crate::cost_policy::CostedMutation;
use crate::intent::{DispatchContext, DispatchResult, GameIntent};
use crate::model::{GameSnapshot, Point};
use crate::persistence::{prepare_snapshot, validate_snapshot, PersistenceResult};
use crate::preview::{
    self, RoadMutationPreviewRequest, RoadMutationPreviewResponse, RoutePreviewRequest,
    RoutePreviewResponse,
};
use crate::rejection::{GameplayRejection, GameplayResult, RejectionCode};
use crate::road::{self, RoadMutation, RoadMutationResult};
use crate::road_topology::RoadTopology;
use crate::route_editor;
use crate::route_lifecycle;
use crate::sandbox::{
    canonical_default_request, create_sandbox_candidate, sandbox_candidate_from_persisted_rules,
    SandboxCandidate, SandboxCreationError, SandboxCreationRequest, SandboxResetError,
};
use crate::stop_access;
use crate::transit;
use crate::trips;

fn point_changed(before: &GameSnapshot, after: &GameSnapshot, point: &Point) -> bool {
    // Whole-map linear scans: tiles, buildings, stops, and stations are each
    // searched by coordinate in both snapshots for every queried point. This is
    // O(points * (tiles + buildings + stops + stations)) — acceptable today
    // because callers pass only the small set of tiles a single mutation
    // touched, but it would not scale to a full-map diff. If a future caller
    // grows the point set, introduce a coordinate index instead of scanning.
    let before_tile = before
        .map
        .tiles
        .iter()
        .find(|tile| tile.x == point.x && tile.y == point.y);
    let after_tile = after
        .map
        .tiles
        .iter()
        .find(|tile| tile.x == point.x && tile.y == point.y);
    if before_tile != after_tile {
        return true;
    }

    let before_building = before
        .buildings
        .iter()
        .find(|building| building.occupied_tiles.contains(point));
    let after_building = after
        .buildings
        .iter()
        .find(|building| building.occupied_tiles.contains(point));
    if before_building != after_building {
        return true;
    }

    let before_stop = before
        .transit
        .stops
        .iter()
        .find(|stop| stop.position == *point);
    let after_stop = after
        .transit
        .stops
        .iter()
        .find(|stop| stop.position == *point);
    if before_stop != after_stop {
        return true;
    }

    let before_station = before
        .transit
        .stations
        .iter()
        .find(|station| station.position == *point);
    let after_station = after
        .transit
        .stations
        .iter()
        .find(|station| station.position == *point);
    before_station != after_station
}

fn tile_layer_changed(before: &GameSnapshot, after: &GameSnapshot, point: &Point) -> bool {
    let before = before
        .map
        .tiles
        .iter()
        .find(|tile| tile.x == point.x && tile.y == point.y);
    let after = after
        .map
        .tiles
        .iter()
        .find(|tile| tile.x == point.x && tile.y == point.y);
    match (before, after) {
        (Some(before), Some(after)) => {
            before.kind != after.kind
                || before.area != after.area
                || before.has_track != after.has_track
                || before.one_way != after.one_way
                || before.road_connections != after.road_connections
                || before.road_structure_id != after.road_structure_id
        }
        _ => before != after,
    }
}

pub(crate) fn dispatch_context(
    before: &GameSnapshot,
    after: &GameSnapshot,
    requested_tiles: &[Point],
    cost: i32,
) -> DispatchContext {
    let mut changed_tiles = Vec::new();
    let mut skipped_tiles = Vec::new();

    for point in requested_tiles {
        if changed_tiles.contains(point) || skipped_tiles.contains(point) {
            continue;
        }
        if point_changed(before, after, point) {
            changed_tiles.push(*point);
        } else {
            skipped_tiles.push(*point);
        }
    }

    // Some intents expand beyond their explicit anchors (for example the
    // generated reverse carriageway of a dual-road stroke). Include every
    // additional map tile changed by the authoritative mutation.
    for tile in &after.map.tiles {
        let point = Point {
            x: tile.x,
            y: tile.y,
        };
        if !changed_tiles.contains(&point) && tile_layer_changed(before, after, &point) {
            changed_tiles.push(point);
        }
    }

    // Multi-tile PlaceBuilding footprints span tiles beyond the explicit
    // request anchor (only the origin is passed as a requested tile). Include
    // occupancy points from both snapshots so the full footprint is
    // represented. `point_changed` (not `tile_layer_changed`) is required
    // because placing a building does not modify the tile layer — the
    // building is a separate layer.
    for building in before.buildings.iter().chain(after.buildings.iter()) {
        for point in &building.occupied_tiles {
            if !changed_tiles.contains(point) && point_changed(before, after, point) {
                changed_tiles.push(*point);
            }
        }
    }

    DispatchContext {
        changed_tiles,
        skipped_tiles,
        cost,
    }
}

pub(crate) fn normalize_road_mutation_result(
    before: &GameSnapshot,
    mut result: RoadMutationResult,
) -> RoadMutationResult {
    let mut requested_tiles = result.changed_tiles.clone();
    requested_tiles.extend(result.skipped_tiles.iter().copied());
    let context = dispatch_context(before, &result.snapshot, &requested_tiles, result.cost);
    result.changed_tiles = context.changed_tiles;
    result.skipped_tiles = context.skipped_tiles;
    result
}

#[derive(Clone, Copy)]
pub struct RoutingContext<'a> {
    pub road_topology: &'a RoadTopology,
}

pub struct NetworkCandidate {
    pub snapshot: GameSnapshot,
}

impl NetworkCandidate {
    pub fn plain(snapshot: GameSnapshot) -> Self {
        Self { snapshot }
    }

    pub fn from_road(result: RoadMutationResult) -> Self {
        Self {
            snapshot: result.snapshot,
        }
    }
}

#[must_use = "a captured committed snapshot must be prepared or deliberately discarded"]
pub struct SaveSnapshotCapture {
    snapshot: GameSnapshot,
}

impl SaveSnapshotCapture {
    pub fn prepare(mut self) -> PersistenceResult<GameSnapshot> {
        self.snapshot.paused = true;
        validate_snapshot(&self.snapshot)?;
        Ok(self.snapshot)
    }
}

#[must_use = "a prepared restore has no effect until its engine is consumed and assigned by the host"]
pub struct PreparedEngineRestore {
    engine: GameEngine,
}

impl PreparedEngineRestore {
    pub fn snapshot(&self) -> &GameSnapshot {
        &self.engine.snapshot
    }

    pub fn into_engine(self) -> GameEngine {
        self.engine
    }
}

/// Facade for the simulation core. Both the WASM and Tauri hosts drive this
/// same engine: `tick` advances game time, `dispatch` applies a player intent.
///
#[derive(Clone)]
pub struct GameEngine {
    snapshot: GameSnapshot,
    road_topology: RoadTopology,
}

impl Default for GameEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl GameEngine {
    pub fn new() -> Self {
        let SandboxCandidate {
            snapshot,
            road_topology,
        } = create_sandbox_candidate(canonical_default_request())
            .expect("canonical default sandbox request and template must remain valid");
        Self {
            snapshot,
            road_topology,
        }
    }

    pub fn from_sandbox_request(
        request: SandboxCreationRequest,
    ) -> Result<Self, SandboxCreationError> {
        let SandboxCandidate {
            snapshot,
            road_topology,
        } = create_sandbox_candidate(request)?;
        Ok(Self {
            snapshot,
            road_topology,
        })
    }

    /// Construct an engine from an already-paused, persistence-valid schema-v4
    /// snapshot. Serialized fields are retained exactly; only the topology cache
    /// is rebuilt.
    pub fn from_snapshot(snapshot: GameSnapshot) -> PersistenceResult<Self> {
        Ok(Self::prepare_restore(snapshot)?.into_engine())
    }

    pub fn prepare_restore(snapshot: GameSnapshot) -> PersistenceResult<PreparedEngineRestore> {
        let prepared = prepare_snapshot(snapshot)?;
        Ok(PreparedEngineRestore {
            engine: Self {
                snapshot: prepared.snapshot,
                road_topology: prepared.road_topology,
            },
        })
    }

    pub fn snapshot(&self) -> GameSnapshot {
        self.snapshot.clone()
    }

    pub fn capture_snapshot_for_save(&self) -> SaveSnapshotCapture {
        SaveSnapshotCapture {
            snapshot: self.snapshot(),
        }
    }

    pub fn snapshot_for_save(&self) -> PersistenceResult<GameSnapshot> {
        self.capture_snapshot_for_save().prepare()
    }

    pub fn restore_snapshot(&mut self, snapshot: GameSnapshot) -> PersistenceResult<GameSnapshot> {
        let prepared = Self::prepare_restore(snapshot)?;
        let restored = prepared.snapshot().clone();
        *self = prepared.into_engine();
        Ok(restored)
    }

    pub fn reset(&mut self) -> Result<GameSnapshot, SandboxResetError> {
        let candidate = sandbox_candidate_from_persisted_rules(&self.snapshot.rules)?;
        self.snapshot = candidate.snapshot;
        self.road_topology = candidate.road_topology;
        Ok(self.snapshot())
    }

    pub(crate) fn routing_context(&self) -> RoutingContext<'_> {
        RoutingContext {
            road_topology: &self.road_topology,
        }
    }

    #[doc(hidden)]
    pub fn road_topology_for_test(&self) -> &RoadTopology {
        &self.road_topology
    }

    #[doc(hidden)]
    pub fn set_budget_for_test(&mut self, budget: i32) {
        self.snapshot.budget = budget;
    }

    #[doc(hidden)]
    pub fn set_route_revision_for_test(&mut self, route_id: &str, revision: u32) {
        if let Some(route) = self
            .snapshot
            .transit
            .routes
            .iter_mut()
            .find(|route| route.id == route_id)
        {
            route.revision = revision;
            return;
        }
        if let Some(line) = self
            .snapshot
            .transit
            .metro_lines
            .iter_mut()
            .find(|line| line.id == route_id)
        {
            line.revision = revision;
        }
    }

    pub fn preview_route(&self, request: RoutePreviewRequest) -> RoutePreviewResponse {
        preview::preview_route(&self.snapshot, self.routing_context(), request)
    }

    pub fn preview_road_mutation(
        &self,
        request: RoadMutationPreviewRequest,
    ) -> RoadMutationPreviewResponse {
        preview::preview_road_mutation(&self.snapshot, request)
    }

    /// Advance the simulation by `delta_seconds` of game time (scaled by the current
    /// speed) and run objective evaluation. Returns the resulting snapshot. If the tick
    /// produced no change (e.g. paused, speed 0, or a zero-delta substep), the previous
    /// snapshot is returned unchanged with `applied == false` — this reference-equality
    /// dispatch is the engine's commit discipline.
    pub fn tick(&mut self, delta_seconds: f64) -> DispatchResult {
        // Topology invariant: `tick` never recompiles `self.road_topology`
        // because the tick pipeline (trips + growth waves) never modifies road
        // fields. Growth waves only paint areas and place buildings
        // (`growth::apply_due_growth_waves`); neither action touches
        // `road_connections`, `one_way`, `road_structure_id`, or
        // `road_structures`. If a future tick-time mutation touches any road
        // field, the topology must be recompiled here — the debug_assert below
        // catches that regression by flagging a stale topology.
        let next = trips::tick_trips_with_objectives(&self.snapshot, delta_seconds);
        // O(N) check (tiles are never reordered, so same index = same position):
        // if a future tick-time mutation touches any road field, this fires.
        debug_assert!(
            next.map.road_structures == self.snapshot.map.road_structures
                && next.map.tiles.len() == self.snapshot.map.tiles.len()
                && next
                    .map
                    .tiles
                    .iter()
                    .zip(self.snapshot.map.tiles.iter())
                    .all(|(new, prev)| new.road_connections == prev.road_connections
                        && new.one_way == prev.one_way
                        && new.road_structure_id == prev.road_structure_id),
            "tick modified road fields without recompiling topology"
        );
        if next == self.snapshot {
            return DispatchResult::unchanged(self.snapshot());
        }

        self.snapshot = next;
        DispatchResult::applied(self.snapshot())
    }

    /// Apply a single player [`GameIntent`] (build, paint, transit edit, speed/pause,
    /// etc.) to the current snapshot. Returns the resulting snapshot plus an `applied`
    /// flag and a rejection reason when the intent was invalid.
    pub fn dispatch(&mut self, intent: GameIntent) -> DispatchResult {
        match intent {
            GameIntent::SetPaused { paused } => {
                let mut next = self.snapshot.clone();
                next.paused = paused;
                self.commit_result(Ok(CostedMutation::free(next)))
            }
            GameIntent::SetSpeed { speed } => {
                if !matches!(speed, 0 | 1 | 2 | 4) {
                    return DispatchResult::rejected(
                        self.snapshot(),
                        GameplayRejection::new(RejectionCode::InvalidSpeed),
                    );
                }
                let mut next = self.snapshot.clone();
                next.speed = speed;
                self.commit_result(Ok(CostedMutation::free(next)))
            }
            GameIntent::AssignVehicle { mode, line_id } => self.commit_result(
                transit::assign_vehicle_costed(&self.snapshot, &mode, &line_id),
            ),
            GameIntent::LayRoad { point } => self.commit_network_mutation(
                road::apply_road_mutation(&self.snapshot, &RoadMutation::LayRoad { point })
                    .map(NetworkCandidate::from_road),
            ),
            GameIntent::LayRoadLine { points, preset } => self.commit_network_mutation(
                road::apply_road_mutation(
                    &self.snapshot,
                    &RoadMutation::LayRoadLine { points, preset },
                )
                .map(NetworkCandidate::from_road),
            ),
            GameIntent::CycleRoadDirection { point } => self.commit_network_mutation(
                road::apply_road_mutation(
                    &self.snapshot,
                    &RoadMutation::CycleRoadDirection { point },
                )
                .map(NetworkCandidate::from_road),
            ),
            GameIntent::PlaceRoundabout { origin, size } => self.commit_network_mutation(
                road::apply_road_mutation(
                    &self.snapshot,
                    &RoadMutation::PlaceRoundabout { origin, size },
                )
                .map(NetworkCandidate::from_road),
            ),
            GameIntent::LayTrack { point } => {
                let candidate =
                    self.network_candidate(transit::lay_track_costed(&self.snapshot, &point));
                self.commit_network_mutation(candidate)
            }
            GameIntent::LayTrackLine { points } => {
                let candidate =
                    self.network_candidate(transit::lay_track_line_costed(&self.snapshot, &points));
                self.commit_network_mutation(candidate)
            }
            GameIntent::RemoveAtTile { point } => {
                let candidate = self.network_candidate(
                    transit::remove_at_tile(&self.snapshot, &point).map(CostedMutation::free),
                );
                self.commit_network_mutation(candidate)
            }
            GameIntent::RemoveAtTiles { points } => {
                let candidate = self.network_candidate(
                    transit::remove_at_tiles(&self.snapshot, &points).map(CostedMutation::free),
                );
                self.commit_network_mutation(candidate)
            }
            GameIntent::AddBusStop { point } => {
                let candidate =
                    self.network_candidate(transit::add_bus_stop_costed(&self.snapshot, &point));
                self.commit_network_mutation(candidate)
            }
            GameIntent::AddMetroStation { point } => {
                let candidate = self
                    .network_candidate(transit::add_metro_station_costed(&self.snapshot, &point));
                self.commit_network_mutation(candidate)
            }
            GameIntent::CreateRoute {
                mode,
                pattern,
                waypoint_ids,
            } => {
                let result = route_editor::create_route_costed(
                    &self.snapshot,
                    self.routing_context(),
                    mode,
                    pattern,
                    waypoint_ids,
                );
                self.commit_result(result)
            }
            GameIntent::UpdateRoute {
                route_id,
                expected_revision,
                pattern,
                waypoint_ids,
            } => {
                let result = route_editor::update_route(
                    &self.snapshot,
                    self.routing_context(),
                    &route_id,
                    expected_revision,
                    pattern,
                    waypoint_ids,
                );
                self.commit_result(result.map(CostedMutation::free))
            }
            GameIntent::SetRouteActive { route_id, active } => self.commit_result(
                transit::set_route_active(&self.snapshot, &route_id, active)
                    .map(CostedMutation::free),
            ),
            GameIntent::RenameRoute { route_id, name } => self.commit_result(
                transit::rename_route(&self.snapshot, &route_id, &name).map(CostedMutation::free),
            ),
            GameIntent::RecolorRoute { route_id, color } => self.commit_result(
                transit::recolor_route(&self.snapshot, &route_id, &color).map(CostedMutation::free),
            ),
            GameIntent::DeleteRoute { route_id } => self.commit_result(
                transit::delete_route(&self.snapshot, &route_id).map(CostedMutation::free),
            ),
            GameIntent::AssignRouteToPlatform {
                node_id,
                route_id,
                platform_id,
            } => self.commit_result(
                transit::assign_route_to_platform(
                    &self.snapshot,
                    &node_id,
                    &route_id,
                    &platform_id,
                )
                .map(CostedMutation::free),
            ),
            GameIntent::PaintAreaRectangle { area, start, end } => self.commit_result(
                areas::paint_area_rectangle(&self.snapshot, &area, &start, &end)
                    .map(CostedMutation::free),
            ),
            GameIntent::PlaceBuilding {
                building_type,
                origin,
                rotation,
            } => {
                let candidate = self.network_candidate(buildings::place_building_costed(
                    &self.snapshot,
                    &building_type,
                    &origin,
                    rotation,
                ));
                self.commit_network_mutation(candidate)
            }
            // Debug/test-only: production release builds ignore this intent so a
            // host cannot bypass construction costs via `{ "type": "setBudget" }`.
            // Unit tests use `set_budget_for_test`; e2e uses debug WASM builds.
            GameIntent::SetBudget { budget } => {
                if !cfg!(debug_assertions) {
                    return DispatchResult::unchanged(self.snapshot());
                }
                let mut next = self.snapshot.clone();
                next.budget = budget;
                self.commit_result(Ok(CostedMutation::free(next)))
            }
        }
    }

    fn commit_result(&mut self, result: GameplayResult<CostedMutation>) -> DispatchResult {
        match result {
            Ok(mutation) => {
                let next = mutation.into_snapshot();
                if next == self.snapshot {
                    return DispatchResult::unchanged(self.snapshot());
                }
                self.snapshot = next;
                DispatchResult::applied(self.snapshot())
            }
            Err(rejection) => DispatchResult::rejected(self.snapshot(), rejection),
        }
    }

    fn network_candidate(
        &self,
        result: GameplayResult<CostedMutation>,
    ) -> GameplayResult<NetworkCandidate> {
        result.map(|mutation| NetworkCandidate::plain(mutation.into_snapshot()))
    }

    fn commit_network_mutation(
        &mut self,
        candidate: GameplayResult<NetworkCandidate>,
    ) -> DispatchResult {
        let mut network_candidate = match candidate {
            Ok(candidate) => candidate,
            Err(rejection) => return DispatchResult::rejected(self.snapshot(), rejection),
        };
        let map_changed = self.snapshot.map != network_candidate.snapshot.map;
        if map_changed {
            // Short-circuit: skip the O(stops × footprint) normalization +
            // rebase pass when no present stop's road-access neighbourhood
            // changed between the old and new maps (e.g. a road edit far
            // from any stop). Mirrors the `changed_accesses.is_empty()` gate
            // in route_lifecycle::rebase_parked_bus_access_to_live_stop.
            if stop_access::stops_access_affected(&self.snapshot.map, &network_candidate.snapshot) {
                network_candidate.snapshot =
                    stop_access::normalize_snapshot_stops(network_candidate.snapshot);
            }
        }
        // If the map's road topology inputs are unchanged (e.g. AddBusStop,
        // AddMetroStation, PlaceBuilding — none of which modify map tiles),
        // skip the O(N²) topology compile and reuse the cached topology.
        // Route recompute still runs because transit node changes (stop/station
        // removal, status changes) can break route legs without altering the map.
        let topology = if !map_changed {
            self.road_topology.clone()
        } else {
            match RoadTopology::compile(&network_candidate.snapshot.map) {
                Ok(topology) => topology,
                Err(error) => {
                    return DispatchResult::rejected(self.snapshot(), error.into());
                }
            }
        };
        let candidate = route_lifecycle::recompute_all_routes(
            &self.snapshot,
            network_candidate.snapshot,
            RoutingContext {
                road_topology: &topology,
            },
        );
        self.commit_snapshot_and_topology(candidate, topology)
    }

    fn commit_snapshot_and_topology(
        &mut self,
        snapshot: GameSnapshot,
        road_topology: RoadTopology,
    ) -> DispatchResult {
        if snapshot == self.snapshot {
            return DispatchResult::unchanged(self.snapshot());
        }
        self.snapshot = snapshot;
        self.road_topology = road_topology;
        DispatchResult::applied(self.snapshot())
    }
}

use crate::areas;
use crate::buildings;
use crate::intent::{DispatchContext, DispatchResult, GameIntent};
use crate::model::{GameSnapshot, Point};
use crate::preview::{
    self, RoadMutationPreviewRequest, RoadMutationPreviewResponse, RoutePreviewRequest,
    RoutePreviewResponse,
};
use crate::rejection::{GameplayRejection, GameplayResult, RejectionCode};
use crate::road::{self, RoadMutation, RoadMutationResult};
use crate::road_topology::RoadTopology;
use crate::route_editor;
use crate::route_lifecycle;
use crate::state::create_initial_snapshot;
use crate::transit;
use crate::trips;

fn point_changed(before: &GameSnapshot, after: &GameSnapshot, point: &Point) -> bool {
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
                || before.road_structure_id != after.road_structure_id
        }
        _ => before != after,
    }
}

pub(crate) fn dispatch_context(
    before: &GameSnapshot,
    after: &GameSnapshot,
    requested_tiles: &[Point],
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

    DispatchContext {
        changed_tiles,
        skipped_tiles,
        affected_route_ids: route_lifecycle::structurally_changed_route_ids(before, after),
        cost: before.budget.saturating_sub(after.budget),
    }
}

#[derive(Clone, Copy)]
pub struct RoutingContext<'a> {
    pub road_topology: &'a RoadTopology,
}

pub struct NetworkCandidate {
    pub snapshot: GameSnapshot,
    pub context: DispatchContext,
}

impl NetworkCandidate {
    pub fn plain(snapshot: GameSnapshot) -> Self {
        Self {
            snapshot,
            context: DispatchContext::default(),
        }
    }

    pub fn from_road(result: RoadMutationResult) -> Self {
        let context = result.dispatch_context();
        Self {
            snapshot: result.snapshot,
            context,
        }
    }
}

#[derive(Clone, Debug)]
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
        let snapshot = create_initial_snapshot();
        let road_topology =
            RoadTopology::compile(&snapshot.map).expect("initial road topology must compile");
        Self {
            snapshot,
            road_topology,
        }
    }

    pub fn snapshot(&self) -> GameSnapshot {
        self.snapshot.clone()
    }

    pub fn reset(&mut self) -> GameSnapshot {
        let snapshot = create_initial_snapshot();
        let road_topology =
            RoadTopology::compile(&snapshot.map).expect("reset road topology must compile");
        self.snapshot = snapshot;
        self.road_topology = road_topology;
        self.snapshot()
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

    pub fn preview_route(&self, request: RoutePreviewRequest) -> RoutePreviewResponse {
        preview::preview_route(&self.snapshot, self.routing_context(), request)
    }

    pub fn preview_road_mutation(
        &self,
        request: RoadMutationPreviewRequest,
    ) -> RoadMutationPreviewResponse {
        preview::preview_road_mutation(&self.snapshot, &self.road_topology, request)
    }

    /// Advance the simulation by `delta_seconds` of game time (scaled by the current
    /// speed) and run objective evaluation. Returns the resulting snapshot. If the tick
    /// produced no change (e.g. paused, speed 0, or a zero-delta substep), the previous
    /// snapshot is returned unchanged with `applied == false` — this reference-equality
    /// dispatch is the engine's commit discipline.
    pub fn tick(&mut self, delta_seconds: f64) -> DispatchResult {
        let next = trips::tick_trips_with_objectives(
            &self.snapshot,
            self.routing_context(),
            delta_seconds,
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
                self.commit_result(Ok(next))
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
                self.commit_result(Ok(next))
            }
            GameIntent::AssignVehicle { mode, line_id } => {
                self.commit_result(transit::assign_vehicle(&self.snapshot, &mode, &line_id))
            }
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
                let candidate = self.network_candidate_for_tiles(
                    transit::lay_track(&self.snapshot, &point),
                    &[point],
                );
                self.commit_network_mutation(candidate)
            }
            GameIntent::LayTrackLine { points } => {
                let candidate = self.network_candidate_for_tiles(
                    transit::lay_track_line(&self.snapshot, &points),
                    &points,
                );
                self.commit_network_mutation(candidate)
            }
            GameIntent::RemoveAtTile { point } => {
                let candidate = self.network_candidate_for_tiles(
                    transit::remove_at_tile(&self.snapshot, &point),
                    &[point],
                );
                self.commit_network_mutation(candidate)
            }
            GameIntent::RemoveAtTiles { points } => {
                let candidate = self.network_candidate_for_tiles(
                    transit::remove_at_tiles(&self.snapshot, &points),
                    &points,
                );
                self.commit_network_mutation(candidate)
            }
            GameIntent::AddBusStop { point } => {
                let candidate = self.network_candidate_for_tiles(
                    transit::add_bus_stop(&self.snapshot, &point),
                    &[point],
                );
                self.commit_network_mutation(candidate)
            }
            GameIntent::AddMetroStation { point } => {
                let candidate = self.network_candidate_for_tiles(
                    transit::add_metro_station(&self.snapshot, &point),
                    &[point],
                );
                self.commit_network_mutation(candidate)
            }
            GameIntent::CreateRoute {
                mode,
                pattern,
                waypoint_ids,
            } => {
                let result = route_editor::create_route(
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
                self.commit_result(result)
            }
            GameIntent::SetRouteActive { route_id, active } => {
                self.commit_result(transit::set_route_active(&self.snapshot, &route_id, active))
            }
            GameIntent::RenameRoute { route_id, name } => {
                self.commit_result(transit::rename_route(&self.snapshot, &route_id, &name))
            }
            GameIntent::RecolorRoute { route_id, color } => {
                self.commit_result(transit::recolor_route(&self.snapshot, &route_id, &color))
            }
            GameIntent::DeleteRoute { route_id } => {
                self.commit_result(transit::delete_route(&self.snapshot, &route_id))
            }
            GameIntent::AssignRouteToPlatform {
                node_id,
                route_id,
                platform_id,
            } => self.commit_result(transit::assign_route_to_platform(
                &self.snapshot,
                &node_id,
                &route_id,
                &platform_id,
            )),
            GameIntent::PaintAreaRectangle { area, start, end } => {
                let points = areas::rectangle_points(
                    &start,
                    &end,
                    self.snapshot.map.width,
                    self.snapshot.map.height,
                );
                self.commit_result_for_tiles(
                    areas::paint_area_rectangle(&self.snapshot, &area, &start, &end),
                    &points,
                )
            }
            GameIntent::PlaceBuilding {
                building_type,
                origin,
                rotation,
            } => {
                let candidate = self.network_candidate_for_tiles(
                    buildings::place_building(&self.snapshot, &building_type, &origin, rotation),
                    &[origin],
                );
                self.commit_network_mutation(candidate)
            }
        }
    }

    fn commit_result(&mut self, result: GameplayResult<GameSnapshot>) -> DispatchResult {
        self.commit_result_for_tiles(result, &[])
    }

    fn network_candidate_for_tiles(
        &self,
        result: GameplayResult<GameSnapshot>,
        requested_tiles: &[Point],
    ) -> GameplayResult<NetworkCandidate> {
        result.map(|snapshot| {
            let context = dispatch_context(&self.snapshot, &snapshot, requested_tiles);
            let mut candidate = NetworkCandidate::plain(snapshot);
            candidate.context = context;
            candidate
        })
    }

    fn commit_network_mutation(
        &mut self,
        candidate: GameplayResult<NetworkCandidate>,
    ) -> DispatchResult {
        let mut network_candidate = match candidate {
            Ok(candidate) => candidate,
            Err(rejection) => return DispatchResult::rejected(self.snapshot(), rejection),
        };
        let topology = match RoadTopology::compile(&network_candidate.snapshot.map) {
            Ok(topology) => topology,
            Err(rejection) => return DispatchResult::rejected(self.snapshot(), rejection),
        };
        let candidate = route_lifecycle::recompute_affected_routes(
            &self.snapshot,
            network_candidate.snapshot,
            RoutingContext {
                road_topology: &topology,
            },
        );
        network_candidate.context.affected_route_ids =
            route_lifecycle::structurally_changed_route_ids(&self.snapshot, &candidate);
        self.commit_snapshot_and_topology(candidate, topology, network_candidate.context)
    }

    fn commit_snapshot_and_topology(
        &mut self,
        snapshot: GameSnapshot,
        road_topology: RoadTopology,
        context: DispatchContext,
    ) -> DispatchResult {
        if snapshot == self.snapshot {
            return DispatchResult::unchanged(self.snapshot());
        }
        self.snapshot = snapshot;
        self.road_topology = road_topology;
        DispatchResult::applied_with_context(self.snapshot(), context)
    }

    fn commit_result_for_tiles(
        &mut self,
        result: GameplayResult<GameSnapshot>,
        requested_tiles: &[Point],
    ) -> DispatchResult {
        match result {
            Ok(next) => {
                if next == self.snapshot {
                    return DispatchResult::unchanged(self.snapshot());
                }
                let context = dispatch_context(&self.snapshot, &next, requested_tiles);
                self.snapshot = next;
                DispatchResult::applied_with_context(self.snapshot(), context)
            }
            Err(rejection) => DispatchResult::rejected(self.snapshot(), rejection),
        }
    }
}

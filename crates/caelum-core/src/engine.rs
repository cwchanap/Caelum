use crate::areas;
use crate::buildings;
use crate::intent::{DispatchContext, DispatchResult, GameIntent};
use crate::model::{GameSnapshot, Point};
use crate::rejection::{GameplayRejection, GameplayResult, RejectionCode};
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

fn affected_route_ids(before: &GameSnapshot, after: &GameSnapshot) -> Vec<String> {
    let mut affected = Vec::new();

    for route in &before.transit.routes {
        if after
            .transit
            .routes
            .iter()
            .find(|candidate| candidate.id == route.id)
            != Some(route)
        {
            affected.push(route.id.clone());
        }
    }
    for route in &after.transit.routes {
        if !before
            .transit
            .routes
            .iter()
            .any(|candidate| candidate.id == route.id)
        {
            affected.push(route.id.clone());
        }
    }

    for line in &before.transit.metro_lines {
        if after
            .transit
            .metro_lines
            .iter()
            .find(|candidate| candidate.id == line.id)
            != Some(line)
        {
            affected.push(line.id.clone());
        }
    }
    for line in &after.transit.metro_lines {
        if !before
            .transit
            .metro_lines
            .iter()
            .any(|candidate| candidate.id == line.id)
        {
            affected.push(line.id.clone());
        }
    }

    affected
}

fn dispatch_context(
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
        if !changed_tiles.contains(&point) && point_changed(before, after, &point) {
            changed_tiles.push(point);
        }
    }

    DispatchContext {
        changed_tiles,
        skipped_tiles,
        affected_route_ids: affected_route_ids(before, after),
        cost: before.budget.saturating_sub(after.budget),
    }
}

#[derive(Clone, Debug)]
pub struct GameEngine {
    snapshot: GameSnapshot,
}

impl Default for GameEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl GameEngine {
    pub fn new() -> Self {
        Self {
            snapshot: create_initial_snapshot(),
        }
    }

    pub fn snapshot(&self) -> GameSnapshot {
        self.snapshot.clone()
    }

    pub fn reset(&mut self) -> GameSnapshot {
        self.snapshot = create_initial_snapshot();
        self.snapshot()
    }

    /// Advance the simulation by `delta_seconds` of game time (scaled by the current
    /// speed) and run objective evaluation. Returns the resulting snapshot. If the tick
    /// produced no change (e.g. paused, speed 0, or a zero-delta substep), the previous
    /// snapshot is returned unchanged with `applied == false` — this reference-equality
    /// dispatch is the engine's commit discipline.
    pub fn tick(&mut self, delta_seconds: f64) -> DispatchResult {
        let next = trips::tick_trips_with_objectives(&self.snapshot, delta_seconds);
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
            GameIntent::LayRoad { point } => {
                self.commit_result_for_tiles(transit::lay_road(&self.snapshot, &point), &[point])
            }
            GameIntent::LayRoadLine { points, preset } => self.commit_result_for_tiles(
                transit::lay_road_line(&self.snapshot, &points, preset),
                &points,
            ),
            GameIntent::CycleRoadDirection { point } => self.commit_result_for_tiles(
                transit::cycle_road_direction(&self.snapshot, &point),
                &[point],
            ),
            GameIntent::LayTrack { point } => {
                self.commit_result_for_tiles(transit::lay_track(&self.snapshot, &point), &[point])
            }
            GameIntent::LayTrackLine { points } => self
                .commit_result_for_tiles(transit::lay_track_line(&self.snapshot, &points), &points),
            GameIntent::RemoveAtTile { point } => self
                .commit_result_for_tiles(transit::remove_at_tile(&self.snapshot, &point), &[point]),
            GameIntent::RemoveAtTiles { points } => self.commit_result_for_tiles(
                transit::remove_at_tiles(&self.snapshot, &points),
                &points,
            ),
            GameIntent::AddBusStop { point } => self
                .commit_result_for_tiles(transit::add_bus_stop(&self.snapshot, &point), &[point]),
            GameIntent::AddMetroStation { point } => self.commit_result_for_tiles(
                transit::add_metro_station(&self.snapshot, &point),
                &[point],
            ),
            GameIntent::AddBusRoute { stop_ids } => {
                self.commit_result(transit::add_bus_route(&self.snapshot, stop_ids))
            }
            GameIntent::AddMetroLine { station_ids } => {
                self.commit_result(transit::add_metro_line(&self.snapshot, station_ids))
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
            } => self.commit_result_for_tiles(
                buildings::place_building(&self.snapshot, &building_type, &origin, rotation),
                &[origin],
            ),
        }
    }

    fn commit_result(&mut self, result: GameplayResult<GameSnapshot>) -> DispatchResult {
        self.commit_result_for_tiles(result, &[])
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

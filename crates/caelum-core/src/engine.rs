use crate::areas;
use crate::buildings;
use crate::intent::{DispatchResult, GameIntent};
use crate::model::GameSnapshot;
use crate::objectives;
use crate::state::create_initial_snapshot;
use crate::transit;
use crate::trips;

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
        let next =
            objectives::evaluate_objectives(&trips::tick_trips(&self.snapshot, delta_seconds));
        if next == self.snapshot {
            return DispatchResult {
                snapshot: self.snapshot(),
                applied: false,
                rejection: None,
            };
        }

        self.snapshot = next;
        DispatchResult {
            snapshot: self.snapshot(),
            applied: true,
            rejection: None,
        }
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
                    return DispatchResult {
                        snapshot: self.snapshot(),
                        applied: false,
                        rejection: Some(format!("invalid speed: {speed}")),
                    };
                }
                let mut next = self.snapshot.clone();
                next.speed = speed;
                self.commit_result(Ok(next))
            }
            GameIntent::AssignVehicle { mode, line_id } => {
                self.commit_result(transit::assign_vehicle(&self.snapshot, &mode, &line_id))
            }
            GameIntent::LayRoad { point } => {
                self.commit_result(transit::lay_road(&self.snapshot, &point))
            }
            GameIntent::CycleRoadDirection { point } => {
                self.commit_result(transit::cycle_road_direction(&self.snapshot, &point))
            }
            GameIntent::LayTrack { point } => {
                self.commit_result(transit::lay_track(&self.snapshot, &point))
            }
            GameIntent::RemoveAtTile { point } => {
                self.commit_result(transit::remove_at_tile(&self.snapshot, &point))
            }
            GameIntent::AddBusStop { point } => {
                self.commit_result(transit::add_bus_stop(&self.snapshot, &point))
            }
            GameIntent::AddMetroStation { point } => {
                self.commit_result(transit::add_metro_station(&self.snapshot, &point))
            }
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
                match areas::paint_area_rectangle(&self.snapshot, &area, &start, &end) {
                    Some(next) => {
                        self.snapshot = next;
                        DispatchResult {
                            snapshot: self.snapshot(),
                            applied: true,
                            rejection: None,
                        }
                    }
                    None => DispatchResult {
                        snapshot: self.snapshot(),
                        applied: false,
                        rejection: Some("no paintable tiles".to_string()),
                    },
                }
            }
            GameIntent::PlaceBuilding {
                building_type,
                origin,
                rotation,
            } => match buildings::place_building(&self.snapshot, &building_type, &origin, rotation)
            {
                Ok(next) => {
                    self.snapshot = next;
                    DispatchResult {
                        snapshot: self.snapshot(),
                        applied: true,
                        rejection: None,
                    }
                }
                Err(rejection) => DispatchResult {
                    snapshot: self.snapshot(),
                    applied: false,
                    rejection: Some(rejection),
                },
            },
        }
    }

    fn commit_result(&mut self, result: Result<GameSnapshot, String>) -> DispatchResult {
        match result {
            Ok(next) => {
                self.snapshot = next;
                DispatchResult {
                    snapshot: self.snapshot(),
                    applied: true,
                    rejection: None,
                }
            }
            Err(rejection) => DispatchResult {
                snapshot: self.snapshot(),
                applied: false,
                rejection: Some(rejection),
            },
        }
    }
}

use std::collections::HashSet;

use crate::intent::GameIntent;
use crate::model::{GameMap, GameSnapshot, Point};

pub(crate) const UNDO_WINDOW_SECONDS: f64 = crate::clock::GAME_DAY_SECONDS / 24.0;

pub(crate) struct BuildUndo {
    pub(crate) built_at: f64,
    pub(crate) refund: i32,
    pub(crate) inverse: BuildInverse,
}

pub(crate) enum BuildInverse {
    RestoreMap(GameMap),
    Demolish(Point),
}

pub(crate) enum BuildClass {
    Map,
    Placement(Point),
    Demolition,
    Undo,
    Other,
}

pub(crate) fn classify(intent: &GameIntent) -> BuildClass {
    match intent {
        GameIntent::LayRoad { .. }
        | GameIntent::LayRoadLine { .. }
        | GameIntent::CycleRoadDirection { .. }
        | GameIntent::PlaceRoundabout { .. }
        | GameIntent::LayTrack { .. }
        | GameIntent::LayTrackLine { .. }
        | GameIntent::PaintAreaRectangle { .. } => BuildClass::Map,
        GameIntent::AddBusStop { point } | GameIntent::AddMetroStation { point } => {
            BuildClass::Placement(*point)
        }
        GameIntent::PlaceBuilding { origin, .. } => BuildClass::Placement(*origin),
        GameIntent::RemoveAtTile { .. } | GameIntent::RemoveAtTiles { .. } => {
            BuildClass::Demolition
        }
        GameIntent::UndoLastBuild => BuildClass::Undo,
        GameIntent::SetPaused { .. }
        | GameIntent::SetSpeed { .. }
        | GameIntent::AssignVehicle { .. }
        | GameIntent::SetServiceTargetHeadway { .. }
        | GameIntent::DeployInitialFleet { .. }
        | GameIntent::AddServiceVehicle { .. }
        | GameIntent::RetireServiceVehicle { .. }
        | GameIntent::CreateRoute { .. }
        | GameIntent::UpdateRoute { .. }
        | GameIntent::SetRouteActive { .. }
        | GameIntent::RenameRoute { .. }
        | GameIntent::RecolorRoute { .. }
        | GameIntent::DeleteRoute { .. }
        | GameIntent::AssignRouteToPlatform { .. }
        | GameIntent::SetBudget { .. } => BuildClass::Other,
    }
}

pub(crate) fn grown_building_conflict(live: &GameSnapshot, before_map: &GameMap) -> Option<Point> {
    live.buildings.iter().find_map(|building| {
        building
            .occupied_tiles
            .iter()
            .find(|point| {
                live.map.tile(**point).and_then(|tile| tile.area.as_deref())
                    != before_map
                        .tile(**point)
                        .and_then(|tile| tile.area.as_deref())
            })
            .copied()
    })
}

pub(crate) fn newly_broken_route(live: &GameSnapshot, prepared: &GameSnapshot) -> Option<String> {
    let connected: HashSet<&str> = live
        .transit
        .routes
        .iter()
        .filter(|route| !route.path_broken)
        .map(|route| route.id.as_str())
        .chain(
            live.transit
                .metro_lines
                .iter()
                .filter(|line| !line.path_broken)
                .map(|line| line.id.as_str()),
        )
        .collect();
    prepared
        .transit
        .routes
        .iter()
        .find(|route| route.path_broken && connected.contains(route.id.as_str()))
        .map(|route| route.id.clone())
        .or_else(|| {
            prepared
                .transit
                .metro_lines
                .iter()
                .find(|line| line.path_broken && connected.contains(line.id.as_str()))
                .map(|line| line.id.clone())
        })
}

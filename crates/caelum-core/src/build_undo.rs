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

pub(crate) fn grown_building_conflicts(live: &GameSnapshot, before_map: &GameMap) -> bool {
    live.buildings.iter().any(|building| {
        building.occupied_tiles.iter().any(|point| {
            live.map.tile(*point).and_then(|tile| tile.area.as_deref())
                != before_map
                    .tile(*point)
                    .and_then(|tile| tile.area.as_deref())
        })
    })
}

pub(crate) fn breaks_connected_route(live: &GameSnapshot, prepared: &GameSnapshot) -> bool {
    let was_connected = |route_id: &str| {
        live.transit
            .routes
            .iter()
            .find(|route| route.id == route_id)
            .map(|route| !route.path_broken)
            .or_else(|| {
                live.transit
                    .metro_lines
                    .iter()
                    .find(|line| line.id == route_id)
                    .map(|line| !line.path_broken)
            })
            .unwrap_or(false)
    };
    prepared
        .transit
        .routes
        .iter()
        .any(|route| route.path_broken && was_connected(&route.id))
        || prepared
            .transit
            .metro_lines
            .iter()
            .any(|line| line.path_broken && was_connected(&line.id))
}

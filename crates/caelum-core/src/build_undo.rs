//! One-level undo of the most recent applied construction intent.
//!
//! The engine retains the inverse of the last applied build — never a whole
//! snapshot — together with the actual budget debit and the engine-time the
//! build committed. `UndoLastBuild` restores it while the record is younger
//! than [`UNDO_WINDOW_SECONDS`]; expiry, a successful demolition, save
//! capture, restore, and reset each drop it.

use crate::intent::GameIntent;
use crate::model::{GameMap, GameSnapshot, Point};

/// One in-game hour on the compressed clock (`GAME_DAY_SECONDS / 24 == 50`
/// engine-time units). Pausing the simulation also pauses the window because
/// `built_at` is measured in `GameSnapshot::time`.
pub(crate) const UNDO_WINDOW_SECONDS: f64 = crate::clock::GAME_DAY_SECONDS / 24.0;

/// The retained inverse of one applied build: enough to put back exactly what
/// construction changed, never a whole-state rewind.
pub(crate) struct BuildUndo {
    /// `GameSnapshot::time` when the build applied.
    pub(crate) built_at: f64,
    /// Actual budget debit (`before - after`), so partially applied strokes
    /// refund only what they charged.
    pub(crate) refund: i32,
    pub(crate) inverse: BuildInverse,
}

pub(crate) enum BuildInverse {
    /// Whole pre-build map for road/track/zone strokes — automatic junctions
    /// and regenerated connections come back with it.
    RestoreMap(GameMap),
    /// Placement anchor demolished through the ordinary `remove_at_tile`
    /// path, which removes a building together with its transit node.
    Demolish(Point),
}

/// How a dispatched intent interacts with the retained build record.
pub(crate) enum BuildClass {
    /// Map mutation whose inverse is the whole pre-build map.
    Map,
    /// Placement whose inverse is demolition at the anchor point.
    Placement(Point),
    /// Successful demolition consumes the record.
    Demolition,
    /// The undo intent itself never produces a record.
    Undo,
    /// Everything else leaves the record alone.
    Other,
}

/// Exhaustive classification of every gameplay intent — adding a variant to
/// [`GameIntent`] forces an explicit undo-policy choice at compile time.
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

/// A map-restore undo conflicts when a building now occupies a tile whose
/// zoning (`area`) restoration would change — the building arrived after the
/// recorded map and depends on the newer zoning. Comparing `area` rather than
/// the whole tile avoids a false rejection when an existing metro station sits
/// on a road whose direction was edited.
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

/// The undo vetoes only a connected route/metro line that preparation marks
/// `path_broken`; a route that simply reroutes back onto an older connected
/// path does not block it.
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

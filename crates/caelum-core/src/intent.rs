use serde::{Deserialize, Serialize};

use crate::model::{GameSnapshot, Point, RoundaboutSize, ServicePattern, TransitMode};
use crate::rejection::GameplayRejection;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RoadPreset {
    TwoWay,
    OneWay,
    DualBidirectional,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GameIntent {
    SetPaused {
        paused: bool,
    },
    SetSpeed {
        speed: u8,
    },
    AssignVehicle {
        mode: String,
        line_id: String,
    },
    LayRoad {
        point: Point,
    },
    LayRoadLine {
        points: Vec<Point>,
        preset: RoadPreset,
    },
    CycleRoadDirection {
        point: Point,
    },
    PlaceRoundabout {
        origin: Point,
        size: RoundaboutSize,
    },
    LayTrack {
        point: Point,
    },
    LayTrackLine {
        points: Vec<Point>,
    },
    RemoveAtTile {
        point: Point,
    },
    RemoveAtTiles {
        points: Vec<Point>,
    },
    AddBusStop {
        point: Point,
    },
    AddMetroStation {
        point: Point,
    },
    CreateRoute {
        mode: TransitMode,
        pattern: ServicePattern,
        waypoint_ids: Vec<String>,
    },
    UpdateRoute {
        route_id: String,
        expected_revision: u32,
        pattern: ServicePattern,
        waypoint_ids: Vec<String>,
    },
    SetRouteActive {
        route_id: String,
        active: bool,
    },
    RenameRoute {
        route_id: String,
        name: String,
    },
    RecolorRoute {
        route_id: String,
        color: String,
    },
    DeleteRoute {
        route_id: String,
    },
    AssignRouteToPlatform {
        node_id: String,
        route_id: String,
        platform_id: String,
    },
    PaintAreaRectangle {
        area: String,
        start: Point,
        end: Point,
    },
    PlaceBuilding {
        building_type: String,
        origin: Point,
        rotation: u16,
    },
    /// Debug/e2e helper to set the budget directly. Deserialized on the wire
    /// for dev WASM/e2e, but `GameEngine::dispatch` only applies it under
    /// `debug_assertions` — release builds leave the snapshot unchanged.
    /// Prefer `GameEngine::set_budget_for_test` in unit tests.
    SetBudget {
        budget: i32,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchResult {
    pub snapshot: GameSnapshot,
    pub applied: bool,
    pub rejection: Option<GameplayRejection>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct DispatchContext {
    pub(crate) changed_tiles: Vec<Point>,
    pub(crate) skipped_tiles: Vec<Point>,
    pub(crate) cost: i32,
}

impl DispatchResult {
    pub fn applied(snapshot: GameSnapshot) -> Self {
        Self {
            snapshot,
            applied: true,
            rejection: None,
        }
    }

    pub fn unchanged(snapshot: GameSnapshot) -> Self {
        Self {
            snapshot,
            applied: false,
            rejection: None,
        }
    }

    pub fn rejected(snapshot: GameSnapshot, rejection: GameplayRejection) -> Self {
        Self {
            snapshot,
            applied: false,
            rejection: Some(rejection),
        }
    }
}

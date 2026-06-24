use serde::{Deserialize, Serialize};

use crate::model::{GameSnapshot, Point};

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
    RecordTripOutcome {
        outcome: String,
        wait_seconds: f64,
        time: f64,
    },
    AssignVehicle {
        mode: String,
        line_id: String,
    },
    LayRoad {
        point: Point,
    },
    CycleRoadDirection {
        point: Point,
    },
    LayTrack {
        point: Point,
    },
    RemoveAtTile {
        point: Point,
    },
    AddBusStop {
        point: Point,
        kind: String,
    },
    AddMetroStation {
        point: Point,
    },
    AddBusRoute {
        stop_ids: Vec<String>,
    },
    AddMetroLine {
        station_ids: Vec<String>,
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
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchResult {
    pub snapshot: GameSnapshot,
    pub applied: bool,
    pub rejection: Option<String>,
}

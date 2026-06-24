use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSnapshot {
    pub time: f64,
    pub day: u32,
    pub clock_minutes: u16,
    pub speed: u8,
    pub paused: bool,
    pub budget: i32,
    pub map: GameMap,
    pub buildings: Vec<PlacedBuilding>,
    pub transit: TransitNetwork,
    pub sims: Vec<Sim>,
    pub active_trips: Vec<ActiveTrip>,
    pub metrics: Metrics,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameMap {
    pub width: u8,
    pub height: u8,
    pub tiles: Vec<Tile>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tile {
    pub id: String,
    pub x: i32,
    pub y: i32,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub area: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub has_track: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub one_way: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacedBuilding {
    pub id: String,
    pub building_type: String,
    pub origin: Point,
    pub rotation: u16,
    pub occupied_tiles: Vec<Point>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transit_node_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitNetwork {
    pub stops: Vec<Stop>,
    pub stations: Vec<Station>,
    pub routes: Vec<Route>,
    pub metro_lines: Vec<MetroLine>,
    pub vehicles: Vec<Vehicle>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stop {
    pub id: String,
    pub kind: String,
    pub position: Point,
    pub platforms: Vec<Platform>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Station {
    pub id: String,
    pub position: Point,
    pub platforms: Vec<Platform>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Platform {
    pub id: String,
    pub label: String,
    pub capacity: u16,
    pub route_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub id: String,
    pub name: String,
    pub color: String,
    pub stop_ids: Vec<String>,
    pub vehicle_ids: Vec<String>,
    pub active: bool,
    pub segments: Vec<Vec<Point>>,
    pub path_broken: bool,
}

pub type MetroLine = Route;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vehicle {
    pub id: String,
    pub mode: String,
    pub line_id: String,
    pub capacity: u16,
    pub passenger_ids: Vec<String>,
    pub segment_index: usize,
    pub progress: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sim {
    pub id: String,
    pub home: Point,
    pub position: Point,
    pub worker_profile: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shift_template: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workplace: Option<Point>,
    pub commute_day: u32,
    pub outbound_arrived_today: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveTrip {
    pub id: String,
    pub sim_id: String,
    pub purpose: String,
    pub origin: Point,
    pub destination: Point,
    pub position: Point,
    pub status: String,
    pub deadline: f64,
    pub route_plan: Option<RoutePlan>,
    pub current_leg_index: usize,
    pub patience_remaining: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutePlan {
    pub legs: Vec<RouteLeg>,
    pub estimated_seconds: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteLeg {
    pub mode: String,
    pub from: Point,
    pub to: Point,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub late_trips: u32,
    pub completed_trips: u32,
    pub unserved_trips: u32,
    pub total_wait_seconds: f64,
    pub waiting_trip_count: u32,
    pub average_wait_seconds: f64,
    pub state: String,
    pub loss_reason: Option<String>,
}

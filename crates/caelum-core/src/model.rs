use serde::{Deserialize, Serialize};

/// How a transit leg is travelled. Serialized as the lowercase TS-parity strings
/// `walk` / `bus` / `metro` (see `tests/model_wire_format.rs`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransitMode {
    Walk,
    Bus,
    Metro,
}

/// Lifecycle state of an active trip. Serialized as the lowercase TS-parity strings
/// `idle` / `walking` / `waiting` / `riding` / `arrived` / `late` / `unserved`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TripStatus {
    Idle,
    Walking,
    Waiting,
    Riding,
    Arrived,
    Late,
    Unserved,
}

/// Why a trip exists. Serialized as the camelCase TS-parity strings
/// `commuteOutbound` / `commuteReturn`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TripPurpose {
    CommuteOutbound,
    CommuteReturn,
}

/// Overall game state. Serialized as the lowercase TS-parity strings
/// `running` / `won` / `lost`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MetricsState {
    Running,
    Won,
    Lost,
}

/// A sim's work status. Serialized as the camelCase TS-parity strings
/// `worker` / `nonWorker`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkerProfile {
    Worker,
    NonWorker,
}

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
    #[serde(default)]
    pub trip_sequence_day: u32,
    #[serde(default)]
    pub next_trip_sequence: u32,
    pub metrics: Metrics,
    /// Static scenario identity + objective thresholds. The thresholds are the
    /// authoritative source for the shell's objective copy so the TS host cannot
    /// drift from the values `objectives::evaluate_objectives` actually enforces.
    /// (Growth waves stay a TS-side concept until the core models spawning.)
    #[serde(default = "default_scenario")]
    pub scenario: ScenarioConfig,
}

/// Objective thresholds the engine enforces in `objectives::evaluate_objectives`.
/// Serialized with TS-parity camelCase names so the shell can render the exact
/// contract the Rust core evaluates against.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectiveThresholds {
    pub max_late_ratio: f64,
    pub max_unserved_ratio: f64,
    pub max_average_wait: f64,
    pub rolling_window_seconds: f64,
    pub survival_time: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioConfig {
    pub name: String,
    pub objectives: ObjectiveThresholds,
}

fn default_scenario() -> ScenarioConfig {
    crate::scenario::growing_suburb_scenario()
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
    #[serde(rename = "type")]
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

impl From<(i32, i32)> for Point {
    fn from(value: (i32, i32)) -> Self {
        Self {
            x: value.0,
            y: value.1,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TripPosition {
    pub x: f64,
    pub y: f64,
}

impl From<(i32, i32)> for TripPosition {
    fn from(value: (i32, i32)) -> Self {
        Self {
            x: f64::from(value.0),
            y: f64::from(value.1),
        }
    }
}

impl From<Point> for TripPosition {
    fn from(value: Point) -> Self {
        Self {
            x: f64::from(value.x),
            y: f64::from(value.y),
        }
    }
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetroLine {
    pub id: String,
    pub name: String,
    pub color: String,
    pub station_ids: Vec<String>,
    pub vehicle_ids: Vec<String>,
    pub active: bool,
    pub segments: Vec<Vec<Point>>,
    pub path_broken: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vehicle {
    pub id: String,
    pub mode: TransitMode,
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
    pub worker_profile: WorkerProfile,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shift_template: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workplace: Option<Point>,
    pub commute_day: u32,
    #[serde(default)]
    pub outbound_resolved_today: bool,
    #[serde(default)]
    pub outbound_arrived_today: bool,
    #[serde(default)]
    pub return_resolved_today: bool,
    #[serde(default)]
    pub returned_home_today: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveTrip {
    pub id: String,
    pub sim_id: String,
    pub purpose: TripPurpose,
    pub origin: Point,
    pub destination: Point,
    pub position: TripPosition,
    pub status: TripStatus,
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
    pub mode: TransitMode,
    pub from: Point,
    pub to: Point,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_id: Option<String>,
}

/// Terminal outcome of a completed/failed trip. Serialized as the lowercase TS-parity
/// strings `arrived` / `late` / `unserved`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TripOutcomeKind {
    Arrived,
    Late,
    Unserved,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TripOutcome {
    pub outcome: TripOutcomeKind,
    pub wait_seconds: f64,
    pub time: f64,
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
    #[serde(default)]
    pub trip_outcomes: Vec<TripOutcome>,
    pub state: MetricsState,
    pub loss_reason: Option<String>,
}

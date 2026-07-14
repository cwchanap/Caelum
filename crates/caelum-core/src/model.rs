use serde::{Deserialize, Deserializer, Serialize};

pub const SNAPSHOT_SCHEMA_VERSION: u16 = 2;

/// How a transit leg is travelled. Serialized as the lowercase TS-parity strings
/// `walk` / `bus` / `metro` (see `tests/model_wire_format.rs`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransitMode {
    Walk,
    Bus,
    Metro,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ServicePattern {
    Loop,
    Shuttle,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ServiceDirection {
    Loop,
    Outbound,
    Return,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RouteLegKind {
    Service,
    TerminalReversal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RouteLegStatus {
    Connected,
    NetworkDisconnected,
    MissingNode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransitNodeStatus {
    Present,
    Missing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BusStopKind {
    BusStop,
    BusTerminal,
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
    pub schema_version: u16,
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
    /// `growth_waves` carries scenario-authored growth; entries' `applied` flag
    /// mutates as the tick pipeline fires them (see `crate::growth`).
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
    #[serde(default)]
    pub growth_waves: Vec<GrowthWave>,
}

fn default_scenario() -> ScenarioConfig {
    crate::scenario::growing_suburb_scenario()
}

/// A batch of scheduled scenario intents applied at `trigger_time` by
/// `crate::growth::apply_due_growth_waves`. `applied` flips to `true` once the
/// wave has fired (idempotent). Serialized as the TS `Scenario.growthWaves` wire
/// shape.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrowthWave {
    pub id: String,
    pub trigger_time: f64,
    pub message: String,
    pub applied: bool,
    pub actions: Vec<GrowthAction>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Heading {
    North,
    East,
    South,
    West,
}

impl std::ops::Deref for Heading {
    type Target = str;

    fn deref(&self) -> &Self::Target {
        match self {
            Self::North => "north",
            Self::East => "east",
            Self::South => "south",
            Self::West => "west",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RoundaboutSize {
    Compact2x2,
    Standard3x3,
}

impl RoundaboutSize {
    pub(crate) fn stable_id_key(self) -> &'static str {
        match self {
            Self::Compact2x2 => "compact2x2",
            Self::Standard3x3 => "standard3x3",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadPort {
    pub id: String,
    pub point: Point,
    pub edge: Heading,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RoadStructure {
    AutomaticJunction {
        id: String,
        footprint: Vec<Point>,
        ports: Vec<RoadPort>,
    },
    Roundabout {
        id: String,
        origin: Point,
        size: RoundaboutSize,
        footprint: Vec<Point>,
        ports: Vec<RoadPort>,
    },
}

impl RoadStructure {
    pub fn id(&self) -> &str {
        match self {
            Self::AutomaticJunction { id, .. } | Self::Roundabout { id, .. } => id,
        }
    }

    pub fn footprint(&self) -> &[Point] {
        match self {
            Self::AutomaticJunction { footprint, .. } | Self::Roundabout { footprint, .. } => {
                footprint
            }
        }
    }

    pub fn ports(&self) -> &[RoadPort] {
        match self {
            Self::AutomaticJunction { ports, .. } | Self::Roundabout { ports, .. } => ports,
        }
    }

    pub fn is_automatic_junction(&self) -> bool {
        matches!(self, Self::AutomaticJunction { .. })
    }

    pub fn port_keys(&self) -> Vec<(Point, Heading)> {
        let mut keys: Vec<_> = self
            .ports()
            .iter()
            .map(|port| (port.point, port.edge))
            .collect();
        keys.sort();
        keys
    }
}

/// A single growth mutation. Mirrors the corresponding `intent::GameIntent`
/// variants and their wire spelling so a wave replays the player's own handlers.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GrowthAction {
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
pub struct GameMap {
    pub width: u8,
    pub height: u8,
    pub tiles: Vec<Tile>,
    pub road_structures: Vec<RoadStructure>,
}

impl GameMap {
    pub fn tile(&self, point: Point) -> Option<&Tile> {
        if point.x < 0
            || point.x >= i32::from(self.width)
            || point.y < 0
            || point.y >= i32::from(self.height)
        {
            return None;
        }
        self.tiles
            .iter()
            .find(|tile| tile.x == point.x && tile.y == point.y)
    }

    pub fn tile_mut(&mut self, point: Point) -> Option<&mut Tile> {
        if point.x < 0
            || point.x >= i32::from(self.width)
            || point.y < 0
            || point.y >= i32::from(self.height)
        {
            return None;
        }
        self.tiles
            .iter_mut()
            .find(|tile| tile.x == point.x && tile.y == point.y)
    }
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
    pub one_way: Option<Heading>,
    pub road_connections: Vec<Heading>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub road_structure_id: Option<String>,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MovementKind {
    Straight,
    RightTurn,
    LeftTurn,
    UTurn,
    RoundaboutEntry,
    RoundaboutCirculation,
    RoundaboutExit,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PathGeometry {
    Line {
        from: TripPosition,
        to: TripPosition,
    },
    QuadraticBezier {
        from: TripPosition,
        control: TripPosition,
        to: TripPosition,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadPathStep {
    pub position: Point,
    pub entering_heading: Heading,
    pub leaving_heading: Heading,
    pub movement: MovementKind,
    pub geometry: PathGeometry,
    pub travel_seconds: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackPathStep {
    pub position: Point,
    pub heading: Heading,
    pub geometry: PathGeometry,
    pub travel_seconds: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TransitPath {
    Road {
        steps: Vec<RoadPathStep>,
        total_travel_seconds: f64,
    },
    Track {
        steps: Vec<TrackPathStep>,
        total_travel_seconds: f64,
    },
}

pub enum TransitPathStepRef<'a> {
    Road(&'a RoadPathStep),
    Track(&'a TrackPathStep),
}

impl TransitPathStepRef<'_> {
    pub fn travel_seconds(&self) -> f64 {
        match self {
            Self::Road(step) => step.travel_seconds,
            Self::Track(step) => step.travel_seconds,
        }
    }

    pub fn accepts_heading(&self, heading: Heading) -> bool {
        match self {
            Self::Road(step) => step.entering_heading == heading || step.leaving_heading == heading,
            Self::Track(step) => step.heading == heading,
        }
    }
}

impl TransitPath {
    pub fn total_travel_seconds(&self) -> f64 {
        match self {
            Self::Road {
                total_travel_seconds,
                ..
            }
            | Self::Track {
                total_travel_seconds,
                ..
            } => *total_travel_seconds,
        }
    }

    pub fn step_count(&self) -> usize {
        match self {
            Self::Road { steps, .. } => steps.len(),
            Self::Track { steps, .. } => steps.len(),
        }
    }

    pub fn step(&self, index: usize) -> Option<TransitPathStepRef<'_>> {
        match self {
            Self::Road { steps, .. } => steps.get(index).map(TransitPathStepRef::Road),
            Self::Track { steps, .. } => steps.get(index).map(TransitPathStepRef::Track),
        }
    }

    pub fn step_refs(&self) -> Vec<TransitPathStepRef<'_>> {
        (0..self.step_count())
            .filter_map(|index| self.step(index))
            .collect()
    }

    pub fn road_steps(&self) -> &[RoadPathStep] {
        match self {
            Self::Road { steps, .. } => steps,
            Self::Track { .. } => &[],
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteLegPath {
    pub from_waypoint_id: String,
    pub to_waypoint_id: String,
    pub direction: ServiceDirection,
    pub kind: RouteLegKind,
    pub status: RouteLegStatus,
    pub current_path: Option<TransitPath>,
    pub last_valid_path: Option<TransitPath>,
    pub estimated_seconds: Option<f64>,
}

impl RouteLegPath {
    pub fn key(&self) -> (&str, &str, ServiceDirection, RouteLegKind) {
        (
            &self.from_waypoint_id,
            &self.to_waypoint_id,
            self.direction,
            self.kind,
        )
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
    pub kind: BusStopKind,
    pub status: TransitNodeStatus,
    pub position: Point,
    pub platforms: Vec<Platform>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Station {
    pub id: String,
    pub status: TransitNodeStatus,
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
    pub pattern: ServicePattern,
    pub revision: u32,
    pub legs: Vec<RouteLegPath>,
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
    pub pattern: ServicePattern,
    pub revision: u32,
    pub legs: Vec<RouteLegPath>,
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
    pub itinerary_index: usize,
    pub path_step_index: usize,
    pub step_progress: f64,
    pub parked_position: Option<TripPosition>,
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
    #[serde(deserialize_with = "deserialize_required_option")]
    pub service_direction: Option<ServiceDirection>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub board_itinerary_index: Option<usize>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub alight_itinerary_index: Option<usize>,
}

fn deserialize_required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
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

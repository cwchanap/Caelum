use serde::{Deserialize, Deserializer, Serialize};

pub const SNAPSHOT_SCHEMA_VERSION: u16 = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GameMode {
    Sandbox,
    Campaign,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EconomyPreset {
    Standard,
    Creative,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SandboxTemplateId {
    BlankGrid,
    Crossroads,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MoveInRateSelection {
    Paused,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "f64", into = "f64")]
pub struct DemandMultiplier(f64);

impl DemandMultiplier {
    pub fn new(value: f64) -> Result<Self, &'static str> {
        Self::try_from(value)
    }

    pub fn value(self) -> f64 {
        self.0
    }
}

impl Default for DemandMultiplier {
    fn default() -> Self {
        Self(1.0)
    }
}

impl TryFrom<f64> for DemandMultiplier {
    type Error = &'static str;

    fn try_from(value: f64) -> Result<Self, Self::Error> {
        if value.is_finite() && value > 0.0 {
            Ok(Self(value))
        } else {
            Err("demand multiplier must be finite and greater than zero")
        }
    }
}

impl From<DemandMultiplier> for f64 {
    fn from(value: DemandMultiplier) -> Self {
        value.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "i32", into = "i32")]
pub struct StartingCapital(i32);

impl StartingCapital {
    pub fn new(value: i32) -> Result<Self, &'static str> {
        Self::try_from(value)
    }

    pub fn value(self) -> i32 {
        self.0
    }
}

impl TryFrom<i32> for StartingCapital {
    type Error = &'static str;

    fn try_from(value: i32) -> Result<Self, Self::Error> {
        if value >= 0 {
            Ok(Self(value))
        } else {
            Err("starting capital must be non-negative")
        }
    }
}

impl From<StartingCapital> for i32 {
    fn from(value: StartingCapital) -> Self {
        value.0
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxSettings {
    pub template_id: SandboxTemplateId,
    pub starting_capital: StartingCapital,
    pub demand_multiplier: DemandMultiplier,
    pub move_in_rate: MoveInRateSelection,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameRules {
    pub game_mode: GameMode,
    pub economy_preset: EconomyPreset,
    pub sandbox: SandboxSettings,
}

/// How a transit leg is travelled. Serialized as the lowercase TS-parity strings
/// `walk` / `bus` / `metro` (see `tests/model_wire_format.rs`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransitMode {
    Walk,
    Bus,
    Metro,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ServicePattern {
    #[default]
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
pub enum LegFailureReason {
    NoRoadAccess,
    NetworkDisconnected,
    NoLegalEntryHeading,
    NoLegalExitHeading,
    NoLegalTurnaround,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransitNodeStatus {
    #[default]
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
    pub rules: GameRules,
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
    /// Static scenario identity plus optional campaign objectives.
    /// `growth_waves` carries scenario-authored growth; entries' `applied` flag
    /// mutates as the tick pipeline fires them (see `crate::growth`).
    pub scenario: ScenarioConfig,
}

/// Minimal view of a snapshot used to probe `schemaVersion` BEFORE attempting a
/// full `GameSnapshot` deserialization. Hosts deserialize into this first
/// (serde ignores the unknown remaining fields), compare against
/// [`SNAPSHOT_SCHEMA_VERSION`], and reject with
/// [`crate::persistence::PersistenceError::UnsupportedSchema`] on mismatch —
/// so a legacy schema-v3 save that lacks the required v4
/// `rules.sandbox.startingCapital` field gets a typed persistence error instead
/// of a generic missing-field serde error from the full deserialize.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotSchemaProbe {
    pub schema_version: u16,
}

/// Generates a validated `f64` newtype for an `ObjectiveThresholds` field,
/// following the `DemandMultiplier` pattern: `#[serde(try_from = "f64", into = "f64")]`
/// keeps the wire shape a plain JSON number while `TryFrom<f64>` rejects
/// non-finite or predicate-invalid values at deserialization. Bad campaign
/// authoring therefore fails loudly at load instead of being silently coerced
/// at evaluation time. The `validate` argument is a closure receiving the
/// candidate `f64` (already known finite) and returning whether it satisfies
/// the field's predicate.
macro_rules! validated_threshold_newtype {
    (
        $(#[$meta:meta])*
        $name:ident,
        $error:literal,
        validate = $validate:expr,
    ) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
        #[serde(try_from = "f64", into = "f64")]
        pub struct $name(f64);

        impl $name {
            pub fn new(value: f64) -> Result<Self, &'static str> {
                Self::try_from(value)
            }

            pub fn value(self) -> f64 {
                self.0
            }
        }

        impl TryFrom<f64> for $name {
            type Error = &'static str;

            fn try_from(value: f64) -> Result<Self, Self::Error> {
                if value.is_finite() && ($validate)(value) {
                    Ok(Self(value))
                } else {
                    Err($error)
                }
            }
        }

        impl From<$name> for f64 {
            fn from(value: $name) -> Self {
                value.0
            }
        }
    };
}

validated_threshold_newtype!(
    /// Maximum fraction of completed trips that may arrive late before the
    /// campaign fails. A ratio of `0.0` means zero tolerance; values above `1.0`
    /// effectively disable the gate (late trips can never exceed completed trips).
    MaxLateRatio,
    "max late ratio must be finite and non-negative",
    validate = |value| value >= 0.0,
);

validated_threshold_newtype!(
    /// Maximum fraction of total trips that may go unserved before the campaign
    /// fails. Same range semantics as [`MaxLateRatio`].
    MaxUnservedRatio,
    "max unserved ratio must be finite and non-negative",
    validate = |value| value >= 0.0,
);

validated_threshold_newtype!(
    /// Maximum average wait time (seconds) across waiting trips before the
    /// campaign fails. `0.0` means zero tolerance.
    MaxAverageWaitSeconds,
    "max average wait seconds must be finite and non-negative",
    validate = |value| value >= 0.0,
);

validated_threshold_newtype!(
    /// Rolling evaluation window (seconds) for late/unserved trip scoring. Must
    /// be strictly positive; a zero or negative window is nonsensical.
    RollingWindowSeconds,
    "rolling window seconds must be finite and positive",
    validate = |value| value > 0.0,
);

validated_threshold_newtype!(
    /// Survival time (seconds) the campaign must be held before the win gate
    /// fires. Must be strictly positive.
    SurvivalTimeSeconds,
    "survival time seconds must be finite and positive",
    validate = |value| value > 0.0,
);

/// Objective thresholds the engine enforces in `objectives::evaluate_objectives`.
/// Serialized with TS-parity camelCase names so the shell can render the exact
/// contract the Rust core evaluates against. Each field is a validated newtype
/// (see [`validated_threshold_newtype`]); invalid values are rejected at
/// deserialization rather than silently coerced at evaluation time.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectiveThresholds {
    pub max_late_ratio: MaxLateRatio,
    pub max_unserved_ratio: MaxUnservedRatio,
    pub max_average_wait: MaxAverageWaitSeconds,
    pub rolling_window_seconds: RollingWindowSeconds,
    pub survival_time: SurvivalTimeSeconds,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioConfig {
    pub name: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub objectives: Option<ObjectiveThresholds>,
    pub growth_waves: Vec<GrowthWave>,
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

impl Heading {
    /// Lowercase canonical name used in wire/preview keys and assertions.
    pub fn as_str(&self) -> &'static str {
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PortDirection {
    TwoWay,
    Inbound,
    Outbound,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadPort {
    pub id: String,
    pub point: Point,
    pub edge: Heading,
    /// One-way direction of the external neighbor at capture time. `None` for
    /// template slots and ports that have not been validated against an
    /// external tile; consumers fall back to geometry-based acceptance.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub direction: Option<PortDirection>,
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
    fn tile_index(&self, point: Point) -> Option<usize> {
        if point.x < 0
            || point.x >= i32::from(self.width)
            || point.y < 0
            || point.y >= i32::from(self.height)
        {
            return None;
        }
        Some(point.y as usize * usize::from(self.width) + point.x as usize)
    }

    pub fn tile(&self, point: Point) -> Option<&Tile> {
        let index = self.tile_index(point)?;
        if let Some(tile) = self.tiles.get(index) {
            if tile.x == point.x && tile.y == point.y {
                return Some(tile);
            }
        }
        self.tiles
            .iter()
            .find(|tile| tile.x == point.x && tile.y == point.y)
    }

    pub fn tile_mut(&mut self, point: Point) -> Option<&mut Tile> {
        let index = self.tile_index(point)?;
        let indexed_matches = self
            .tiles
            .get(index)
            .is_some_and(|tile| tile.x == point.x && tile.y == point.y);
        if indexed_matches {
            self.tiles.get_mut(index)
        } else {
            self.tiles
                .iter_mut()
                .find(|tile| tile.x == point.x && tile.y == point.y)
        }
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
    #[serde(default)]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<LegFailureReason>,
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
    #[serde(default)]
    pub status: TransitNodeStatus,
    pub position: Point,
    pub platforms: Vec<Platform>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub road_access: Option<StopRoadAccess>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopRoadAccess {
    pub road_point: Point,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_heading: Option<Heading>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Station {
    pub id: String,
    #[serde(default)]
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
    #[serde(default)]
    pub pattern: ServicePattern,
    #[serde(default)]
    pub revision: u32,
    #[serde(default)]
    pub legs: Vec<RouteLegPath>,
    #[serde(default)]
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
    #[serde(default)]
    pub pattern: ServicePattern,
    #[serde(default)]
    pub revision: u32,
    #[serde(default)]
    pub legs: Vec<RouteLegPath>,
    #[serde(default)]
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

use serde::{Deserialize, Serialize};

use crate::model::{Heading, Point};

pub type PersistenceResult<T> = Result<T, PersistenceError>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "code",
    content = "context",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PersistenceError {
    UnsupportedSchema {
        expected: u16,
        actual: u16,
    },
    InvalidNumericValue {
        #[serde(skip_serializing_if = "Option::is_none")]
        entity: Option<EntityRef>,
        field: SnapshotField,
        reason: NumericError,
    },
    InvalidModeSettings {
        field: SnapshotField,
        reason: ModeError,
    },
    InvalidScenario {
        field: SnapshotField,
        reason: ScenarioError,
    },
    InvalidMapDimensions {
        expected: MapSize,
        actual: MapSize,
    },
    InvalidTile {
        tile_id: String,
        reason: TileError,
    },
    InvalidRoadStructure {
        structure_id: String,
        reason: RoadStructureError,
    },
    DuplicateEntityId {
        id: String,
        first_kind: EntityKind,
        second_kind: EntityKind,
    },
    InvalidEntity {
        entity: EntityRef,
        field: SnapshotField,
        reason: EntityError,
    },
    DanglingReference {
        source: EntityRef,
        field: SnapshotField,
        target: EntityRef,
    },
    InvalidOwnership {
        owner: EntityRef,
        owned: EntityRef,
        reason: OwnershipError,
    },
    InvalidAssignment {
        entity: EntityRef,
        reason: AssignmentError,
    },
    InvalidDerivedState {
        field: SnapshotField,
        reason: DerivedStateError,
    },
    InvalidRoadTopology {
        reason: RoadTopologyError,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EntityKind {
    Building,
    Sim,
    ActiveTrip,
    Stop,
    Station,
    Platform,
    BusRoute,
    MetroLine,
    Vehicle,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityRef {
    pub kind: EntityKind,
    pub id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MapSize {
    pub width: u8,
    pub height: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SnapshotField {
    Time,
    Day,
    ClockMinutes,
    Speed,
    Paused,
    Budget,
    GameMode,
    EconomyPreset,
    SandboxTemplateId,
    StartingCapital,
    DemandMultiplier,
    ScenarioObjectives,
    ScenarioGrowthWaves,
    ObjectiveThresholds,
    GrowthWaveId,
    GrowthWaveTriggerTime,
    GrowthWaveActions,
    MapWidth,
    MapHeight,
    TileCount,
    TileCoordinates,
    TileId,
    TileKind,
    TileArea,
    TileRoadConnections,
    TileOneWay,
    TileRoadStructureId,
    EntityId,
    BuildingOrigin,
    BuildingRotation,
    BuildingOccupiedTiles,
    BuildingTransitNodeId,
    NodeKind,
    NodeStatus,
    NodeAnchor,
    NodeRoadAccess,
    PlatformLabel,
    PlatformCapacity,
    PlatformCount,
    PlatformOrder,
    PlatformRouteIds,
    RoutePattern,
    RouteWaypointIds,
    RouteLegs,
    RouteEstimatedSeconds,
    RoutePathBroken,
    RouteRevision,
    RouteVehicleIds,
    VehicleMode,
    VehicleLineId,
    VehicleCapacity,
    VehiclePassengerIds,
    VehicleItineraryIndex,
    VehiclePathStepIndex,
    VehicleStepProgress,
    VehicleParkedPosition,
    SimHome,
    SimPosition,
    SimWorkerProfile,
    SimShiftTemplate,
    SimWorkplace,
    SimCommuteDay,
    SimDailyFlags,
    TripServiceDay,
    TripPurpose,
    TripStatus,
    TripOrigin,
    TripDestination,
    TripPosition,
    TripDeadline,
    TripPatience,
    TripRoutePlan,
    TripEstimatedSeconds,
    TripCurrentLegIndex,
    TripSequenceDay,
    NextTripSequence,
    MetricsCounters,
    MetricsWaits,
    MetricsTripOutcomes,
    OutcomeWaitSeconds,
    OutcomeTimestamp,
    MetricsState,
    MetricsLossReason,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "details",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum NumericError {
    NotFinite,
    Negative,
    OutOfRange {
        minimum: f64,
        maximum: f64,
        actual: f64,
    },
    Overflow,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "details",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ModeError {
    PersistenceRequiresPaused,
    UnsupportedSpeed,
    InvalidEconomyForMode,
    SandboxObjectivesPresent,
    SandboxGrowthWavesPresent,
    SandboxTerminalState,
    CampaignTerminalWithoutObjectives,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "details",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ScenarioError {
    DuplicateGrowthWaveId {
        wave_id: String,
    },
    TriggerTimesOutOfOrder {
        previous_wave_id: String,
        wave_id: String,
    },
    AppliedAfterUnapplied {
        first_unapplied_wave_id: String,
        later_applied_wave_id: String,
    },
    ActionOutOfBounds {
        wave_id: String,
        action_index: u32,
        point: Point,
    },
    UnknownBuildingType {
        wave_id: String,
        action_index: u32,
    },
    InvalidBuildingRotation {
        wave_id: String,
        action_index: u32,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "details",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TileError {
    WrongRowMajorCoordinate { expected: Point, actual: Point },
    NonCanonicalId { expected: String },
    UnsupportedKind,
    UnsupportedArea,
    NonRoadHasRoadState,
    DuplicateRoadConnection,
    NonCanonicalRoadConnectionOrder,
    ConnectionOutOfBounds { heading: Heading },
    ConnectionToNonRoad { neighbor: Point },
    NonReciprocalConnection { neighbor: Point },
    InvalidOneWayAxis,
    InvalidInfrastructureCoexistence,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "details",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RoadStructureError {
    NonCanonicalId,
    EmptyFootprint,
    DuplicateFootprintPoint,
    OverlappingFootprint,
    NonRoadFootprintTile,
    TileOwnerMismatch,
    DanglingTileOwner,
    DuplicatePortId,
    InvalidBoundaryPort,
    NonCanonicalFootprint,
    NonCanonicalLaneFacts,
    NonCanonicalMovementFacts,
    AutomaticJunctionMismatch,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "details",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum EntityError {
    EmptyId,
    NonCanonicalId,
    InvalidStaticShape,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "details",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum OwnershipError {
    MissingOwner,
    MultipleOwners,
    OwnerTypeMismatch,
    FootprintMismatch,
    AnchorMismatch,
    ReciprocalLinkMissing,
    SpatialOverlap,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "details",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AssignmentError {
    DuplicateAssignment,
    ModeMismatch,
    WaypointMissing,
    PlatformMismatch,
    VehicleMissingFromLine,
    VehicleListedByMultipleLines,
    PassengerNotRiding,
    PassengerInMultipleVehicles,
    ItineraryIndexOutOfBounds,
    PathStepIndexOutOfBounds,
    ProgressOutOfRange,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "details",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DerivedStateError {
    ClockMismatch,
    StopAccessMismatch { node: EntityRef },
    RouteLegMismatch { route: EntityRef },
    RoutePathBrokenMismatch { route: EntityRef },
    RouteOracleNotIdempotent { route: EntityRef },
    TripStateMismatch { trip: EntityRef },
    TripPositionMismatch { trip: EntityRef },
    TripCounterMismatch,
    MetricsRelationshipMismatch,
    OutcomeWindowMismatch,
    ObjectiveStateMismatch,
    LossReasonMismatch,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "details",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RoadTopologyError {
    UnsafeRoundaboutPortMapping {
        structure_id: String,
        footprint: Vec<Point>,
    },
}

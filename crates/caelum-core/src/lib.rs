// `GameplayResult<T>` is an intentionally unboxed public contract: both hosts
// serialize `GameplayRejection` directly, so boxing it only to reduce the Rust
// enum's stack size would make the authoritative mutation API less direct.
#![allow(clippy::result_large_err)]

//! Authoritative simulation core for Caelum.
//!
//! This crate owns the tick pipeline, transit routing, the trip/commute lifecycle,
//! objectives, and metrics. It is independent of Svelte and Tauri and is intended to
//! become the live runtime once the WASM/Tauri adapters wire [`engine::GameEngine`]
//! into the frontend, at which point it also serves as the parity oracle for the
//! legacy TypeScript simulation under `src/simulation/`.
//!
//! The engine runs one tick as a fixed pipeline over an immutable [`model::GameSnapshot`]:
//! [`trips::tick_trips`] (spawn + advance trips, tick vehicles) →
//! [`objectives::evaluate_objectives`] (metrics + win/loss). Each step takes a snapshot
//! and returns a new one; the engine publishes a new snapshot only when it differs from
//! the previous one (see [`engine::GameEngine::tick`]).
//!
//! Determinism is a contract: no RNG, no wall-clock time, a fixed N-E-S-W BFS tiebreak,
//! and stable id/jitter derivation (see [`commute`] and [`ids`]).

pub mod areas;
pub mod building_catalog;
pub mod buildings;
pub mod clock;
pub mod commute;
pub mod engine;
pub mod growth;
pub mod heading;
pub mod ids;
pub mod intent;
pub mod model;
pub mod network;
pub mod objectives;
pub mod platforms;
pub mod preview;
pub mod rejection;
pub mod road;
pub mod road_topology;
pub mod roundabouts;
pub mod route_editor;
pub mod route_lifecycle;
pub mod router;
pub mod scenario;
pub mod service_itinerary;
pub mod state;
pub(crate) mod stop_access;
pub mod transit;
pub mod transit_nodes;
pub mod trips;

pub use engine::{GameEngine, RoutingContext};
pub use intent::{DispatchContext, DispatchResult, GameIntent, RoadPreset};
pub use model::{
    GameSnapshot, LegFailureReason, SnapshotSchemaProbe, StopRoadAccess, SNAPSHOT_SCHEMA_VERSION,
};
pub use preview::{
    AuthoredRoadTilePreview, GameplayWarning, RoadMutationPreviewRequest,
    RoadMutationPreviewResponse, RouteImpact, RouteImpactKind, RoutePreviewRequest,
    RoutePreviewResponse, TurnSummary, WarningCode,
};
pub use rejection::{GameplayRejection, GameplayResult, RejectionCode, RejectionContext};
pub use route_lifecycle::{project_position_onto_path, PathProjection};

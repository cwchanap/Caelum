use serde::{Deserialize, Serialize};

use crate::model::Point;

pub type GameplayResult<T> = Result<T, GameplayRejection>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RejectionCode {
    InsufficientBudget,
    InvalidSpeed,
    BlockedTile,
    OutOfBounds,
    RoadRequired,
    NoRoadAccess,
    TrackRequired,
    InvalidRoadStroke,
    InvalidTrackStroke,
    InvalidDirectionChange,
    NodeAlreadyExists,
    AmbiguousTransitNode,
    MissingRouteNode,
    IncompatibleRouteNode,
    TooFewRouteNodes,
    DuplicateRouteNodes,
    DisconnectedLeg,
    RouteChangedWhileEditing,
    RouteRevisionExhausted,
    RouteNotFound,
    InactiveRoute,
    StructureNotFound,
    InvalidPlatform,
    InvalidBuildingPlacement,
    BlockedFootprint,
    UnsafeRoundaboutPortMapping,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectionContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub structure_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_waypoint_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_waypoint_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub point: Option<Point>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub footprint: Vec<Point>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_revision: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_budget: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_budget: Option<i32>,
    #[serde(default)]
    pub affected_route_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameplayRejection {
    pub code: RejectionCode,
    pub context: RejectionContext,
}

impl GameplayRejection {
    pub fn new(code: RejectionCode) -> Self {
        Self {
            code,
            context: RejectionContext::default(),
        }
    }

    pub fn at(code: RejectionCode, point: Point) -> Self {
        Self {
            code,
            context: RejectionContext {
                point: Some(point),
                ..RejectionContext::default()
            },
        }
    }

    pub fn budget(required: i32, available: i32) -> Self {
        Self {
            code: RejectionCode::InsufficientBudget,
            context: RejectionContext {
                required_budget: Some(required),
                available_budget: Some(available),
                ..RejectionContext::default()
            },
        }
    }

    pub fn route_revision_exhausted(route_id: &str, actual_revision: u32) -> Self {
        Self {
            code: RejectionCode::RouteRevisionExhausted,
            context: RejectionContext {
                route_id: Some(route_id.to_string()),
                actual_revision: Some(actual_revision),
                ..RejectionContext::default()
            },
        }
    }
}

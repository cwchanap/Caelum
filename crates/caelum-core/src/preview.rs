use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::engine::{dispatch_context, RoutingContext};
use crate::model::{
    GameSnapshot, Heading, MovementKind, Point, RoadStructure, RouteLegPath, RouteLegStatus,
    ServicePattern, TransitMode,
};
use crate::network::resolve_route_legs;
use crate::rejection::{GameplayRejection, RejectionCode, RejectionContext};
use crate::road::{self, RoadMutation, RoadMutationResult};
use crate::road_topology::RoadTopology;
use crate::transit::{self, BUS_COST, METRO_COST};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutePreviewRequest {
    pub mode: TransitMode,
    pub pattern: ServicePattern,
    pub waypoint_ids: Vec<String>,
    pub route_id: Option<String>,
    pub expected_revision: Option<u32>,
    pub generation: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnSummary {
    pub straight: u32,
    pub right_turn: u32,
    pub left_turn: u32,
    pub u_turn: u32,
    pub roundabout_entry: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WarningCode {
    SkippedTiles,
    ExistingBrokenLeg,
    RouteWillReroute,
    RouteWillBreak,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameplayWarning {
    pub code: WarningCode,
    pub context: RejectionContext,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutePreviewResponse {
    pub generation: u64,
    pub legs: Vec<RouteLegPath>,
    pub total_travel_seconds: f64,
    pub initial_vehicle_cost: i32,
    pub affordable: bool,
    pub turn_summary: TurnSummary,
    pub missing_waypoint_ids: Vec<String>,
    pub warnings: Vec<GameplayWarning>,
    pub rejection: Option<GameplayRejection>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadMutationPreviewRequest {
    pub mutation: RoadMutation,
    pub generation: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RouteImpactKind {
    Rerouted,
    Broken,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteImpact {
    pub route_id: String,
    pub kind: RouteImpactKind,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthoredRoadTilePreview {
    pub point: Point,
    pub one_way: Option<Heading>,
    pub road_connections: Vec<Heading>,
    pub road_structure_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadMutationPreviewResponse {
    pub generation: u64,
    pub changed_tiles: Vec<Point>,
    pub authored_tiles: Vec<AuthoredRoadTilePreview>,
    pub generated_structures: Vec<RoadStructure>,
    pub cost: i32,
    pub skipped_tiles: Vec<Point>,
    pub route_impacts: Vec<RouteImpact>,
    pub warnings: Vec<GameplayWarning>,
    pub rejection: Option<GameplayRejection>,
}

#[derive(Clone, Copy)]
struct ExistingRoute<'a> {
    id: &'a str,
    revision: u32,
    legs: &'a [RouteLegPath],
}

pub fn preview_route(
    snapshot: &GameSnapshot,
    context: RoutingContext<'_>,
    request: RoutePreviewRequest,
) -> RoutePreviewResponse {
    let initial_vehicle_cost = if request.route_id.is_none() {
        vehicle_cost(request.mode)
    } else {
        0
    };
    let affordable = request.route_id.is_some() || snapshot.budget >= initial_vehicle_cost;
    let missing_waypoint_ids = missing_waypoint_ids(snapshot, &request);
    let mut response = RoutePreviewResponse {
        generation: request.generation,
        legs: Vec::new(),
        total_travel_seconds: 0.0,
        initial_vehicle_cost,
        affordable,
        turn_summary: TurnSummary::default(),
        missing_waypoint_ids,
        warnings: Vec::new(),
        rejection: None,
    };

    let existing = match existing_route(snapshot, &request) {
        Ok(existing) => existing,
        Err(rejection) => {
            response.rejection = Some(rejection);
            return response;
        }
    };
    if let (Some(existing), Some(expected_revision)) = (&existing, request.expected_revision) {
        if existing.revision != expected_revision {
            response.rejection = Some(GameplayRejection {
                code: RejectionCode::RouteChangedWhileEditing,
                context: RejectionContext {
                    route_id: Some(existing.id.to_string()),
                    expected_revision: Some(expected_revision),
                    actual_revision: Some(existing.revision),
                    ..RejectionContext::default()
                },
            });
            return response;
        }
    }

    if let Some(rejection) = validate_waypoints(snapshot, &request) {
        response.rejection = Some(rejection);
        return response;
    }

    response.legs = resolve_route_legs(
        snapshot,
        context,
        request.mode,
        &request.waypoint_ids,
        request.pattern,
    );
    if let Some(existing) = existing {
        seed_edit_preview_history(existing.legs, &mut response.legs);
    }

    for leg in &response.legs {
        if leg.status == RouteLegStatus::Connected {
            continue;
        }
        let existing_broken = existing.is_some_and(|route| {
            route
                .legs
                .iter()
                .find(|old| old.key() == leg.key())
                .is_some_and(|old| old.status != RouteLegStatus::Connected)
        });
        let context = RejectionContext {
            route_id: request.route_id.clone(),
            from_waypoint_id: Some(leg.from_waypoint_id.clone()),
            to_waypoint_id: Some(leg.to_waypoint_id.clone()),
            ..RejectionContext::default()
        };
        if existing_broken {
            response.warnings.push(GameplayWarning {
                code: WarningCode::ExistingBrokenLeg,
                context,
            });
        } else {
            response.rejection = Some(GameplayRejection {
                code: RejectionCode::DisconnectedLeg,
                context,
            });
            break;
        }
    }

    response.total_travel_seconds = response
        .legs
        .iter()
        .filter_map(|leg| leg.estimated_seconds)
        .sum();
    response.turn_summary = summarize_turns(&response.legs);

    if response.rejection.is_none() && !affordable {
        let mut rejection = GameplayRejection::budget(initial_vehicle_cost, snapshot.budget);
        rejection.context.expected_revision = request.expected_revision;
        response.rejection = Some(rejection);
    }
    response
}

pub fn preview_road_mutation(
    snapshot: &GameSnapshot,
    current_topology: &RoadTopology,
    request: RoadMutationPreviewRequest,
) -> RoadMutationPreviewResponse {
    let generation = request.generation;
    let candidate = match preview_network_candidate(snapshot, &request.mutation) {
        Ok(candidate) => candidate,
        Err(rejection) => return rejected_road_preview(generation, rejection),
    };
    let topology = match RoadTopology::compile(&candidate.snapshot.map) {
        Ok(topology) => topology,
        Err(rejection) => return rejected_road_preview(generation, rejection),
    };
    let authored_tiles = candidate
        .changed_tiles
        .iter()
        .filter_map(|point| {
            candidate
                .snapshot
                .map
                .tile(*point)
                .map(|tile| AuthoredRoadTilePreview {
                    point: *point,
                    one_way: tile.one_way,
                    road_connections: preview_road_connections(&tile.road_connections),
                    road_structure_id: tile.road_structure_id.clone(),
                })
        })
        .collect();
    let generated_structures = candidate
        .snapshot
        .map
        .road_structures
        .iter()
        .filter(|structure| !snapshot.map.road_structures.contains(structure))
        .cloned()
        .collect();
    let route_impacts = route_impacts(snapshot, current_topology, &candidate.snapshot, &topology);
    let mut warnings = Vec::new();
    if !candidate.skipped_tiles.is_empty() {
        warnings.push(GameplayWarning {
            code: WarningCode::SkippedTiles,
            context: RejectionContext {
                footprint: candidate.skipped_tiles.clone(),
                ..RejectionContext::default()
            },
        });
    }
    warnings.extend(route_impacts.iter().map(|impact| GameplayWarning {
        code: match impact.kind {
            RouteImpactKind::Rerouted => WarningCode::RouteWillReroute,
            RouteImpactKind::Broken => WarningCode::RouteWillBreak,
        },
        context: RejectionContext {
            route_id: Some(impact.route_id.clone()),
            affected_route_ids: vec![impact.route_id.clone()],
            ..RejectionContext::default()
        },
    }));

    RoadMutationPreviewResponse {
        generation,
        changed_tiles: candidate.changed_tiles,
        authored_tiles,
        generated_structures,
        cost: candidate.cost,
        skipped_tiles: candidate.skipped_tiles,
        route_impacts,
        warnings,
        rejection: None,
    }
}

fn vehicle_cost(mode: TransitMode) -> i32 {
    match mode {
        TransitMode::Bus => BUS_COST,
        TransitMode::Metro => METRO_COST,
        TransitMode::Walk => 0,
    }
}

fn preview_road_connections(connections: &[Heading]) -> Vec<Heading> {
    if connections == [Heading::East, Heading::West] {
        return vec![Heading::West, Heading::East];
    }
    connections.to_vec()
}

fn existing_route<'a>(
    snapshot: &'a GameSnapshot,
    request: &RoutePreviewRequest,
) -> Result<Option<ExistingRoute<'a>>, GameplayRejection> {
    let Some(route_id) = request.route_id.as_deref() else {
        return Ok(None);
    };
    let existing = match request.mode {
        TransitMode::Bus => snapshot
            .transit
            .routes
            .iter()
            .find(|route| route.id == route_id)
            .map(|route| ExistingRoute {
                id: &route.id,
                revision: route.revision,
                legs: &route.legs,
            }),
        TransitMode::Metro => snapshot
            .transit
            .metro_lines
            .iter()
            .find(|line| line.id == route_id)
            .map(|line| ExistingRoute {
                id: &line.id,
                revision: line.revision,
                legs: &line.legs,
            }),
        TransitMode::Walk => None,
    };
    existing.map(Some).ok_or_else(|| GameplayRejection {
        code: RejectionCode::RouteNotFound,
        context: RejectionContext {
            route_id: Some(route_id.to_string()),
            expected_revision: request.expected_revision,
            ..RejectionContext::default()
        },
    })
}

fn validate_waypoints(
    snapshot: &GameSnapshot,
    request: &RoutePreviewRequest,
) -> Option<GameplayRejection> {
    if request.mode == TransitMode::Walk {
        return Some(GameplayRejection::new(RejectionCode::IncompatibleRouteNode));
    }
    if request.waypoint_ids.len() < 2 {
        return Some(route_validation_rejection(
            RejectionCode::TooFewRouteNodes,
            request,
            request.waypoint_ids.first(),
        ));
    }
    let mut seen = HashSet::new();
    if let Some(duplicate) = request
        .waypoint_ids
        .iter()
        .find(|waypoint_id| !seen.insert(waypoint_id.as_str()))
    {
        return Some(route_validation_rejection(
            RejectionCode::DuplicateRouteNodes,
            request,
            Some(duplicate),
        ));
    }
    for waypoint_id in &request.waypoint_ids {
        let compatible = match request.mode {
            TransitMode::Bus => snapshot
                .transit
                .stops
                .iter()
                .any(|stop| stop.id == *waypoint_id),
            TransitMode::Metro => snapshot
                .transit
                .stations
                .iter()
                .any(|station| station.id == *waypoint_id),
            TransitMode::Walk => false,
        };
        if compatible {
            continue;
        }
        let incompatible = snapshot
            .transit
            .stops
            .iter()
            .any(|stop| stop.id == *waypoint_id)
            || snapshot
                .transit
                .stations
                .iter()
                .any(|station| station.id == *waypoint_id);
        return Some(route_validation_rejection(
            if incompatible {
                RejectionCode::IncompatibleRouteNode
            } else {
                RejectionCode::MissingRouteNode
            },
            request,
            Some(waypoint_id),
        ));
    }
    None
}

fn route_validation_rejection(
    code: RejectionCode,
    request: &RoutePreviewRequest,
    node_id: Option<&String>,
) -> GameplayRejection {
    GameplayRejection {
        code,
        context: RejectionContext {
            route_id: request.route_id.clone(),
            node_id: node_id.cloned(),
            expected_revision: request.expected_revision,
            ..RejectionContext::default()
        },
    }
}

fn missing_waypoint_ids(snapshot: &GameSnapshot, request: &RoutePreviewRequest) -> Vec<String> {
    request
        .waypoint_ids
        .iter()
        .filter(|waypoint_id| {
            !snapshot
                .transit
                .stops
                .iter()
                .any(|stop| stop.id == waypoint_id.as_str())
                && !snapshot
                    .transit
                    .stations
                    .iter()
                    .any(|station| station.id == waypoint_id.as_str())
        })
        .cloned()
        .collect()
}

fn seed_edit_preview_history(old_legs: &[RouteLegPath], preview_legs: &mut [RouteLegPath]) {
    for leg in preview_legs {
        if leg.status == RouteLegStatus::Connected {
            leg.last_valid_path = leg.current_path.clone();
            continue;
        }
        leg.last_valid_path = old_legs
            .iter()
            .find(|old| {
                old.from_waypoint_id == leg.from_waypoint_id
                    && old.to_waypoint_id == leg.to_waypoint_id
                    && old.direction == leg.direction
            })
            .and_then(|old| old.last_valid_path.clone());
    }
}

fn summarize_turns(legs: &[RouteLegPath]) -> TurnSummary {
    let mut summary = TurnSummary::default();
    for movement in legs
        .iter()
        .filter_map(|leg| leg.current_path.as_ref())
        .flat_map(|path| path.road_steps())
        .map(|step| step.movement)
    {
        match movement {
            MovementKind::Straight => summary.straight += 1,
            MovementKind::RightTurn => summary.right_turn += 1,
            MovementKind::LeftTurn => summary.left_turn += 1,
            MovementKind::UTurn => summary.u_turn += 1,
            MovementKind::RoundaboutEntry => summary.roundabout_entry += 1,
            MovementKind::RoundaboutCirculation | MovementKind::RoundaboutExit => {}
        }
    }
    summary
}

fn preview_network_candidate(
    snapshot: &GameSnapshot,
    mutation: &RoadMutation,
) -> Result<RoadMutationResult, GameplayRejection> {
    match mutation {
        RoadMutation::RemoveAtTile { point } => {
            let candidate = transit::remove_at_tile(snapshot, point)?;
            let context = dispatch_context(snapshot, &candidate, &[*point]);
            Ok(RoadMutationResult {
                snapshot: candidate,
                changed_tiles: context.changed_tiles,
                skipped_tiles: context.skipped_tiles,
                cost: context.cost,
            })
        }
        RoadMutation::RemoveAtTiles { points } => {
            let candidate = transit::remove_at_tiles(snapshot, points)?;
            let context = dispatch_context(snapshot, &candidate, points);
            Ok(RoadMutationResult {
                snapshot: candidate,
                changed_tiles: context.changed_tiles,
                skipped_tiles: context.skipped_tiles,
                cost: context.cost,
            })
        }
        RoadMutation::LayRoad { .. }
        | RoadMutation::LayRoadLine { .. }
        | RoadMutation::CycleRoadDirection { .. }
        | RoadMutation::PlaceRoundabout { .. } => road::apply_road_mutation(snapshot, mutation),
    }
}

fn route_impacts(
    previous: &GameSnapshot,
    previous_topology: &RoadTopology,
    candidate: &GameSnapshot,
    candidate_topology: &RoadTopology,
) -> Vec<RouteImpact> {
    let context = RoutingContext {
        road_topology: candidate_topology,
    };
    let previous_context = RoutingContext {
        road_topology: previous_topology,
    };
    let mut impacts = Vec::new();
    for route in &previous.transit.routes {
        let previous_legs = resolve_route_legs(
            previous,
            previous_context,
            TransitMode::Bus,
            &route.stop_ids,
            route.pattern,
        );
        let legs = resolve_route_legs(
            candidate,
            context,
            TransitMode::Bus,
            &route.stop_ids,
            route.pattern,
        );
        if let Some(kind) = classify_route_impact(&previous_legs, &legs) {
            impacts.push(RouteImpact {
                route_id: route.id.clone(),
                kind,
            });
        }
    }
    for line in &previous.transit.metro_lines {
        let previous_legs = resolve_route_legs(
            previous,
            previous_context,
            TransitMode::Metro,
            &line.station_ids,
            line.pattern,
        );
        let legs = resolve_route_legs(
            candidate,
            context,
            TransitMode::Metro,
            &line.station_ids,
            line.pattern,
        );
        if let Some(kind) = classify_route_impact(&previous_legs, &legs) {
            impacts.push(RouteImpact {
                route_id: line.id.clone(),
                kind,
            });
        }
    }
    impacts.sort_by(|left, right| left.route_id.cmp(&right.route_id));
    impacts
}

fn classify_route_impact(
    previous: &[RouteLegPath],
    candidate: &[RouteLegPath],
) -> Option<RouteImpactKind> {
    if previous == candidate {
        return None;
    }
    let was_broken = previous
        .iter()
        .any(|leg| leg.status != RouteLegStatus::Connected);
    let is_broken = candidate
        .iter()
        .any(|leg| leg.status != RouteLegStatus::Connected);
    if is_broken && !was_broken {
        return Some(RouteImpactKind::Broken);
    }
    Some(RouteImpactKind::Rerouted)
}

fn rejected_road_preview(
    generation: u64,
    rejection: GameplayRejection,
) -> RoadMutationPreviewResponse {
    let cost = if rejection.code == RejectionCode::InsufficientBudget {
        rejection.context.required_budget.unwrap_or(0)
    } else {
        0
    };
    RoadMutationPreviewResponse {
        generation,
        changed_tiles: Vec::new(),
        authored_tiles: Vec::new(),
        generated_structures: Vec::new(),
        cost,
        skipped_tiles: Vec::new(),
        route_impacts: Vec::new(),
        warnings: Vec::new(),
        rejection: Some(rejection),
    }
}

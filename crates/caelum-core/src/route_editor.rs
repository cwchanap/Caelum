use std::collections::BTreeSet;

use crate::cost_policy::{CostPolicy, CostedMutation};
use crate::engine::RoutingContext;
use crate::ids::next_entity_id;
use crate::model::{
    GameSnapshot, MetroLine, Route, RouteLegPath, RouteLegStatus, ServicePattern, TransitMode,
    TransitNodeStatus,
};
use crate::network::resolve_route_legs;
use crate::platforms::{apply_route_platform_delta, assign_added_waypoint_platforms};
use crate::rejection::{GameplayRejection, GameplayResult, RejectionCode, RejectionContext};
use crate::route_lifecycle::{self, rebase_edited_route_vehicles_and_riders};
use crate::transit::{initial_vehicle, vehicle_cost};
use crate::transit_nodes::{garbage_collect_missing_nodes, validate_present_compatible_node};

#[derive(Clone)]
struct RouteView {
    mode: TransitMode,
    pattern: ServicePattern,
    waypoint_ids: Vec<String>,
    revision: u32,
    legs: Vec<RouteLegPath>,
}

pub fn create_route(
    state: &GameSnapshot,
    context: RoutingContext<'_>,
    mode: TransitMode,
    pattern: ServicePattern,
    waypoint_ids: Vec<String>,
) -> GameplayResult<GameSnapshot> {
    create_route_costed(state, context, mode, pattern, waypoint_ids)
        .map(CostedMutation::into_snapshot)
}

pub(crate) fn create_route_costed(
    state: &GameSnapshot,
    context: RoutingContext<'_>,
    mode: TransitMode,
    pattern: ServicePattern,
    waypoint_ids: Vec<String>,
) -> GameplayResult<CostedMutation> {
    validate_waypoints(state, mode, &waypoint_ids, None, None)?;
    let legs = resolve_route_legs(state, context, mode, &waypoint_ids, pattern);
    require_all_connected(&legs, None)?;
    let authorized = CostPolicy::from_snapshot(state)
        .quote(vehicle_cost(mode), state.budget)
        .authorize()?;

    let mut candidate = state.clone();
    let route_id = next_route_id(&candidate, mode)?;
    assign_added_waypoint_platforms(&mut candidate, mode, &route_id, &waypoint_ids)?;
    let vehicle = initial_vehicle(&candidate, mode, &route_id);
    let vehicle_id = vehicle.id.clone();
    insert_route(
        &mut candidate,
        mode,
        route_id,
        pattern,
        waypoint_ids,
        legs,
        vehicle_id,
    )?;
    candidate.transit.vehicles.push(vehicle);
    authorized.apply_to(&mut candidate.budget)?;
    Ok(CostedMutation::new(candidate))
}

pub fn update_route(
    state: &GameSnapshot,
    context: RoutingContext<'_>,
    route_id: &str,
    expected_revision: u32,
    pattern: ServicePattern,
    waypoint_ids: Vec<String>,
) -> GameplayResult<GameSnapshot> {
    let current = route_view(state, route_id).ok_or_else(|| route_not_found(route_id))?;
    if current.revision != expected_revision {
        return Err(stale_revision(
            route_id,
            expected_revision,
            current.revision,
        ));
    }
    validate_waypoints(
        state,
        current.mode,
        &waypoint_ids,
        Some(route_id),
        Some(current.waypoint_ids.as_slice()),
    )?;
    let legs = resolve_route_legs(state, context, current.mode, &waypoint_ids, pattern);
    let retained_missing_ids =
        retained_missing_waypoint_ids(state, current.mode, &current.waypoint_ids, &waypoint_ids);
    validate_edit_legs(&current.legs, &legs, route_id, &retained_missing_ids)?;
    let legs = route_lifecycle::merge_resolved_legs(Some(&current.legs), legs);

    let mut candidate = state.clone();
    apply_route_platform_delta(
        &mut candidate,
        current.mode,
        route_id,
        &current.waypoint_ids,
        &waypoint_ids,
    )?;
    let structure_changed = current.waypoint_ids != waypoint_ids
        || current.pattern != pattern
        || current.legs != legs
        || route_lifecycle::platform_assignments_for_route(state, route_id)
            != route_lifecycle::platform_assignments_for_route(&candidate, route_id);
    let next_revision = if structure_changed {
        // Explicit edits reject on overflow (`RouteRevisionExhausted`) so the
        // player learns the route is stuck. This is asymmetric with
        // `route_lifecycle::next_revision`, which saturates instead — network-
        // driven bumps must never block an unrelated road/stop mutation. See
        // the doc comment on `route_lifecycle::next_revision` for the rationale.
        current
            .revision
            .checked_add(1)
            .ok_or_else(|| exhausted_revision(route_id, current.revision))?
    } else {
        current.revision
    };
    write_structural_route_fields(
        &mut candidate,
        route_id,
        pattern,
        waypoint_ids.clone(),
        legs,
        next_revision,
    );
    // Invariant: `validate_edit_legs` above rejects any leg that is newly
    // broken (was `Connected` in `current.legs` but is now non-`Connected`
    // with no matching pre-existing broken key). Only previously-broken legs
    // are allowed by `validate_edit_legs` to survive into `legs`. This
    // guarantees `rebase_edited_route_vehicles_and_riders` never observes a
    // leg that was connected before the edit but disconnected after it —
    // riders/vehicles on such a leg would be silently stranded.
    //
    // Skip the rebase when the save is a pure structural no-op: otherwise a
    // Save with the same pattern/waypoints still parks every vehicle and
    // invalidates active trips.
    if structure_changed {
        rebase_edited_route_vehicles_and_riders(
            state,
            &mut candidate,
            current.mode,
            route_id,
            &current.waypoint_ids,
            &waypoint_ids,
        );
    }
    Ok(garbage_collect_missing_nodes(&candidate))
}

fn validate_waypoints(
    snapshot: &GameSnapshot,
    mode: TransitMode,
    waypoint_ids: &[String],
    route_id: Option<&str>,
    previous_waypoint_ids: Option<&[String]>,
) -> GameplayResult<()> {
    if mode == TransitMode::Walk {
        return Err(route_validation_rejection(
            RejectionCode::IncompatibleRouteNode,
            route_id,
            None,
        ));
    }
    if waypoint_ids.len() < 2 {
        return Err(route_validation_rejection(
            RejectionCode::TooFewRouteNodes,
            route_id,
            waypoint_ids.first().map(String::as_str),
        ));
    }
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    if let Some(duplicate) = waypoint_ids
        .iter()
        .find(|id| !seen.insert(id.as_str()))
        .map(String::as_str)
    {
        return Err(route_validation_rejection(
            RejectionCode::DuplicateRouteNodes,
            route_id,
            Some(duplicate),
        ));
    }

    for waypoint_id in waypoint_ids {
        match validate_present_compatible_node(snapshot, mode, waypoint_id, route_id) {
            Ok(()) => {}
            Err(rejection)
                if rejection.code == RejectionCode::MissingRouteNode
                    && is_retained_missing_waypoint(
                        snapshot,
                        mode,
                        waypoint_id,
                        previous_waypoint_ids,
                    ) => {}
            Err(rejection) => return Err(rejection),
        }
    }
    Ok(())
}

/// Edits may keep a pre-existing tombstoned waypoint so the broken-route editor
/// can change other stops without first replacing every missing node. Newly
/// introduced missing IDs (not already on the route) stay rejected.
fn is_retained_missing_waypoint(
    snapshot: &GameSnapshot,
    mode: TransitMode,
    waypoint_id: &str,
    previous_waypoint_ids: Option<&[String]>,
) -> bool {
    let Some(previous) = previous_waypoint_ids else {
        return false;
    };
    if !previous.iter().any(|id| id == waypoint_id) {
        return false;
    }
    match mode {
        TransitMode::Bus => snapshot
            .transit
            .stops
            .iter()
            .any(|stop| stop.id == waypoint_id && stop.status == TransitNodeStatus::Missing),
        TransitMode::Metro => snapshot.transit.stations.iter().any(|station| {
            station.id == waypoint_id && station.status == TransitNodeStatus::Missing
        }),
        TransitMode::Walk => false,
    }
}

fn validate_edit_legs(
    old_legs: &[RouteLegPath],
    new_legs: &[RouteLegPath],
    route_id: &str,
    retained_missing_ids: &BTreeSet<&str>,
) -> GameplayResult<()> {
    for leg in new_legs {
        if leg.status == RouteLegStatus::Connected {
            continue;
        }
        let carried = old_legs
            .iter()
            .any(|old| old.status != RouteLegStatus::Connected && old.key() == leg.key());
        if carried {
            continue;
        }
        // Changing other waypoints around a retained tombstone creates new leg
        // keys that are MissingNode solely because that tombstone remains.
        // Those are allowed; network-disconnected or brand-new missing IDs are not.
        if leg.status == RouteLegStatus::MissingNode
            && (retained_missing_ids.contains(leg.from_waypoint_id.as_str())
                || retained_missing_ids.contains(leg.to_waypoint_id.as_str()))
        {
            continue;
        }
        return Err(disconnected_leg_rejection(leg, Some(route_id)));
    }
    Ok(())
}

fn retained_missing_waypoint_ids<'a>(
    snapshot: &'a GameSnapshot,
    mode: TransitMode,
    previous_waypoint_ids: &'a [String],
    waypoint_ids: &'a [String],
) -> BTreeSet<&'a str> {
    waypoint_ids
        .iter()
        .filter_map(|waypoint_id| {
            is_retained_missing_waypoint(snapshot, mode, waypoint_id, Some(previous_waypoint_ids))
                .then_some(waypoint_id.as_str())
        })
        .collect()
}

fn require_all_connected(legs: &[RouteLegPath], route_id: Option<&str>) -> GameplayResult<()> {
    if let Some(leg) = legs
        .iter()
        .find(|leg| leg.status != RouteLegStatus::Connected)
    {
        return Err(disconnected_leg_rejection(leg, route_id));
    }
    Ok(())
}

fn disconnected_leg_rejection(leg: &RouteLegPath, route_id: Option<&str>) -> GameplayRejection {
    GameplayRejection {
        code: RejectionCode::DisconnectedLeg,
        context: RejectionContext {
            route_id: route_id.map(str::to_string),
            from_waypoint_id: Some(leg.from_waypoint_id.clone()),
            to_waypoint_id: Some(leg.to_waypoint_id.clone()),
            ..RejectionContext::default()
        },
    }
}

fn route_validation_rejection(
    code: RejectionCode,
    route_id: Option<&str>,
    node_id: Option<&str>,
) -> GameplayRejection {
    GameplayRejection {
        code,
        context: RejectionContext {
            route_id: route_id.map(str::to_string),
            node_id: node_id.map(str::to_string),
            ..RejectionContext::default()
        },
    }
}

fn route_not_found(route_id: &str) -> GameplayRejection {
    GameplayRejection {
        code: RejectionCode::RouteNotFound,
        context: RejectionContext {
            route_id: Some(route_id.to_string()),
            ..RejectionContext::default()
        },
    }
}

fn stale_revision(route_id: &str, expected: u32, actual: u32) -> GameplayRejection {
    GameplayRejection {
        code: RejectionCode::RouteChangedWhileEditing,
        context: RejectionContext {
            route_id: Some(route_id.to_string()),
            expected_revision: Some(expected),
            actual_revision: Some(actual),
            ..RejectionContext::default()
        },
    }
}

fn exhausted_revision(route_id: &str, actual: u32) -> GameplayRejection {
    GameplayRejection::route_revision_exhausted(route_id, actual)
}

fn route_view(snapshot: &GameSnapshot, route_id: &str) -> Option<RouteView> {
    if let Some(route) = snapshot
        .transit
        .routes
        .iter()
        .find(|route| route.id == route_id)
    {
        return Some(RouteView {
            mode: TransitMode::Bus,
            pattern: route.pattern,
            waypoint_ids: route.stop_ids.clone(),
            revision: route.revision,
            legs: route.legs.clone(),
        });
    }
    snapshot
        .transit
        .metro_lines
        .iter()
        .find(|line| line.id == route_id)
        .map(|line| RouteView {
            mode: TransitMode::Metro,
            pattern: line.pattern,
            waypoint_ids: line.station_ids.clone(),
            revision: line.revision,
            legs: line.legs.clone(),
        })
}

fn next_route_id(snapshot: &GameSnapshot, mode: TransitMode) -> GameplayResult<String> {
    match mode {
        TransitMode::Bus => Ok(next_entity_id(
            "route",
            snapshot.transit.routes.iter().map(|route| route.id.clone()),
        )),
        TransitMode::Metro => Ok(next_entity_id(
            "metro",
            snapshot
                .transit
                .metro_lines
                .iter()
                .map(|line| line.id.clone()),
        )),
        // Walk routes are rejected by `validate_waypoints` (IncompatibleRouteNode)
        // before this point. Surface the same rejection instead of panicking so
        // a future dispatch-routing regression does not poison the Tauri Mutex.
        TransitMode::Walk => Err(GameplayRejection::new(RejectionCode::IncompatibleRouteNode)),
    }
}

#[allow(clippy::too_many_arguments)]
fn insert_route(
    snapshot: &mut GameSnapshot,
    mode: TransitMode,
    route_id: String,
    pattern: ServicePattern,
    waypoint_ids: Vec<String>,
    legs: Vec<RouteLegPath>,
    vehicle_id: String,
) -> GameplayResult<()> {
    let number = route_id
        .rsplit('-')
        .next()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(1);
    match mode {
        TransitMode::Bus => snapshot.transit.routes.push(Route {
            id: route_id,
            name: format!("Bus {number}"),
            color: "#e04f39".to_string(),
            stop_ids: waypoint_ids,
            vehicle_ids: vec![vehicle_id],
            active: true,
            pattern,
            revision: 0,
            legs,
            path_broken: false,
        }),
        TransitMode::Metro => snapshot.transit.metro_lines.push(MetroLine {
            id: route_id,
            name: format!("Metro {number}"),
            color: "#2867b2".to_string(),
            station_ids: waypoint_ids,
            vehicle_ids: vec![vehicle_id],
            active: true,
            pattern,
            revision: 0,
            legs,
            path_broken: false,
        }),
        // Walk routes are rejected by `validate_waypoints` before this point.
        // Surface the same rejection (IncompatibleRouteNode) instead of
        // panicking under the Tauri Mutex.
        TransitMode::Walk => {
            return Err(GameplayRejection::new(RejectionCode::IncompatibleRouteNode))
        }
    }
    Ok(())
}

fn write_structural_route_fields(
    snapshot: &mut GameSnapshot,
    route_id: &str,
    pattern: ServicePattern,
    waypoint_ids: Vec<String>,
    legs: Vec<RouteLegPath>,
    revision: u32,
) {
    let path_broken = legs
        .iter()
        .any(|leg| leg.status != RouteLegStatus::Connected);
    if let Some(route) = snapshot
        .transit
        .routes
        .iter_mut()
        .find(|route| route.id == route_id)
    {
        route.pattern = pattern;
        route.stop_ids = waypoint_ids;
        route.legs = legs;
        route.path_broken = path_broken;
        route.revision = revision;
        return;
    }
    if let Some(line) = snapshot
        .transit
        .metro_lines
        .iter_mut()
        .find(|line| line.id == route_id)
    {
        line.pattern = pattern;
        line.station_ids = waypoint_ids;
        line.legs = legs;
        line.path_broken = path_broken;
        line.revision = revision;
    }
}

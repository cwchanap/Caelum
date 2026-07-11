use std::collections::{HashMap, HashSet};

use crate::model::{
    ActiveTrip, BusStopKind, GameSnapshot, Platform, RouteLeg, TransitMode, TripStatus,
};
use crate::rejection::{GameplayRejection, GameplayResult, RejectionCode, RejectionContext};
use crate::transit_nodes::is_present_node;

pub const BUS_PLATFORM_CAPACITY: u16 = 50;
pub const METRO_PLATFORM_CAPACITY: u16 = 300;

const PLATFORM_LABELS: [&str; 6] = ["A", "B", "C", "D", "E", "F"];

pub fn bus_platforms(stop_id: &str, kind: BusStopKind) -> Vec<Platform> {
    build_platforms(
        stop_id,
        if kind == BusStopKind::BusTerminal {
            3
        } else {
            1
        },
        BUS_PLATFORM_CAPACITY,
    )
}

pub fn metro_platforms(station_id: &str) -> Vec<Platform> {
    build_platforms(station_id, 2, METRO_PLATFORM_CAPACITY)
}

pub fn assign_added_waypoint_platforms(
    state: &mut GameSnapshot,
    mode: TransitMode,
    route_id: &str,
    waypoint_ids: &[String],
) -> GameplayResult<()> {
    for waypoint_id in waypoint_ids {
        assign_waypoint_to_least_loaded(state, mode, route_id, waypoint_id)?;
    }
    Ok(())
}

pub fn apply_route_platform_delta(
    state: &mut GameSnapshot,
    mode: TransitMode,
    route_id: &str,
    old_waypoint_ids: &[String],
    new_waypoint_ids: &[String],
) -> GameplayResult<()> {
    let retained: HashSet<&str> = new_waypoint_ids.iter().map(String::as_str).collect();
    for waypoint_id in old_waypoint_ids {
        if retained.contains(waypoint_id.as_str()) {
            continue;
        }
        strip_route_from_waypoint(state, mode, route_id, waypoint_id);
    }

    let existing: HashSet<&str> = old_waypoint_ids.iter().map(String::as_str).collect();
    for waypoint_id in new_waypoint_ids {
        if existing.contains(waypoint_id.as_str()) {
            continue;
        }
        assign_waypoint_to_least_loaded(state, mode, route_id, waypoint_id)?;
    }
    Ok(())
}

fn assign_waypoint_to_least_loaded(
    state: &mut GameSnapshot,
    mode: TransitMode,
    route_id: &str,
    waypoint_id: &str,
) -> GameplayResult<()> {
    let platforms = match mode {
        TransitMode::Bus => state
            .transit
            .stops
            .iter_mut()
            .find(|stop| stop.id == waypoint_id)
            .map(|stop| &mut stop.platforms),
        TransitMode::Metro => state
            .transit
            .stations
            .iter_mut()
            .find(|station| station.id == waypoint_id)
            .map(|station| &mut station.platforms),
        TransitMode::Walk => None,
    }
    .ok_or_else(|| platform_rejection(route_id, waypoint_id))?;
    let best_index = platforms
        .iter()
        .enumerate()
        .min_by_key(|(index, platform)| (platform.route_ids.len(), *index))
        .map(|(index, _)| index)
        .ok_or_else(|| platform_rejection(route_id, waypoint_id))?;
    if !platforms[best_index]
        .route_ids
        .iter()
        .any(|id| id == route_id)
    {
        platforms[best_index].route_ids.push(route_id.to_string());
    }
    Ok(())
}

fn strip_route_from_waypoint(
    state: &mut GameSnapshot,
    mode: TransitMode,
    route_id: &str,
    waypoint_id: &str,
) {
    let platforms = match mode {
        TransitMode::Bus => state
            .transit
            .stops
            .iter_mut()
            .find(|stop| stop.id == waypoint_id)
            .map(|stop| &mut stop.platforms),
        TransitMode::Metro => state
            .transit
            .stations
            .iter_mut()
            .find(|station| station.id == waypoint_id)
            .map(|station| &mut station.platforms),
        TransitMode::Walk => None,
    };
    if let Some(platforms) = platforms {
        for platform in platforms {
            platform.route_ids.retain(|id| id != route_id);
        }
    }
}

fn platform_rejection(route_id: &str, node_id: &str) -> GameplayRejection {
    GameplayRejection {
        code: RejectionCode::InvalidPlatform,
        context: RejectionContext {
            route_id: Some(route_id.to_string()),
            node_id: Some(node_id.to_string()),
            ..RejectionContext::default()
        },
    }
}

pub fn on_platform_trip_ids(state: &GameSnapshot) -> HashSet<String> {
    let capacities = platform_capacities(state);
    let waiters = platform_waiter_ids(state);
    let mut on_platform = HashSet::new();

    for (platform_id, ids) in waiters {
        let capacity = usize::from(*capacities.get(&platform_id).unwrap_or(&0));
        for id in ids.into_iter().take(capacity) {
            on_platform.insert(id);
        }
    }

    on_platform
}

pub(crate) fn platform_waiter_ids(state: &GameSnapshot) -> HashMap<String, Vec<String>> {
    let index = platform_index(state);
    let mut groups: HashMap<String, Vec<&ActiveTrip>> = HashMap::new();

    for trip in &state.active_trips {
        if trip.status != TripStatus::Waiting {
            continue;
        }

        let Some(line_id) = waiting_line_id(trip) else {
            continue;
        };
        let key = format!(
            "{}|{}",
            position_key(
                trip.position.x.round() as i32,
                trip.position.y.round() as i32
            ),
            line_id
        );
        let Some(platform_id) = index.get(&key) else {
            continue;
        };
        groups.entry(platform_id.clone()).or_default().push(trip);
    }

    let mut ordered = HashMap::new();
    for (platform_id, mut trips) in groups {
        trips.sort_by(|left, right| {
            left.patience_remaining
                .total_cmp(&right.patience_remaining)
                .then_with(|| left.id.cmp(&right.id))
        });
        ordered.insert(
            platform_id,
            trips.into_iter().map(|trip| trip.id.clone()).collect(),
        );
    }

    ordered
}

fn build_platforms(node_id: &str, count: usize, capacity: u16) -> Vec<Platform> {
    (0..count)
        .map(|index| Platform {
            id: format!("{node_id}-p{index}"),
            label: PLATFORM_LABELS
                .get(index)
                .map_or_else(|| index.to_string(), ToString::to_string),
            capacity,
            route_ids: Vec::new(),
        })
        .collect()
}

fn waiting_line_id(trip: &ActiveTrip) -> Option<&str> {
    let leg = trip.route_plan.as_ref()?.legs.get(trip.current_leg_index)?;
    non_walk_line_id(leg)
}

fn non_walk_line_id(leg: &RouteLeg) -> Option<&str> {
    if leg.mode == TransitMode::Walk {
        None
    } else {
        leg.line_id.as_deref()
    }
}

fn platform_index(state: &GameSnapshot) -> HashMap<String, String> {
    let mut index = HashMap::new();

    for stop in &state.transit.stops {
        if !is_present_node(stop.status) {
            continue;
        }
        let pos_key = position_key(stop.position.x, stop.position.y);
        for platform in &stop.platforms {
            for route_id in &platform.route_ids {
                index.insert(format!("{pos_key}|{route_id}"), platform.id.clone());
            }
        }
    }

    for station in &state.transit.stations {
        if !is_present_node(station.status) {
            continue;
        }
        let pos_key = position_key(station.position.x, station.position.y);
        for platform in &station.platforms {
            for route_id in &platform.route_ids {
                index.insert(format!("{pos_key}|{route_id}"), platform.id.clone());
            }
        }
    }

    index
}

fn platform_capacities(state: &GameSnapshot) -> HashMap<String, u16> {
    let mut capacities = HashMap::new();

    for stop in &state.transit.stops {
        if !is_present_node(stop.status) {
            continue;
        }
        for platform in &stop.platforms {
            capacities.insert(platform.id.clone(), platform.capacity);
        }
    }

    for station in &state.transit.stations {
        if !is_present_node(station.status) {
            continue;
        }
        for platform in &station.platforms {
            capacities.insert(platform.id.clone(), platform.capacity);
        }
    }

    capacities
}

fn position_key(x: i32, y: i32) -> String {
    format!("{x},{y}")
}

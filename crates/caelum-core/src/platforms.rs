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

fn platform_waiter_candidates(state: &GameSnapshot) -> Vec<(&ActiveTrip, String, String)> {
    let index = platform_index(state);
    state
        .active_trips
        .iter()
        .filter_map(|trip| {
            if trip.status != TripStatus::Waiting {
                return None;
            }
            let line_id = waiting_line_id(trip)?;
            let key = format!(
                "{}|{}",
                position_key(
                    trip.position.x.round() as i32,
                    trip.position.y.round() as i32,
                ),
                line_id,
            );
            let platform_id = index.get(&key)?.clone();
            Some((trip, line_id.to_string(), platform_id))
        })
        .collect()
}

pub(crate) fn platform_waiter_ids(state: &GameSnapshot) -> HashMap<String, Vec<String>> {
    let mut groups: HashMap<String, Vec<&ActiveTrip>> = HashMap::new();
    for (trip, _, platform_id) in platform_waiter_candidates(state) {
        groups.entry(platform_id).or_default().push(trip);
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

#[allow(clippy::needless_lifetimes)]
pub(crate) fn platform_waiters_by_line<'a>(
    state: &'a GameSnapshot,
) -> HashMap<String, Vec<&'a ActiveTrip>> {
    // Apply the same platform-capacity admission as `on_platform_trip_ids`:
    // `platform_waiter_candidates` returns every Waiting trip on a serving
    // platform, but only the first `capacity` riders (by patience/id ordering)
    // can actually board. Overflow riders on a shared, full platform cannot
    // board any line there, so they must not inflate route health.
    let on_platform = on_platform_trip_ids(state);
    let mut groups: HashMap<String, Vec<&ActiveTrip>> = HashMap::new();
    for (trip, line_id, _) in platform_waiter_candidates(state) {
        if !on_platform.contains(&trip.id) {
            continue;
        }
        groups.entry(line_id).or_default().push(trip);
    }
    groups
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Point, RoutePlan, ServiceDirection, Stop, TransitNodeStatus, TripPurpose};
    use crate::state::create_initial_snapshot;

    fn waiting_trip(id: &str, position: Point, status: TripStatus) -> ActiveTrip {
        ActiveTrip {
            id: id.to_string(),
            sim_id: format!("sim-{id}"),
            purpose: TripPurpose::CommuteOutbound,
            origin: position,
            destination: Point::from((0, 0)),
            position: position.into(),
            status,
            deadline: 9_999.0,
            route_plan: Some(RoutePlan {
                estimated_seconds: 100.0,
                legs: vec![RouteLeg {
                    mode: TransitMode::Bus,
                    from: position,
                    to: Point::from((0, 0)),
                    line_id: Some("route-001".to_string()),
                    service_direction: Some(ServiceDirection::Loop),
                    board_itinerary_index: Some(0),
                    alight_itinerary_index: Some(0),
                }],
            }),
            current_leg_index: 0,
            patience_remaining: 100.0,
            current_leg_wait_seconds: 0.0,
            private_car_trip: None,
        }
    }

    fn waiting_trip_for_line(
        id: &str,
        position: Point,
        line_id: &str,
        patience_remaining: f64,
    ) -> ActiveTrip {
        ActiveTrip {
            id: id.to_string(),
            sim_id: format!("sim-{id}"),
            purpose: TripPurpose::CommuteOutbound,
            origin: position,
            destination: Point::from((0, 0)),
            position: position.into(),
            status: TripStatus::Waiting,
            deadline: 9_999.0,
            route_plan: Some(RoutePlan {
                estimated_seconds: 100.0,
                legs: vec![RouteLeg {
                    mode: TransitMode::Bus,
                    from: position,
                    to: Point::from((0, 0)),
                    line_id: Some(line_id.to_string()),
                    service_direction: Some(ServiceDirection::Loop),
                    board_itinerary_index: Some(0),
                    alight_itinerary_index: Some(0),
                }],
            }),
            current_leg_index: 0,
            patience_remaining,
            current_leg_wait_seconds: 0.0,
            private_car_trip: None,
        }
    }

    #[test]
    fn platform_waiters_by_line_requires_real_serving_platform() {
        let mut snapshot = create_initial_snapshot();
        snapshot.transit.stops.push(Stop {
            id: "stop-001".to_string(),
            kind: BusStopKind::BusStop,
            status: TransitNodeStatus::Present,
            position: Point::from((5, 5)),
            platforms: vec![Platform {
                id: "stop-001-p0".to_string(),
                label: "A".to_string(),
                capacity: 50,
                route_ids: vec!["route-001".to_string()],
            }],
            road_access: None,
        });
        snapshot.active_trips = vec![
            waiting_trip("boardable", Point::from((5, 5)), TripStatus::Waiting),
            waiting_trip("unboardable", Point::from((6, 5)), TripStatus::Waiting),
            waiting_trip("riding", Point::from((5, 5)), TripStatus::Riding),
        ];

        let grouped = platform_waiters_by_line(&snapshot);
        let ids = grouped["route-001"]
            .iter()
            .map(|trip| trip.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["boardable"]);
    }

    #[test]
    fn platform_waiters_by_line_excludes_capacity_overflow_on_shared_platform() {
        // A shared platform with capacity 2 serves both route-001 and
        // route-002. Four Waiting trips compete for two admission slots.
        // `on_platform_trip_ids` admits the two with the lowest patience
        // (most urgent); the other two cannot board any line at this
        // platform and must not appear in per-line health aggregation.
        let mut snapshot = create_initial_snapshot();
        snapshot.transit.stops.push(Stop {
            id: "stop-shared".to_string(),
            kind: BusStopKind::BusStop,
            status: TransitNodeStatus::Present,
            position: Point::from((5, 5)),
            platforms: vec![Platform {
                id: "stop-shared-p0".to_string(),
                label: "A".to_string(),
                capacity: 2,
                route_ids: vec!["route-001".to_string(), "route-002".to_string()],
            }],
            road_access: None,
        });
        snapshot.active_trips = vec![
            waiting_trip_for_line("a1", Point::from((5, 5)), "route-001", 100.0),
            waiting_trip_for_line("a2", Point::from((5, 5)), "route-001", 50.0),
            waiting_trip_for_line("a3", Point::from((5, 5)), "route-001", 10.0),
            waiting_trip_for_line("b1", Point::from((5, 5)), "route-002", 1.0),
        ];

        let on_platform = on_platform_trip_ids(&snapshot);
        // Capacity 2, sorted by patience asc: b1 (1), a3 (10) admitted.
        assert!(on_platform.contains("b1"));
        assert!(on_platform.contains("a3"));
        assert!(!on_platform.contains("a1"));
        assert!(!on_platform.contains("a2"));

        let grouped = platform_waiters_by_line(&snapshot);
        let route_001_ids: Vec<&str> = grouped
            .get("route-001")
            .map(|trips| trips.iter().map(|t| t.id.as_str()).collect())
            .unwrap_or_default();
        let route_002_ids: Vec<&str> = grouped
            .get("route-002")
            .map(|trips| trips.iter().map(|t| t.id.as_str()).collect())
            .unwrap_or_default();
        // Only admitted riders appear; overflow riders a1/a2 are excluded.
        assert_eq!(route_001_ids, vec!["a3"]);
        assert_eq!(route_002_ids, vec!["b1"]);
    }
}

use crate::heading::{canonical_headings, offset_components};
use crate::model::{
    BusStopKind, GameMap, GameSnapshot, Heading, Point, Stop, StopRoadAccess, Tile, TransitMode,
    TripPosition,
};
use crate::road::reciprocal_connection;
use crate::road_topology::{is_road, lane_accepts};
use crate::service_itinerary::service_visits;
use crate::transit_nodes::is_present_node;
use std::collections::HashMap;

fn checked_offset(point: Point, heading: Heading) -> Option<Point> {
    let (dx, dy) = offset_components(heading);
    Some(Point {
        x: point.x.checked_add(dx)?,
        y: point.y.checked_add(dy)?,
    })
}

fn usable_road(map: &GameMap, point: Point) -> bool {
    map.tile(point).is_some_and(|tile| {
        is_road(map, point)
            && tile.road_structure_id.is_none()
            && canonical_headings().into_iter().any(|heading| {
                lane_accepts(tile.one_way, heading) && reciprocal_connection(map, point, heading)
            })
    })
}

pub(crate) fn derive_stop_access(map: &GameMap, anchor: Point) -> Option<StopRoadAccess> {
    derive_stop_access_for_footprint(map, &[anchor])
}

fn preferred_heading_for_tile(tile: &Tile) -> Option<Heading> {
    canonical_headings()
        .into_iter()
        .find(|heading| {
            lane_accepts(tile.one_way, *heading) && tile.road_connections.contains(heading)
        })
        .or_else(|| {
            canonical_headings()
                .into_iter()
                .find(|heading| lane_accepts(tile.one_way, *heading))
        })
}

pub(crate) fn derive_stop_access_for_footprint(
    map: &GameMap,
    footprint: &[Point],
) -> Option<StopRoadAccess> {
    let road_point = footprint
        .iter()
        .flat_map(|point| {
            canonical_headings()
                .into_iter()
                .filter_map(|heading| checked_offset(*point, heading))
        })
        .find(|point| usable_road(map, *point))?;
    let tile = map.tile(road_point)?;
    Some(StopRoadAccess {
        road_point,
        preferred_heading: preferred_heading_for_tile(tile),
    })
}

pub(crate) fn stop_footprint(snapshot: &GameSnapshot, stop: &Stop) -> Vec<Point> {
    snapshot
        .buildings
        .iter()
        .find(|building| building.transit_node_id.as_deref() == Some(stop.id.as_str()))
        .map_or_else(
            || vec![stop.position],
            |building| building.occupied_tiles.clone(),
        )
}

pub(crate) fn is_valid_access(map: &GameMap, footprint: &[Point], access: StopRoadAccess) -> bool {
    let adjacent_to_footprint = footprint.iter().any(|point| {
        canonical_headings()
            .into_iter()
            .any(|heading| checked_offset(*point, heading) == Some(access.road_point))
    });
    let legacy_on_road_fallback = footprint.len() == 1
        && footprint[0] == access.road_point
        && map.tile(access.road_point).is_some_and(|tile| {
            is_road(map, access.road_point) && tile.road_structure_id.is_none()
        });

    usable_road(map, access.road_point) && (adjacent_to_footprint || legacy_on_road_fallback)
}

pub(crate) fn stop_access(snapshot: &GameSnapshot, stop_id: &str) -> Option<StopRoadAccess> {
    let stop = snapshot
        .transit
        .stops
        .iter()
        .find(|stop| stop.id == stop_id && is_present_node(stop.status))?;
    let footprint = stop_footprint(snapshot, stop);
    match stop.road_access {
        Some(access) if is_valid_access(&snapshot.map, &footprint, access) => Some(access),
        _ => derive_stop_access_for_footprint(&snapshot.map, &footprint),
    }
}

#[derive(Clone, Debug)]
struct StopMove {
    stop_id: String,
    old_position: Point,
    new_position: Point,
    road_point: Point,
}

pub(crate) fn normalize_snapshot_stops(mut snapshot: GameSnapshot) -> GameSnapshot {
    let mut stop_indexes: Vec<usize> = snapshot
        .transit
        .stops
        .iter()
        .enumerate()
        .filter_map(|(index, stop)| is_present_node(stop.status).then_some(index))
        .collect();
    stop_indexes.sort_by(|left, right| {
        snapshot.transit.stops[*left]
            .id
            .cmp(&snapshot.transit.stops[*right].id)
            .then_with(|| left.cmp(right))
    });

    let old_road_points: HashMap<String, Point> = snapshot
        .transit
        .stops
        .iter()
        .filter(|stop| is_present_node(stop.status))
        .filter_map(|stop| {
            stop.road_access
                .as_ref()
                .map(|access| (stop.id.clone(), access.road_point))
        })
        .collect();

    let mut moves = Vec::new();
    for stop_index in stop_indexes {
        let stop = snapshot.transit.stops[stop_index].clone();
        let is_legacy_on_road = stop.kind == BusStopKind::BusStop
            && snapshot
                .map
                .tile(stop.position)
                .is_some_and(|tile| tile.kind == "road");

        if is_legacy_on_road {
            let road_point = stop.position;
            let new_position = canonical_headings()
                .into_iter()
                .filter_map(|heading| checked_offset(stop.position, heading))
                .find(|candidate| is_free_anchor(&snapshot, *candidate));
            let access = access_for_road_point(&snapshot.map, road_point).or_else(|| {
                new_position.and_then(|position| {
                    derive_stop_access_for_footprint(&snapshot.map, &[position])
                })
            });

            if let Some(new_position) = new_position {
                snapshot.transit.stops[stop_index].position = new_position;
                snapshot.transit.stops[stop_index].road_access = access;
                moves.push(StopMove {
                    stop_id: stop.id,
                    old_position: stop.position,
                    new_position,
                    road_point,
                });
            } else {
                snapshot.transit.stops[stop_index].road_access = access;
            }
            continue;
        }

        let current_stop = snapshot.transit.stops[stop_index].clone();
        let footprint = stop_footprint(&snapshot, &current_stop);
        snapshot.transit.stops[stop_index].road_access = match current_stop.road_access {
            Some(access) if is_valid_access(&snapshot.map, &footprint, access) => Some(access),
            _ => derive_stop_access_for_footprint(&snapshot.map, &footprint),
        };
    }

    rebase_parked_bus_positions(&mut snapshot, &old_road_points);
    rebase_active_trips(&mut snapshot, &moves);
    snapshot
}

fn rebase_parked_bus_positions(
    snapshot: &mut GameSnapshot,
    old_road_points: &HashMap<String, Point>,
) {
    let repairs: Vec<(usize, Point)> = snapshot
        .transit
        .vehicles
        .iter()
        .enumerate()
        .filter_map(|(vehicle_index, vehicle)| {
            if vehicle.mode != TransitMode::Bus {
                return None;
            }
            let parked_position = vehicle.parked_position.as_ref()?;
            // Rebase parked vehicles regardless of the route's active flag: a
            // paused route's buses are still parked at a stop whose road access
            // can change via a later road mutation. The active flag controls
            // whether they resume service, not whether their parked position
            // tracks the current access tile.
            let route = snapshot
                .transit
                .routes
                .iter()
                .find(|route| route.id == vehicle.line_id)?;
            // Identify the vehicle's associated stop via its itinerary first,
            // falling back to coordinate matching. Two stops can legally share
            // a road-access tile (e.g. opposite sides of a road); a pure
            // coordinate scan would let the first matching stop capture a bus
            // actually parked for the other. The itinerary index reliably
            // points to the service visit the vehicle was parked at (set by
            // break_service / restore_service / rebase_parked_vehicles).
            let visits = service_visits(&route.stop_ids, &route.legs);
            let itinerary_stop_id = visits
                .iter()
                .find(|visit| visit.departing_itinerary_index == vehicle.itinerary_index)
                .map(|visit| visit.waypoint_id.clone());
            let road_point = itinerary_stop_id
                .as_deref()
                .and_then(|stop_id| {
                    match_stop_access(snapshot, stop_id, parked_position, old_road_points)
                })
                .or_else(|| {
                    route.stop_ids.iter().find_map(|stop_id| {
                        match_stop_access(snapshot, stop_id, parked_position, old_road_points)
                    })
                })?;
            Some((vehicle_index, road_point))
        })
        .collect();

    for (vehicle_index, road_point) in repairs {
        snapshot.transit.vehicles[vehicle_index].parked_position = Some(road_point.into());
    }
}

/// Check whether a stop's current or previous road access matches the vehicle's
/// `parked_position`; if so, return the current access road point so the
/// vehicle can be rebased to it.
fn match_stop_access(
    snapshot: &GameSnapshot,
    stop_id: &str,
    parked_position: &TripPosition,
    old_road_points: &HashMap<String, Point>,
) -> Option<Point> {
    let stop = snapshot
        .transit
        .stops
        .iter()
        .find(|stop| stop.id == stop_id && is_present_node(stop.status))?;
    let access = stop_access(snapshot, &stop.id)?;
    let passenger_position: TripPosition = stop.position.into();
    let road_position: TripPosition = access.road_point.into();
    let old_road_position = old_road_points
        .get(&stop.id)
        .map(|point| TripPosition::from(*point));
    let matches_current =
        parked_position == &passenger_position || parked_position == &road_position;
    let matches_old = old_road_position
        .as_ref()
        .is_some_and(|old| parked_position == old);
    (matches_current || matches_old).then_some(access.road_point)
}

fn access_for_road_point(map: &GameMap, road_point: Point) -> Option<StopRoadAccess> {
    let tile = map.tile(road_point)?;
    if !usable_road(map, road_point) {
        return None;
    }
    Some(StopRoadAccess {
        road_point,
        preferred_heading: preferred_heading_for_tile(tile),
    })
}

fn is_free_anchor(snapshot: &GameSnapshot, point: Point) -> bool {
    snapshot.map.tile(point).is_some_and(|tile| {
        tile.kind == "empty"
            && !tile.has_track
            && tile.road_structure_id.is_none()
            && !snapshot
                .buildings
                .iter()
                .any(|building| building.occupied_tiles.contains(&point))
            && !snapshot
                .transit
                .stops
                .iter()
                .any(|stop| is_present_node(stop.status) && stop.position == point)
            && !snapshot
                .transit
                .stations
                .iter()
                .any(|station| is_present_node(station.status) && station.position == point)
    })
}

fn rebase_active_trips(snapshot: &mut GameSnapshot, moves: &[StopMove]) {
    for movement in moves {
        debug_assert!(!movement.stop_id.is_empty());
        debug_assert_eq!(movement.road_point, movement.old_position);
        for trip in &mut snapshot.active_trips {
            if trip.status == crate::model::TripStatus::Waiting
                && trip.position == movement.old_position.into()
            {
                trip.position = movement.new_position.into();
            }

            let Some(route_plan) = trip.route_plan.as_mut() else {
                continue;
            };
            for leg_index in 0..route_plan.legs.len() {
                if route_plan.legs[leg_index].mode != crate::model::TransitMode::Bus {
                    continue;
                }

                let from_moved = route_plan.legs[leg_index].from == movement.old_position;
                let to_moved = route_plan.legs[leg_index].to == movement.old_position;
                if from_moved {
                    route_plan.legs[leg_index].from = movement.new_position;
                    if leg_index > 0
                        && route_plan.legs[leg_index - 1].mode == crate::model::TransitMode::Walk
                        && route_plan.legs[leg_index - 1].to == movement.old_position
                    {
                        route_plan.legs[leg_index - 1].to = movement.new_position;
                    }
                }
                if to_moved {
                    route_plan.legs[leg_index].to = movement.new_position;
                    if leg_index + 1 < route_plan.legs.len()
                        && route_plan.legs[leg_index + 1].mode == crate::model::TransitMode::Walk
                        && route_plan.legs[leg_index + 1].from == movement.old_position
                    {
                        route_plan.legs[leg_index + 1].from = movement.new_position;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intent::RoadPreset;
    use crate::model::{
        ActiveTrip, MovementKind, PathGeometry, RoadPathStep, Route, RouteLeg, RouteLegKind,
        RouteLegPath, RouteLegStatus, RoutePlan, ServiceDirection, ServicePattern, TransitMode,
        TransitPath, TripPurpose, TripStatus, Vehicle,
    };
    use crate::road::{apply_road_mutation, RoadMutation};
    use crate::state::create_initial_snapshot;

    fn service_leg(from: &str, to: &str) -> RouteLegPath {
        RouteLegPath {
            from_waypoint_id: from.to_string(),
            to_waypoint_id: to.to_string(),
            direction: ServiceDirection::Loop,
            kind: RouteLegKind::Service,
            status: RouteLegStatus::Connected,
            current_path: Some(TransitPath::Road {
                steps: vec![RoadPathStep {
                    position: Point { x: 4, y: 5 },
                    entering_heading: Heading::East,
                    leaving_heading: Heading::East,
                    movement: MovementKind::Straight,
                    geometry: PathGeometry::Line {
                        from: TripPosition::from(Point { x: 4, y: 5 }),
                        to: TripPosition::from(Point { x: 8, y: 5 }),
                    },
                    travel_seconds: 4.0,
                }],
                total_travel_seconds: 4.0,
            }),
            last_valid_path: None,
            estimated_seconds: Some(4.0),
            failure_reason: None,
        }
    }

    fn road_at_y5() -> GameSnapshot {
        let snapshot = create_initial_snapshot();
        apply_road_mutation(
            &snapshot,
            &RoadMutation::LayRoadLine {
                points: (2..=10).map(|x| Point { x, y: 5 }).collect(),
                preset: RoadPreset::TwoWay,
            },
        )
        .expect("fixture road should apply")
        .snapshot
    }

    #[test]
    fn accepts_the_supported_on_road_fallback_access() {
        let candidate = road_at_y5();

        assert!(is_valid_access(
            &candidate.map,
            &[Point { x: 4, y: 5 }],
            StopRoadAccess {
                road_point: Point { x: 4, y: 5 },
                preferred_heading: None,
            },
        ));
    }

    #[test]
    fn derive_access_falls_back_to_a_lane_accepted_heading_without_a_connection() {
        let mut candidate = road_at_y5();
        let tile = candidate
            .map
            .tile_mut(Point { x: 4, y: 5 })
            .expect("road tile exists");
        tile.one_way = Some(Heading::East);
        tile.road_connections.clear();

        let access = derive_stop_access_for_footprint(&candidate.map, &[Point { x: 4, y: 4 }])
            .expect("roadside access is derived");
        assert_eq!(access.road_point, Point { x: 4, y: 5 });
        assert_eq!(access.preferred_heading, Some(Heading::East));
    }

    #[test]
    fn access_for_road_point_returns_none_for_a_structure_owned_road() {
        let mut candidate = road_at_y5();
        let tile = candidate
            .map
            .tile_mut(Point { x: 6, y: 5 })
            .expect("road tile exists");
        tile.road_structure_id = Some("fixture-roundabout".to_string());

        assert!(access_for_road_point(&candidate.map, Point { x: 6, y: 5 }).is_none());
    }

    #[test]
    fn access_for_road_point_falls_back_to_a_lane_accepted_heading_without_a_connection() {
        let mut candidate = road_at_y5();
        let tile = candidate
            .map
            .tile_mut(Point { x: 4, y: 5 })
            .expect("road tile exists");
        tile.one_way = Some(Heading::East);
        tile.road_connections.clear();

        let access = access_for_road_point(&candidate.map, Point { x: 4, y: 5 })
            .expect("usable road returns access");
        assert_eq!(access.road_point, Point { x: 4, y: 5 });
        assert_eq!(access.preferred_heading, Some(Heading::East));
    }

    #[test]
    fn normalize_legacy_stop_on_unusable_road_derives_access_from_free_neighbor() {
        let mut snapshot = create_initial_snapshot();
        let usable_road = apply_road_mutation(
            &snapshot,
            &RoadMutation::LayRoadLine {
                points: (2..=10).map(|x| Point { x, y: 3 }).collect(),
                preset: RoadPreset::TwoWay,
            },
        )
        .expect("fixture road should apply")
        .snapshot;
        snapshot = usable_road;

        let isolated = snapshot
            .map
            .tile_mut(Point { x: 4, y: 5 })
            .expect("tile exists");
        isolated.kind = "road".to_string();
        isolated.road_connections.clear();

        snapshot.transit.stops.push(Stop {
            id: "stop-001".to_string(),
            kind: BusStopKind::BusStop,
            status: crate::model::TransitNodeStatus::Present,
            position: Point { x: 4, y: 5 },
            platforms: Vec::new(),
            road_access: None,
        });

        let normalized = normalize_snapshot_stops(snapshot);
        let stop = &normalized.transit.stops[0];

        assert_eq!(stop.position, Point { x: 4, y: 4 });
        assert_eq!(
            stop.road_access
                .expect("access derived from free neighbor")
                .road_point,
            Point { x: 4, y: 3 },
        );
    }

    #[test]
    fn rebase_parked_bus_positions_leaves_a_parked_metro_vehicle_untouched() {
        let mut snapshot = create_initial_snapshot();
        let parked_metro = Vehicle {
            id: "metro-001".to_string(),
            mode: TransitMode::Metro,
            line_id: "metro-line-001".to_string(),
            capacity: 90,
            passenger_ids: Vec::new(),
            itinerary_index: 0,
            path_step_index: 0,
            step_progress: 0.0,
            parked_position: Some(Point { x: 4, y: 4 }.into()),
        };
        snapshot.transit.vehicles.push(parked_metro.clone());

        rebase_parked_bus_positions(&mut snapshot, &HashMap::new());

        assert_eq!(
            snapshot.transit.vehicles[0].parked_position,
            Some(Point { x: 4, y: 4 }.into())
        );
    }

    #[test]
    fn rebase_active_trips_repoints_walk_legs_around_moved_legacy_stops() {
        let mut snapshot = create_initial_snapshot();
        let old_a = Point { x: 4, y: 5 };
        let new_a = Point { x: 4, y: 4 };
        let old_b = Point { x: 8, y: 5 };
        let new_b = Point { x: 8, y: 4 };

        let riding_trip = ActiveTrip {
            id: "trip-001".to_string(),
            sim_id: "sim-001".to_string(),
            purpose: TripPurpose::CommuteOutbound,
            origin: old_a,
            destination: Point { x: 8, y: 8 },
            position: old_a.into(),
            status: TripStatus::Waiting,
            deadline: 1_000.0,
            route_plan: Some(RoutePlan {
                legs: vec![
                    RouteLeg {
                        mode: TransitMode::Bus,
                        from: old_a,
                        to: old_b,
                        line_id: Some("route-001".to_string()),
                        service_direction: None,
                        board_itinerary_index: None,
                        alight_itinerary_index: None,
                    },
                    RouteLeg {
                        mode: TransitMode::Walk,
                        from: old_b,
                        to: Point { x: 8, y: 8 },
                        line_id: None,
                        service_direction: None,
                        board_itinerary_index: None,
                        alight_itinerary_index: None,
                    },
                ],
                estimated_seconds: 100.0,
            }),
            current_leg_index: 0,
            patience_remaining: 240.0,
        };
        let planless_trip = ActiveTrip {
            id: "trip-002".to_string(),
            sim_id: "sim-002".to_string(),
            purpose: TripPurpose::CommuteOutbound,
            origin: old_a,
            destination: old_a,
            position: old_a.into(),
            status: TripStatus::Waiting,
            deadline: 1_000.0,
            route_plan: None,
            current_leg_index: 0,
            patience_remaining: 240.0,
        };
        snapshot.active_trips = vec![riding_trip, planless_trip];

        let moves = vec![
            StopMove {
                stop_id: "stop-001".to_string(),
                old_position: old_a,
                new_position: new_a,
                road_point: old_a,
            },
            StopMove {
                stop_id: "stop-002".to_string(),
                old_position: old_b,
                new_position: new_b,
                road_point: old_b,
            },
        ];
        rebase_active_trips(&mut snapshot, &moves);

        let riding = &snapshot.active_trips[0];
        assert_eq!(riding.position, new_a.into());
        let plan = riding
            .route_plan
            .as_ref()
            .expect("riding trip keeps its plan");
        assert_eq!(plan.legs[0].from, new_a);
        assert_eq!(plan.legs[0].to, new_b);
        assert_eq!(plan.legs[1].from, new_b);

        assert_eq!(snapshot.active_trips[1].position, new_a.into());
        assert!(snapshot.active_trips[1].route_plan.is_none());
    }

    /// Item 2 regression: a paused (inactive) route's parked bus must still be
    /// rebased when a road mutation changes its stop's road access. The active
    /// flag controls whether the vehicle resumes service, not whether its parked
    /// position tracks the current access tile.
    #[test]
    fn rebase_parked_bus_positions_rebases_inactive_route_vehicle() {
        let mut snapshot = create_initial_snapshot();
        snapshot = apply_road_mutation(
            &snapshot,
            &RoadMutation::LayRoadLine {
                points: (2..=10).map(|x| Point { x, y: 5 }).collect(),
                preset: RoadPreset::TwoWay,
            },
        )
        .expect("fixture road should apply")
        .snapshot;
        // Lay an alternate road at y=3 so the stop's access can migrate north.
        snapshot = apply_road_mutation(
            &snapshot,
            &RoadMutation::LayRoadLine {
                points: (2..=10).map(|x| Point { x, y: 3 }).collect(),
                preset: RoadPreset::TwoWay,
            },
        )
        .expect("fixture road should apply")
        .snapshot;

        let stop_a = Stop {
            id: "stop-001".to_string(),
            kind: BusStopKind::BusStop,
            status: crate::model::TransitNodeStatus::Present,
            position: Point { x: 4, y: 4 },
            platforms: Vec::new(),
            road_access: Some(StopRoadAccess {
                road_point: Point { x: 4, y: 5 },
                preferred_heading: None,
            }),
        };
        let stop_b = Stop {
            id: "stop-002".to_string(),
            kind: BusStopKind::BusStop,
            status: crate::model::TransitNodeStatus::Present,
            position: Point { x: 8, y: 4 },
            platforms: Vec::new(),
            road_access: Some(StopRoadAccess {
                road_point: Point { x: 8, y: 5 },
                preferred_heading: None,
            }),
        };
        snapshot.transit.stops = vec![stop_a, stop_b];

        let route = Route {
            id: "route-001".to_string(),
            name: "R1".to_string(),
            color: "#f00".to_string(),
            stop_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
            vehicle_ids: vec!["vehicle-001".to_string()],
            active: false, // paused
            pattern: ServicePattern::Loop,
            revision: 0,
            legs: vec![
                service_leg("stop-001", "stop-002"),
                service_leg("stop-002", "stop-001"),
            ],
            path_broken: false,
        };
        snapshot.transit.routes = vec![route];
        snapshot.transit.vehicles = vec![Vehicle {
            id: "vehicle-001".to_string(),
            mode: TransitMode::Bus,
            line_id: "route-001".to_string(),
            capacity: 18,
            passenger_ids: Vec::new(),
            itinerary_index: 0,
            path_step_index: 0,
            step_progress: 0.0,
            parked_position: Some(Point { x: 4, y: 5 }.into()),
        }];

        // Remove the road at (4,5) so stop-001's stored access becomes invalid
        // and `stop_access` re-derives to (4,3).
        let tile = snapshot
            .map
            .tile_mut(Point { x: 4, y: 5 })
            .expect("road tile exists");
        tile.kind = "empty".to_string();
        tile.road_connections.clear();
        tile.one_way = None;

        let mut old_road_points = HashMap::new();
        old_road_points.insert("stop-001".to_string(), Point { x: 4, y: 5 });
        rebase_parked_bus_positions(&mut snapshot, &old_road_points);

        assert_eq!(
            snapshot.transit.vehicles[0].parked_position,
            Some(Point { x: 4, y: 3 }.into()),
        );
    }

    /// Item 3 regression: when two stops share a road-access tile, the vehicle's
    /// itinerary index must identify its associated stop so the first coordinate
    /// match doesn't capture a bus parked for the other stop.
    #[test]
    fn rebase_parked_bus_positions_disambiguates_shared_access_via_itinerary() {
        let mut snapshot = create_initial_snapshot();
        for y in [3, 5, 7] {
            snapshot = apply_road_mutation(
                &snapshot,
                &RoadMutation::LayRoadLine {
                    points: (2..=10).map(|x| Point { x, y }).collect(),
                    preset: RoadPreset::TwoWay,
                },
            )
            .expect("fixture road should apply")
            .snapshot;
        }

        // Two stops on opposite sides of the road at y=5, both accessing (4,5).
        let stop_a = Stop {
            id: "stop-A".to_string(),
            kind: BusStopKind::BusStop,
            status: crate::model::TransitNodeStatus::Present,
            position: Point { x: 4, y: 4 },
            platforms: Vec::new(),
            road_access: Some(StopRoadAccess {
                road_point: Point { x: 4, y: 5 },
                preferred_heading: None,
            }),
        };
        let stop_b = Stop {
            id: "stop-B".to_string(),
            kind: BusStopKind::BusStop,
            status: crate::model::TransitNodeStatus::Present,
            position: Point { x: 4, y: 6 },
            platforms: Vec::new(),
            road_access: Some(StopRoadAccess {
                road_point: Point { x: 4, y: 5 },
                preferred_heading: None,
            }),
        };
        snapshot.transit.stops = vec![stop_a, stop_b];

        let route = Route {
            id: "route-001".to_string(),
            name: "R1".to_string(),
            color: "#f00".to_string(),
            stop_ids: vec!["stop-A".to_string(), "stop-B".to_string()],
            vehicle_ids: vec!["vehicle-001".to_string()],
            active: true,
            pattern: ServicePattern::Loop,
            revision: 0,
            legs: vec![
                service_leg("stop-A", "stop-B"),
                service_leg("stop-B", "stop-A"),
            ],
            path_broken: false,
        };
        snapshot.transit.routes = vec![route];
        // Vehicle parked at the shared tile (4,5) for stop-B (itinerary_index=1).
        snapshot.transit.vehicles = vec![Vehicle {
            id: "vehicle-001".to_string(),
            mode: TransitMode::Bus,
            line_id: "route-001".to_string(),
            capacity: 18,
            passenger_ids: Vec::new(),
            itinerary_index: 1,
            path_step_index: 0,
            step_progress: 0.0,
            parked_position: Some(Point { x: 4, y: 5 }.into()),
        }];

        // Remove the shared road at (4,5) so each stop re-derives to a
        // different tile: stop-A → (4,3) [north], stop-B → (4,7) [south].
        let tile = snapshot
            .map
            .tile_mut(Point { x: 4, y: 5 })
            .expect("road tile exists");
        tile.kind = "empty".to_string();
        tile.road_connections.clear();
        tile.one_way = None;

        let mut old_road_points = HashMap::new();
        old_road_points.insert("stop-A".to_string(), Point { x: 4, y: 5 });
        old_road_points.insert("stop-B".to_string(), Point { x: 4, y: 5 });
        rebase_parked_bus_positions(&mut snapshot, &old_road_points);

        // The bus was parked for stop-B, so it must be rebased to stop-B's new
        // access (4,7), not stop-A's (4,3).
        assert_eq!(
            snapshot.transit.vehicles[0].parked_position,
            Some(Point { x: 4, y: 7 }.into()),
        );
    }
}

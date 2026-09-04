//! Compact presentation projection over the authoritative game snapshot.
//!
//! [`project_update`] composes the crate's existing domain rules (population,
//! platforms, traffic, service metrics) into small, deterministic wire rows so
//! hosts can ship a presentation view instead of full snapshots. It is a pure
//! measurement and migration seam: production hosts still call
//! [`crate::engine::GameEngine`].

use serde::{Deserialize, Serialize};

use crate::building_catalog::building_definition;
use crate::model::{
    GameMap, GameRules, GameSnapshot, MetricsState, PlacedBuilding, Point, RouteLegPath,
    ServiceMetrics, ServicePattern, Station, Stop, TransitMode, TripPosition,
};
use crate::platforms::platform_waiting_occupancy;
use crate::population::{job_occupancy, resident_occupancy};
use crate::service_control::service_metrics_by_line;
use crate::traffic::derive_road_flow;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationUpdate {
    pub scene: Option<PresentationScene>,
    pub frame: PresentationFrame,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationScene {
    pub rules: GameRules,
    pub map: GameMap,
    pub buildings: Vec<PlacedBuilding>,
    pub stops: Vec<Stop>,
    pub stations: Vec<Station>,
    pub routes: Vec<RoutePresentation>,
    pub metro_lines: Vec<MetroLinePresentation>,
}

/// Focused bus-route row: durable line data without the derived
/// `service_metrics` (frame data) and latent `trip`/passenger payloads.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutePresentation {
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
    pub target_headway_seconds: Option<u32>,
}

/// Focused metro-line row: durable line data without the derived
/// `service_metrics` (frame data) and latent `trip`/passenger payloads.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetroLinePresentation {
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
    pub target_headway_seconds: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationFrame {
    pub time: f64,
    pub day: u32,
    pub clock_minutes: u16,
    pub speed: u8,
    pub paused: bool,
    pub budget: i32,
    pub metrics: PresentationMetrics,
    pub population_count: u32,
    pub building_occupancy: Vec<BuildingOccupancyPresentation>,
    pub platform_occupancy: Vec<PlatformOccupancyPresentation>,
    pub traffic_flow: Vec<TrafficFlowPresentation>,
    pub demand_flow: Vec<DemandFlowPresentation>,
    pub vehicles: Vec<VehiclePresentation>,
    pub service_metrics: Vec<ServiceMetricsPresentation>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationMetrics {
    pub late_trips: u32,
    pub unserved_trips: u32,
    pub average_wait_seconds: f64,
    pub state: MetricsState,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildingOccupancyPresentation {
    pub building_id: String,
    pub occupancy: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformOccupancyPresentation {
    pub platform_id: String,
    pub count: u32,
    pub capacity: u16,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficFlowPresentation {
    pub point: Point,
    pub flow: u16,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DemandFlowPresentation {
    pub point: Point,
    pub count: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VehiclePresentation {
    pub id: String,
    pub mode: TransitMode,
    pub line_id: String,
    pub itinerary_index: usize,
    pub path_step_index: usize,
    pub step_progress: f64,
    pub parked_position: Option<TripPosition>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceMetricsPresentation {
    pub line_id: String,
    pub metrics: ServiceMetrics,
}

/// Pure, deterministic projection of a snapshot into presentation rows.
pub fn project_update(snapshot: &GameSnapshot, include_scene: bool) -> PresentationUpdate {
    PresentationUpdate {
        scene: include_scene.then(|| project_scene(snapshot)),
        frame: project_frame(snapshot),
    }
}

fn project_scene(snapshot: &GameSnapshot) -> PresentationScene {
    PresentationScene {
        rules: snapshot.rules.clone(),
        map: snapshot.map.clone(),
        buildings: snapshot.buildings.clone(),
        stops: snapshot.transit.stops.clone(),
        stations: snapshot.transit.stations.clone(),
        routes: snapshot
            .transit
            .routes
            .iter()
            .map(|route| RoutePresentation {
                id: route.id.clone(),
                name: route.name.clone(),
                color: route.color.clone(),
                stop_ids: route.stop_ids.clone(),
                vehicle_ids: route.vehicle_ids.clone(),
                active: route.active,
                pattern: route.pattern,
                revision: route.revision,
                legs: route.legs.clone(),
                path_broken: route.path_broken,
                target_headway_seconds: route.target_headway_seconds,
            })
            .collect(),
        metro_lines: snapshot
            .transit
            .metro_lines
            .iter()
            .map(|line| MetroLinePresentation {
                id: line.id.clone(),
                name: line.name.clone(),
                color: line.color.clone(),
                station_ids: line.station_ids.clone(),
                vehicle_ids: line.vehicle_ids.clone(),
                active: line.active,
                pattern: line.pattern,
                revision: line.revision,
                legs: line.legs.clone(),
                path_broken: line.path_broken,
                target_headway_seconds: line.target_headway_seconds,
            })
            .collect(),
    }
}

fn project_frame(snapshot: &GameSnapshot) -> PresentationFrame {
    PresentationFrame {
        time: snapshot.time,
        day: snapshot.day,
        clock_minutes: snapshot.clock_minutes,
        speed: snapshot.speed,
        paused: snapshot.paused,
        budget: snapshot.budget,
        metrics: PresentationMetrics {
            late_trips: snapshot.metrics.late_trips,
            unserved_trips: snapshot.metrics.unserved_trips,
            average_wait_seconds: snapshot.metrics.average_wait_seconds,
            state: snapshot.metrics.state,
        },
        population_count: snapshot.sims.len() as u32,
        building_occupancy: building_occupancy(snapshot),
        platform_occupancy: platform_waiting_occupancy(snapshot)
            .into_iter()
            .map(
                |(platform_id, (count, capacity))| PlatformOccupancyPresentation {
                    platform_id,
                    count,
                    capacity,
                },
            )
            .collect(),
        traffic_flow: traffic_flow(snapshot),
        demand_flow: demand_flow(snapshot),
        vehicles: snapshot
            .transit
            .vehicles
            .iter()
            .map(|vehicle| VehiclePresentation {
                id: vehicle.id.clone(),
                mode: vehicle.mode,
                line_id: vehicle.line_id.clone(),
                itinerary_index: vehicle.itinerary_index,
                path_step_index: vehicle.path_step_index,
                step_progress: vehicle.step_progress,
                parked_position: vehicle.parked_position.clone(),
            })
            .collect(),
        service_metrics: service_metrics_by_line(snapshot)
            .into_iter()
            .map(|(line_id, metrics)| ServiceMetricsPresentation { line_id, metrics })
            .collect(),
    }
}

fn building_occupancy(snapshot: &GameSnapshot) -> Vec<BuildingOccupancyPresentation> {
    let mut rows = Vec::new();
    for building in &snapshot.buildings {
        let Some(definition) = building_definition(&building.building_type) else {
            continue;
        };
        let occupancy = if definition.resident_capacity > 0 {
            resident_occupancy(snapshot, building)
        } else if definition.job_capacity > 0 {
            job_occupancy(snapshot, building)
        } else {
            continue;
        };
        rows.push(BuildingOccupancyPresentation {
            building_id: building.id.clone(),
            occupancy: occupancy as u32,
        });
    }
    rows.sort_by(|left, right| left.building_id.cmp(&right.building_id));
    rows
}

fn traffic_flow(snapshot: &GameSnapshot) -> Vec<TrafficFlowPresentation> {
    let mut rows = derive_road_flow(snapshot)
        .into_iter()
        .filter(|(point, _)| {
            snapshot
                .map
                .tile(*point)
                .is_some_and(|tile| tile.kind == "road")
        })
        .map(|(point, flow)| TrafficFlowPresentation { point, flow })
        .collect::<Vec<_>>();
    rows.sort_by_key(|row| (row.point.y, row.point.x));
    rows
}

fn demand_flow(snapshot: &GameSnapshot) -> Vec<DemandFlowPresentation> {
    let mut demand = std::collections::BTreeMap::<(i32, i32), u32>::new();
    for trip in &snapshot.active_trips {
        let count = demand
            .entry((trip.destination.y, trip.destination.x))
            .or_default();
        *count = count.saturating_add(1);
    }
    demand
        .into_iter()
        .map(|((y, x), count)| DemandFlowPresentation {
            point: Point { x, y },
            count,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::building_catalog::BUILDINGS;
    use crate::engine::GameEngine;
    use crate::intent::{GameIntent, RoadPreset};
    use crate::model::{
        ActiveTrip, BusStopKind, Heading, MovementKind, PathGeometry, Platform, PrivateCarTrip,
        RoadPathStep, RouteLeg, RoutePlan, ServiceDirection, Sim, Stop, TransitNodeStatus,
        TransitPath, TripPurpose, TripStatus, Vehicle, WorkerProfile,
    };
    use crate::platforms::on_platform_trip_ids;
    use crate::state::create_initial_snapshot;
    use std::collections::BTreeMap;

    fn sim(id: &str, home: Point, workplace: Option<Point>) -> Sim {
        Sim {
            id: id.to_string(),
            home,
            position: home,
            worker_profile: WorkerProfile::Worker,
            shift_template: None,
            workplace,
            commute_day: 0,
            outbound_resolved_today: false,
            outbound_arrived_today: false,
            return_resolved_today: false,
            returned_home_today: false,
        }
    }

    fn building(id: &str, building_type: &str) -> PlacedBuilding {
        PlacedBuilding {
            id: id.to_string(),
            building_type: building_type.to_string(),
            origin: Point::from((4, 4)),
            rotation: 0,
            occupied_tiles: vec![Point::from((4, 4)), Point::from((5, 4))],
            placed_at: 0.0,
            transit_node_id: None,
        }
    }

    fn walking_trip(id: &str, destination: Point) -> ActiveTrip {
        ActiveTrip {
            id: id.to_string(),
            sim_id: format!("sim-{id}"),
            purpose: TripPurpose::CommuteOutbound,
            origin: Point::from((0, 0)),
            destination,
            position: Point::from((0, 0)).into(),
            status: TripStatus::Walking,
            deadline: 9_999.0,
            route_plan: None,
            current_leg_index: 0,
            patience_remaining: 100.0,
            current_leg_wait_seconds: 0.0,
            private_car_trip: None,
        }
    }

    fn car_trip(id: &str, path_points: &[Point]) -> ActiveTrip {
        ActiveTrip {
            id: id.to_string(),
            sim_id: format!("sim-{id}"),
            purpose: TripPurpose::CommuteOutbound,
            origin: Point::from((0, 0)),
            destination: Point::from((0, 0)),
            position: Point::from((0, 0)).into(),
            status: TripStatus::Driving,
            deadline: 9_999.0,
            route_plan: None,
            current_leg_index: 0,
            patience_remaining: 100.0,
            current_leg_wait_seconds: 0.0,
            private_car_trip: Some(PrivateCarTrip {
                path: TransitPath::Road {
                    steps: path_points
                        .iter()
                        .map(|point| RoadPathStep {
                            position: *point,
                            entering_heading: Heading::East,
                            leaving_heading: Heading::East,
                            movement: MovementKind::Straight,
                            geometry: PathGeometry::Line {
                                from: TripPosition::from(*point),
                                to: TripPosition::from(*point),
                            },
                            travel_seconds: 1.0,
                        })
                        .collect(),
                    total_travel_seconds: 1.0,
                },
                arrival_time: 0.0,
            }),
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
    fn resident_projection_matches_resident_occupancy() {
        let mut snapshot = create_initial_snapshot();
        let building = building("building-001", "smallHouse");
        snapshot.buildings.push(building.clone());
        snapshot.sims = vec![
            sim("sim-a", Point::from((4, 4)), None),
            sim("sim-b", Point::from((5, 4)), None),
            sim("sim-c", Point::from((9, 9)), None),
        ];

        let frame = project_update(&snapshot, false).frame;
        assert_eq!(
            frame.building_occupancy,
            vec![BuildingOccupancyPresentation {
                building_id: "building-001".to_string(),
                occupancy: resident_occupancy(&snapshot, &building) as u32,
            }]
        );
        assert_eq!(frame.building_occupancy[0].occupancy, 2);
    }

    #[test]
    fn job_building_projection_counts_workplace_membership() {
        let mut snapshot = create_initial_snapshot();
        snapshot
            .buildings
            .push(building("building-job", "supermarket"));
        snapshot.sims = vec![
            sim("sim-a", Point::from((0, 0)), Some(Point::from((5, 4)))),
            sim("sim-b", Point::from((0, 0)), Some(Point::from((9, 9)))),
            sim("sim-c", Point::from((0, 0)), None),
        ];

        let frame = project_update(&snapshot, false).frame;
        assert_eq!(
            frame.building_occupancy,
            vec![BuildingOccupancyPresentation {
                building_id: "building-job".to_string(),
                occupancy: 1,
            }]
        );
    }

    #[test]
    fn building_catalog_has_no_mixed_resident_and_job_capacity() {
        for definition in BUILDINGS {
            assert!(
                !(definition.resident_capacity > 0 && definition.job_capacity > 0),
                "{} mixes resident and job capacity",
                definition.building_type
            );
        }
    }

    #[test]
    fn platform_crowding_includes_overflow_while_boarding_admission_truncates() {
        let point = Point::from((5, 5));
        let mut snapshot = create_initial_snapshot();
        snapshot.transit.stops.push(Stop {
            id: "stop-001".to_string(),
            kind: BusStopKind::BusStop,
            status: TransitNodeStatus::Present,
            position: point,
            platforms: vec![Platform {
                id: "stop-001-p0".to_string(),
                label: "A".to_string(),
                capacity: 1,
                route_ids: vec!["route-001".to_string()],
            }],
            road_access: None,
        });
        snapshot.active_trips = vec![
            waiting_trip_for_line("trip-a", point, "route-001", 10.0),
            waiting_trip_for_line("trip-b", point, "route-001", 20.0),
        ];

        let frame = project_update(&snapshot, false).frame;
        assert_eq!(
            frame.platform_occupancy,
            vec![PlatformOccupancyPresentation {
                platform_id: "stop-001-p0".to_string(),
                count: 2,
                capacity: 1,
            }]
        );
        assert_eq!(
            on_platform_trip_ids(&snapshot).len(),
            1,
            "boarding admission still truncates at capacity"
        );
    }

    #[test]
    fn traffic_filters_non_road_rows_and_sorts_by_y_then_x() {
        let mut snapshot = create_initial_snapshot();
        for point in [Point::from((3, 2)), Point::from((2, 3))] {
            let tile = snapshot.map.tile_mut(point).expect("in-bounds tile");
            tile.kind = "road".to_string();
        }
        snapshot.active_trips = vec![
            car_trip("car-a", &[Point::from((2, 3))]),
            car_trip("car-b", &[Point::from((3, 2))]),
            car_trip("car-c", &[Point::from((5, 5))]),
        ];

        let frame = project_update(&snapshot, false).frame;
        assert_eq!(
            frame.traffic_flow,
            vec![
                TrafficFlowPresentation {
                    point: Point::from((3, 2)),
                    flow: 1,
                },
                TrafficFlowPresentation {
                    point: Point::from((2, 3)),
                    flow: 1,
                },
            ]
        );
    }

    #[test]
    fn demand_aggregates_duplicate_destinations_and_sorts_by_y_then_x() {
        let mut snapshot = create_initial_snapshot();
        snapshot.active_trips = vec![
            walking_trip("trip-a", Point::from((2, 3))),
            walking_trip("trip-b", Point::from((2, 3))),
            walking_trip("trip-c", Point::from((3, 2))),
        ];

        let frame = project_update(&snapshot, false).frame;
        assert_eq!(
            frame.demand_flow,
            vec![
                DemandFlowPresentation {
                    point: Point::from((3, 2)),
                    count: 1,
                },
                DemandFlowPresentation {
                    point: Point::from((2, 3)),
                    count: 2,
                },
            ]
        );
    }

    #[test]
    fn presentation_json_contains_no_sims_active_trips_route_plan_private_car_trip_or_passenger_ids(
    ) {
        let mut snapshot = create_initial_snapshot();
        snapshot
            .buildings
            .push(building("building-001", "smallHouse"));
        snapshot.sims = vec![sim("sim-a", Point::from((4, 4)), None)];
        snapshot.active_trips = vec![car_trip("car-a", &[Point::from((4, 8))])];
        snapshot.transit.vehicles.push(Vehicle {
            id: "vehicle-001".to_string(),
            mode: TransitMode::Bus,
            line_id: "route-001".to_string(),
            capacity: 18,
            passenger_ids: vec!["sim-a".to_string()],
            itinerary_index: 0,
            path_step_index: 0,
            step_progress: 0.0,
            parked_position: None,
        });

        let value = serde_json::to_value(project_update(&snapshot, true)).unwrap();
        let mut keys = Vec::new();
        collect_keys(&value, &mut keys);
        for forbidden in [
            "sims",
            "activeTrips",
            "routePlan",
            "privateCarTrip",
            "passengerIds",
        ] {
            assert!(
                !keys.iter().any(|key| key == forbidden),
                "presentation JSON contains forbidden key {forbidden}"
            );
        }
    }

    fn collect_keys(value: &serde_json::Value, keys: &mut Vec<String>) {
        match value {
            serde_json::Value::Object(map) => {
                for (key, child) in map {
                    keys.push(key.clone());
                    collect_keys(child, keys);
                }
            }
            serde_json::Value::Array(items) => {
                for item in items {
                    collect_keys(item, keys);
                }
            }
            _ => {}
        }
    }

    #[test]
    fn vehicle_cursor_fields_survive() {
        let mut snapshot = create_initial_snapshot();
        snapshot.transit.vehicles.push(Vehicle {
            id: "vehicle-001".to_string(),
            mode: TransitMode::Metro,
            line_id: "metro-001".to_string(),
            capacity: 80,
            passenger_ids: vec!["sim-a".to_string()],
            itinerary_index: 2,
            path_step_index: 3,
            step_progress: 0.5,
            parked_position: Some(TripPosition { x: 1.5, y: 2.5 }),
        });

        let frame = project_update(&snapshot, false).frame;
        assert_eq!(
            frame.vehicles,
            vec![VehiclePresentation {
                id: "vehicle-001".to_string(),
                mode: TransitMode::Metro,
                line_id: "metro-001".to_string(),
                itinerary_index: 2,
                path_step_index: 3,
                step_progress: 0.5,
                parked_position: Some(TripPosition { x: 1.5, y: 2.5 }),
            }]
        );
    }

    #[test]
    fn service_metrics_match_engine_snapshot_output() {
        let mut engine = GameEngine::new();
        let laid = engine.dispatch(GameIntent::LayRoadLine {
            points: (2..=12).map(|x| Point { x, y: 5 }).collect(),
            preset: RoadPreset::TwoWay,
        });
        assert!(laid.applied, "fixture road should apply: {laid:?}");
        for point in [Point { x: 2, y: 4 }, Point { x: 10, y: 4 }] {
            let added = engine.dispatch(GameIntent::AddBusStop { point });
            assert!(added.applied, "fixture stop should apply: {added:?}");
        }
        let created = engine.dispatch(GameIntent::CreateRoute {
            mode: TransitMode::Bus,
            pattern: ServicePattern::Loop,
            waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
        });
        assert!(created.applied, "fixture route should apply: {created:?}");

        let snapshot = engine.snapshot();
        let frame = project_update(&snapshot, false).frame;
        let projected: BTreeMap<String, ServiceMetrics> = frame
            .service_metrics
            .into_iter()
            .map(|row| (row.line_id, row.metrics))
            .collect();
        let durable: BTreeMap<String, ServiceMetrics> =
            snapshot
                .transit
                .routes
                .iter()
                .filter_map(|route| route.service_metrics.clone().map(|m| (route.id.clone(), m)))
                .chain(
                    snapshot.transit.metro_lines.iter().filter_map(|line| {
                        line.service_metrics.clone().map(|m| (line.id.clone(), m))
                    }),
                )
                .collect();

        assert!(!projected.is_empty(), "fixture route must derive metrics");
        assert_eq!(projected, durable);
    }

    #[test]
    fn frame_has_no_row_per_latent_sim_growth() {
        let small = fixture_with_sims(0);
        let large = fixture_with_sims(200_000);

        let small_frame = project_update(&small, false).frame;
        let large_frame = project_update(&large, false).frame;

        assert!(small_frame.building_occupancy.is_empty());
        assert!(large_frame.building_occupancy.is_empty());
        assert_eq!(small_frame.demand_flow.len(), large_frame.demand_flow.len());

        let small_bytes = serde_json::to_vec(&small_frame).unwrap().len();
        let large_bytes = serde_json::to_vec(&large_frame).unwrap().len();
        assert!(large_bytes.saturating_sub(small_bytes) < 64);
    }

    fn fixture_with_sims(count: usize) -> GameSnapshot {
        let mut snapshot = crate::state::create_initial_snapshot();
        snapshot.buildings.clear();
        snapshot.active_trips.clear();
        snapshot.transit.stops.clear();
        snapshot.transit.stations.clear();
        snapshot.transit.routes.clear();
        snapshot.transit.metro_lines.clear();
        snapshot.transit.vehicles.clear();
        snapshot.sims = (0..count).map(sim_fixture).collect();
        snapshot
    }

    fn sim_fixture(index: usize) -> Sim {
        let home = Point { x: 1, y: 1 };
        Sim {
            id: format!("sim-{index:06}"),
            home,
            position: home,
            worker_profile: WorkerProfile::Worker,
            shift_template: Some("standard".to_string()),
            workplace: None,
            commute_day: 0,
            outbound_resolved_today: false,
            outbound_arrived_today: false,
            return_resolved_today: false,
            returned_home_today: false,
        }
    }
}

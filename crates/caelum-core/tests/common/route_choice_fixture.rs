//! Shared mixed/stress workload for the HPA-348 route-choice batching tests.
//!
//! [`mixed_peak_snapshot`] authors one Standard blank-grid city — a two-way
//! road corridor, a metro track corridor, three zoned areas with real
//! buildings, `bus_route_count` four-stop bus loops plus one four-station
//! metro loop — and populates exactly `count` same-time canonical Workers on
//! real building tiles. The base workload is `(count, 1)` (1 bus + 1 metro =
//! 2 services); the transit-stress workload is `(count, 7)` (7 bus + 1 metro
//! = 8 services). Every route has four waypoints.

use caelum_core::commute::{is_day_off, shift_template_for_id};
use caelum_core::ids::entity_id;
use caelum_core::model::{
    CitizenRoutine, GameSnapshot, Point, ScheduledActivity, ScheduledActivityKind, ServicePattern,
    Sim, TransitMode,
};
use caelum_core::{GameEngine, GameIntent, SandboxCreationRequest};

fn apply(engine: &mut GameEngine, intent: GameIntent, label: &str) {
    let result = engine.dispatch(intent);
    assert!(result.applied, "{label} must apply: {result:?}");
    assert!(result.rejection.is_none(), "{label} rejected: {result:?}");
}

fn stop_id_at(engine: &GameEngine, point: Point) -> String {
    engine
        .snapshot()
        .transit
        .stops
        .iter()
        .find(|stop| stop.position == point)
        .unwrap_or_else(|| panic!("bus stop at {point:?} must appear in the snapshot"))
        .id
        .clone()
}

fn station_id_at(engine: &GameEngine, point: Point) -> String {
    engine
        .snapshot()
        .transit
        .stations
        .iter()
        .find(|station| station.position == point)
        .unwrap_or_else(|| panic!("metro station at {point:?} must appear in the snapshot"))
        .id
        .clone()
}

/// Author the fixed mixed peak city and populate exactly `count` same-time
/// canonical Workers cycling independently through real home/job tiles.
pub fn mixed_peak_snapshot(count: usize, bus_route_count: usize) -> GameSnapshot {
    let mut engine = GameEngine::from_sandbox_request(SandboxCreationRequest {
        template_id: "blankGrid".to_string(),
        economy_preset: "standard".to_string(),
        starting_capital: Some(1_000_000.0),
        demand_multiplier: Some(1.0),
    })
    .expect("route-choice fixture must construct");

    for x in 1..=26 {
        apply(
            &mut engine,
            GameIntent::LayRoad {
                point: (x, 5).into(),
            },
            "road corridor",
        );
    }
    for x in 1..=26 {
        apply(
            &mut engine,
            GameIntent::LayTrack {
                point: (x, 9).into(),
            },
            "track corridor",
        );
    }

    apply(
        &mut engine,
        GameIntent::PaintAreaRectangle {
            area: "residential".to_string(),
            start: (3, 6).into(),
            end: (19, 6).into(),
        },
        "residential area",
    );
    apply(
        &mut engine,
        GameIntent::PaintAreaRectangle {
            area: "commercial".to_string(),
            start: (22, 6).into(),
            end: (23, 7).into(),
        },
        "commercial area",
    );
    apply(
        &mut engine,
        GameIntent::PaintAreaRectangle {
            area: "industrial".to_string(),
            start: (21, 3).into(),
            end: (23, 4).into(),
        },
        "industrial area",
    );

    for origin in [(3, 6), (8, 6), (13, 6), (18, 6)] {
        apply(
            &mut engine,
            GameIntent::PlaceBuilding {
                building_type: "smallHouse".to_string(),
                origin: origin.into(),
                rotation: 0,
            },
            "small house",
        );
    }
    apply(
        &mut engine,
        GameIntent::PlaceBuilding {
            building_type: "supermarket".to_string(),
            origin: (22, 6).into(),
            rotation: 0,
        },
        "supermarket",
    );
    apply(
        &mut engine,
        GameIntent::PlaceBuilding {
            building_type: "factory".to_string(),
            origin: (21, 3).into(),
            rotation: 0,
        },
        "factory",
    );

    let stop_ids = [(2, 4), (9, 4), (17, 4), (25, 4)]
        .into_iter()
        .map(|point| {
            apply(
                &mut engine,
                GameIntent::AddBusStop {
                    point: point.into(),
                },
                "bus stop",
            );
            stop_id_at(&engine, point.into())
        })
        .collect::<Vec<_>>();
    for _ in 0..bus_route_count {
        apply(
            &mut engine,
            GameIntent::CreateRoute {
                mode: TransitMode::Bus,
                pattern: ServicePattern::Loop,
                waypoint_ids: stop_ids.clone(),
            },
            "bus route",
        );
        let route_id = engine
            .snapshot()
            .transit
            .routes
            .last()
            .expect("created bus route must be the last route")
            .id
            .clone();
        apply(
            &mut engine,
            GameIntent::AssignVehicle {
                mode: "bus".to_string(),
                line_id: route_id,
            },
            "bus vehicle",
        );
    }

    let station_ids = [(2, 9), (9, 9), (17, 9), (25, 9)]
        .into_iter()
        .map(|point| {
            apply(
                &mut engine,
                GameIntent::AddMetroStation {
                    point: point.into(),
                },
                "metro station",
            );
            station_id_at(&engine, point.into())
        })
        .collect::<Vec<_>>();
    apply(
        &mut engine,
        GameIntent::CreateRoute {
            mode: TransitMode::Metro,
            pattern: ServicePattern::Loop,
            waypoint_ids: station_ids,
        },
        "metro line",
    );
    let metro_id = engine
        .snapshot()
        .transit
        .metro_lines
        .last()
        .expect("created metro line must be the last line")
        .id
        .clone();
    apply(
        &mut engine,
        GameIntent::AssignVehicle {
            mode: "metro".to_string(),
            line_id: metro_id,
        },
        "metro vehicle",
    );

    let mut snapshot = engine.snapshot();
    let home_tiles = snapshot
        .buildings
        .iter()
        .filter(|building| building.building_type == "smallHouse")
        .flat_map(|building| building.occupied_tiles.iter().copied())
        .collect::<Vec<_>>();
    let job_tiles = snapshot
        .buildings
        .iter()
        .filter(|building| matches!(building.building_type.as_str(), "supermarket" | "factory"))
        .flat_map(|building| building.occupied_tiles.iter().copied())
        .collect::<Vec<_>>();
    assert!(!home_tiles.is_empty() && !job_tiles.is_empty());

    let mut sims = Vec::with_capacity(count);
    let mut ordinal = 0usize;
    while sims.len() < count {
        ordinal += 1;
        let id = entity_id("sim", ordinal);
        if shift_template_for_id(&id).is_none() || is_day_off(&id, 0) {
            continue;
        }
        let index = sims.len();
        let home = home_tiles[index % home_tiles.len()];
        let destination = job_tiles[index % job_tiles.len()];
        sims.push(Sim {
            id,
            home,
            position: home,
            routine: CitizenRoutine::Worker {
                shift_template: "standard".to_string(),
                workplace: Some(destination),
            },
            next_activity: Some(ScheduledActivity {
                kind: ScheduledActivityKind::DailyRoutine,
                due_time: 300.0,
            }),
        });
    }

    snapshot.day = 0;
    snapshot.time = 0.0;
    snapshot.paused = true;
    snapshot.speed = 1;
    snapshot.active_trips.clear();
    snapshot.sims = sims;
    snapshot
}

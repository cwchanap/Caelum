use caelum_core::commute::departure_minute_for_sim;
use caelum_core::model::{GameSnapshot, Point, TripPurpose, WorkerProfile};
use caelum_core::{clock, GameEngine, GameIntent};

fn scheduled_time_seconds(day: u32, minute: u16) -> f64 {
    f64::from(day) * clock::GAME_DAY_SECONDS
        + (f64::from(minute) / f64::from(clock::MINUTES_PER_DAY)) * clock::GAME_DAY_SECONDS
}

fn zoned_engine(building_type: &str, origin: (i32, i32), end: (i32, i32)) -> GameEngine {
    let mut engine = GameEngine::new();
    assert!(
        engine
            .dispatch(GameIntent::PaintAreaRectangle {
                area: "residential".to_string(),
                start: origin.into(),
                end: end.into(),
            })
            .applied
    );
    assert!(
        engine
            .dispatch(GameIntent::PlaceBuilding {
                building_type: building_type.to_string(),
                origin: origin.into(),
                rotation: 0,
            })
            .applied
    );
    engine
}

fn assigned_workplace_engine() -> GameEngine {
    let mut engine = zoned_engine("smallHouse", (2, 3), (3, 3));
    assert!(
        engine
            .dispatch(GameIntent::PaintAreaRectangle {
                area: "commercial".to_string(),
                start: (4, 3).into(),
                end: (5, 4).into(),
            })
            .applied
    );
    assert!(
        engine
            .dispatch(GameIntent::PlaceBuilding {
                building_type: "supermarket".to_string(),
                origin: (4, 3).into(),
                rotation: 0,
            })
            .applied
    );
    assert!(
        engine
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );
    engine
}

fn active_trip_identity(state: &GameSnapshot) -> Vec<(String, String, TripPurpose)> {
    state
        .active_trips
        .iter()
        .map(|trip| (trip.id.clone(), trip.sim_id.clone(), trip.purpose))
        .collect()
}

#[test]
fn demolishing_employed_house_removes_residents_and_refills_surplus_workers() {
    let mut engine = GameEngine::new();
    for (area, start, end) in [
        ("residential", (2, 3), (3, 3)),
        ("residential", (2, 7), (3, 7)),
        ("commercial", (8, 3), (9, 4)),
    ] {
        assert!(
            engine
                .dispatch(GameIntent::PaintAreaRectangle {
                    area: area.to_string(),
                    start: start.into(),
                    end: end.into(),
                })
                .applied
        );
    }
    assert!(
        engine
            .dispatch(GameIntent::PlaceBuilding {
                building_type: "smallHouse".to_string(),
                origin: (2, 3).into(),
                rotation: 0,
            })
            .applied
    );
    assert!(
        engine
            .dispatch(GameIntent::PlaceBuilding {
                building_type: "smallHouse".to_string(),
                origin: (2, 7).into(),
                rotation: 0,
            })
            .applied
    );
    assert!(
        engine
            .dispatch(GameIntent::PlaceBuilding {
                building_type: "supermarket".to_string(),
                origin: (8, 3).into(),
                rotation: 0,
            })
            .applied
    );
    assert!(
        engine
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );
    engine.tick(600.0);
    let filled = engine.snapshot();
    assert_eq!(filled.sims.len(), 8);

    // Task 4 owns finite workplace allocation. Set the intended precondition
    // directly: the four residents of the house being demolished are employed,
    // while the four residents in the surviving house are unassigned surplus.
    let first_house_tiles = filled
        .buildings
        .iter()
        .find(|building| building.origin == Point { x: 2, y: 3 })
        .expect("first house")
        .occupied_tiles
        .clone();
    let second_house_tiles = filled
        .buildings
        .iter()
        .find(|building| building.origin == Point { x: 2, y: 7 })
        .expect("second house")
        .occupied_tiles
        .clone();
    let supermarket_tiles = filled
        .buildings
        .iter()
        .find(|building| building.building_type == "supermarket")
        .expect("supermarket")
        .occupied_tiles
        .clone();
    let supermarket_tile = supermarket_tiles[0];
    let mut prepared = filled;
    for sim in &mut prepared.sims {
        if first_house_tiles.contains(&sim.home) {
            sim.workplace = Some(supermarket_tile);
        } else if second_house_tiles.contains(&sim.home) {
            sim.workplace = None;
        }
    }
    engine = GameEngine::from_snapshot(prepared).expect("prepared occupancy snapshot");

    let removed = engine.dispatch(GameIntent::RemoveAtTile {
        point: (2, 3).into(),
    });
    assert!(removed.applied, "{removed:?}");
    assert_eq!(engine.snapshot().sims.len(), 4);
    assert!(engine.snapshot().sims.iter().all(|sim| {
        second_house_tiles.contains(&sim.home) && sim.worker_profile == WorkerProfile::Worker
    }));
    assert_eq!(
        engine
            .snapshot()
            .sims
            .iter()
            .filter(|sim| {
                sim.workplace
                    .is_some_and(|workplace| supermarket_tiles.contains(&workplace))
            })
            .count(),
        4
    );
}

#[test]
fn demolishing_housing_runs_one_refill_pass_after_over_capacity_first_workplace() {
    let mut engine = GameEngine::new();
    for (area, start, end) in [
        ("residential", (2, 3), (3, 3)),
        ("residential", (2, 7), (3, 7)),
        ("commercial", (8, 3), (9, 4)),
        ("commercial", (8, 5), (10, 6)),
    ] {
        assert!(
            engine
                .dispatch(GameIntent::PaintAreaRectangle {
                    area: area.to_string(),
                    start: start.into(),
                    end: end.into(),
                })
                .applied
        );
    }
    for (building_type, origin) in [
        ("smallHouse", (2, 3)),
        ("smallHouse", (2, 7)),
        ("supermarket", (8, 3)),
        ("cinema", (8, 5)),
    ] {
        let placed = engine.dispatch(GameIntent::PlaceBuilding {
            building_type: building_type.to_string(),
            origin: origin.into(),
            rotation: 0,
        });
        assert!(placed.applied, "{building_type}: {placed:?}");
    }
    assert!(
        engine
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );
    engine.tick(600.0);
    let filled = engine.snapshot();
    assert_eq!(filled.sims.len(), 8);

    let first_workplace_tiles = filled
        .buildings
        .iter()
        .find(|building| building.building_type == "supermarket")
        .expect("first workplace")
        .occupied_tiles
        .clone();
    let first_house_tiles = filled
        .buildings
        .iter()
        .find(|building| building.origin == Point { x: 2, y: 3 })
        .expect("first house")
        .occupied_tiles
        .clone();
    let second_workplace_tiles = filled
        .buildings
        .iter()
        .find(|building| building.building_type == "cinema")
        .expect("second workplace")
        .occupied_tiles
        .clone();
    assert_eq!(first_workplace_tiles.len(), 4);
    assert_eq!(second_workplace_tiles.len(), 6);

    // Deliberately make the first workplace over capacity. The first house's
    // residents occupy its four valid slots; the surviving house's residents
    // are stale over-capacity assignments. A housing demolition must remove
    // the first four residents, then perform exactly one refill pass: the
    // survivors should take the first workplace's four slots rather than being
    // diverted to the second workplace by an earlier pass.
    let mut prepared = filled;
    for sim in &mut prepared.sims {
        sim.workplace = Some(first_workplace_tiles[0]);
    }
    let mut expected = prepared.clone();
    let first_house_id = expected
        .buildings
        .iter()
        .find(|building| building.origin == Point { x: 2, y: 3 })
        .expect("first house")
        .id
        .clone();
    expected
        .buildings
        .retain(|building| building.id != first_house_id);
    expected
        .sims
        .retain(|sim| !first_house_tiles.contains(&sim.home));
    caelum_core::buildings::assign_workplaces(&mut expected);
    let expected_workplaces: Vec<_> = expected
        .sims
        .iter()
        .filter_map(|sim| sim.workplace)
        .collect();
    engine = GameEngine::from_snapshot(prepared).expect("prepared over-capacity snapshot");

    let removed = engine.dispatch(GameIntent::RemoveAtTile {
        point: (2, 3).into(),
    });
    assert!(removed.applied, "{removed:?}");
    assert_eq!(engine.snapshot().sims.len(), 4);
    assert_eq!(
        engine
            .snapshot()
            .sims
            .iter()
            .filter_map(|sim| sim.workplace)
            .collect::<Vec<_>>(),
        expected_workplaces,
        "survivors match one post-removal assignment pass"
    );
    assert!(engine.snapshot().sims.iter().all(|sim| {
        sim.workplace
            .is_some_and(|workplace| !second_workplace_tiles.contains(&workplace))
    }));
}

#[test]
fn two_small_houses_and_supermarket_assign_only_four_workers() {
    let mut engine = GameEngine::new();
    for (area, start, end) in [
        ("residential", (2, 3), (3, 3)),
        ("residential", (2, 7), (3, 7)),
        ("commercial", (8, 3), (9, 4)),
    ] {
        assert!(
            engine
                .dispatch(GameIntent::PaintAreaRectangle {
                    area: area.to_string(),
                    start: start.into(),
                    end: end.into(),
                })
                .applied
        );
    }
    for origin in [(2, 3), (2, 7)] {
        assert!(
            engine
                .dispatch(GameIntent::PlaceBuilding {
                    building_type: "smallHouse".to_string(),
                    origin: origin.into(),
                    rotation: 0,
                })
                .applied
        );
    }
    assert!(
        engine
            .dispatch(GameIntent::PlaceBuilding {
                building_type: "supermarket".to_string(),
                origin: (8, 3).into(),
                rotation: 0,
            })
            .applied
    );
    assert!(
        engine
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );

    engine.tick(600.0);
    let snapshot = engine.snapshot();
    let workers: Vec<_> = snapshot
        .sims
        .iter()
        .filter(|sim| sim.worker_profile == WorkerProfile::Worker)
        .collect();
    assert_eq!(
        workers.len(),
        8,
        "fixture must contain more than four workers"
    );

    let supermarket_tiles = snapshot
        .buildings
        .iter()
        .find(|building| building.building_type == "supermarket")
        .expect("supermarket")
        .occupied_tiles
        .clone();
    let assigned: Vec<_> = workers.iter().filter_map(|sim| sim.workplace).collect();
    assert_eq!(assigned.len(), 4);
    assert_eq!(assigned, supermarket_tiles);
}

#[test]
fn factory_assigns_six_workers_when_more_than_capacity() {
    let mut engine = zoned_engine("largeHouse", (2, 3), (4, 4));
    assert!(
        engine
            .dispatch(GameIntent::PaintAreaRectangle {
                area: "industrial".to_string(),
                start: (8, 3).into(),
                end: (10, 4).into(),
            })
            .applied
    );
    assert!(
        engine
            .dispatch(GameIntent::PlaceBuilding {
                building_type: "factory".to_string(),
                origin: (8, 3).into(),
                rotation: 0,
            })
            .applied
    );
    assert!(
        engine
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );

    engine.tick(600.0);
    let snapshot = engine.snapshot();
    let workers: Vec<_> = snapshot
        .sims
        .iter()
        .filter(|sim| sim.worker_profile == WorkerProfile::Worker)
        .collect();
    assert_eq!(
        workers.len(),
        9,
        "fixture must contain more than six workers"
    );

    let factory_tiles = snapshot
        .buildings
        .iter()
        .find(|building| building.building_type == "factory")
        .expect("factory")
        .occupied_tiles
        .clone();
    let assigned: Vec<_> = workers.iter().filter_map(|sim| sim.workplace).collect();
    assert_eq!(assigned.len(), 6);
    assert_eq!(assigned, factory_tiles);
}

#[test]
fn sandbox_move_ins_start_on_first_running_tick() {
    let mut engine = zoned_engine("smallHouse", (2, 3), (3, 3));

    assert!(engine.snapshot().paused);
    assert!(engine.snapshot().sims.is_empty());

    assert!(
        engine
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );
    let _first_tick = engine.tick(1.0);

    assert_eq!(engine.snapshot().sims.len(), 1);
    assert_eq!(engine.snapshot().sims[0].id, "sim-001");
}

#[test]
fn sandbox_move_ins_are_partition_independent_for_small_house() {
    let mut coarse = zoned_engine("smallHouse", (2, 3), (3, 3));
    let mut fine = zoned_engine("smallHouse", (2, 3), (3, 3));
    for engine in [&mut coarse, &mut fine] {
        assert!(
            engine
                .dispatch(GameIntent::SetPaused { paused: false })
                .applied
        );
    }

    coarse.tick(150.0);
    let coarse_snapshot = coarse.snapshot();
    let _ = fine.tick(50.0);
    let _ = fine.tick(50.0);
    fine.tick(50.0);
    let fine_snapshot = fine.snapshot();

    assert_eq!(coarse_snapshot.sims.len(), 4);
    assert_eq!(coarse_snapshot.sims, fine_snapshot.sims);
}

#[test]
fn sandbox_move_ins_preserve_commute_set_across_coarse_and_fine_ticks() {
    let mut coarse = assigned_workplace_engine();
    let mut fine = assigned_workplace_engine();

    coarse.tick(900.0);
    let coarse_snapshot = coarse.snapshot();
    fine.tick(0.0);
    let mut fine_snapshot = fine.snapshot();
    for _ in 0..18 {
        fine.tick(50.0);
        fine_snapshot = fine.snapshot();
    }

    assert_eq!(coarse_snapshot.sims, fine_snapshot.sims);
    assert_eq!(
        active_trip_identity(&coarse_snapshot),
        active_trip_identity(&fine_snapshot)
    );
    assert_eq!(
        (
            coarse_snapshot.metrics.completed_trips,
            coarse_snapshot.metrics.late_trips,
            coarse_snapshot.metrics.unserved_trips,
        ),
        (
            fine_snapshot.metrics.completed_trips,
            fine_snapshot.metrics.late_trips,
            fine_snapshot.metrics.unserved_trips,
        )
    );
    assert_eq!(
        coarse_snapshot
            .metrics
            .trip_outcomes
            .iter()
            .map(|outcome| (outcome.outcome, outcome.wait_seconds))
            .collect::<Vec<_>>(),
        fine_snapshot
            .metrics
            .trip_outcomes
            .iter()
            .map(|outcome| (outcome.outcome, outcome.wait_seconds))
            .collect::<Vec<_>>()
    );
}

#[test]
fn sandbox_large_house_fills_to_capacity_and_stops() {
    let mut engine = zoned_engine("largeHouse", (2, 3), (4, 4));
    assert!(
        engine
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );

    engine.tick(600.0);
    let filled = engine.snapshot();
    assert_eq!(filled.sims.len(), 10);

    engine.tick(600.0);
    let later = engine.snapshot();
    assert_eq!(later.sims.len(), 10);
}

#[test]
fn move_in_after_departure_skips_today_but_commutes_next_day() {
    let mut engine = GameEngine::new();
    assert!(
        engine
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );

    let departure = departure_minute_for_sim("sim-001", "standard", "outbound");
    let after_departure = scheduled_time_seconds(0, departure) + 1.0;
    assert!(engine.tick(after_departure).applied);

    assert!(
        engine
            .dispatch(GameIntent::PaintAreaRectangle {
                area: "residential".to_string(),
                start: (2, 3).into(),
                end: (3, 3).into(),
            })
            .applied
    );
    assert!(
        engine
            .dispatch(GameIntent::PlaceBuilding {
                building_type: "smallHouse".to_string(),
                origin: (2, 3).into(),
                rotation: 0,
            })
            .applied
    );
    assert!(
        engine
            .dispatch(GameIntent::PaintAreaRectangle {
                area: "commercial".to_string(),
                start: (8, 3).into(),
                end: (9, 4).into(),
            })
            .applied
    );
    assert!(
        engine
            .dispatch(GameIntent::PlaceBuilding {
                building_type: "supermarket".to_string(),
                origin: (8, 3).into(),
                rotation: 0,
            })
            .applied
    );

    // The first move-in is due at the building's placement timestamp. It is
    // strictly after today's outbound departure, so no retroactive commute may
    // be created for day 0.
    engine.tick(0.0);
    let due = engine.snapshot();
    assert_eq!(due.sims.len(), 1);
    assert!(due.active_trips.iter().all(|trip| {
        !(trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteOutbound)
    }));

    let next_day_departure = scheduled_time_seconds(1, departure);
    let until_next_departure = next_day_departure - due.time;
    engine.tick(until_next_departure);
    let next_day = engine.snapshot();
    assert!(next_day
        .active_trips
        .iter()
        .any(|trip| { trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteOutbound }));
}

#[test]
fn move_in_at_exact_departure_spawns_today() {
    let mut engine = GameEngine::new();
    assert!(
        engine
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );

    let departure = departure_minute_for_sim("sim-001", "standard", "outbound");
    let scheduled = scheduled_time_seconds(0, departure);
    assert!(engine.tick(scheduled).applied);

    assert!(
        engine
            .dispatch(GameIntent::PaintAreaRectangle {
                area: "residential".to_string(),
                start: (2, 3).into(),
                end: (3, 3).into(),
            })
            .applied
    );
    assert!(
        engine
            .dispatch(GameIntent::PlaceBuilding {
                building_type: "smallHouse".to_string(),
                origin: (2, 3).into(),
                rotation: 0,
            })
            .applied
    );
    assert!(
        engine
            .dispatch(GameIntent::PaintAreaRectangle {
                area: "commercial".to_string(),
                start: (8, 3).into(),
                end: (9, 4).into(),
            })
            .applied
    );
    assert!(
        engine
            .dispatch(GameIntent::PlaceBuilding {
                building_type: "supermarket".to_string(),
                origin: (8, 3).into(),
                rotation: 0,
            })
            .applied
    );

    engine.tick(0.0);
    let due = engine.snapshot();
    let sim = due
        .sims
        .iter()
        .find(|sim| sim.id == "sim-001")
        .expect("exact-departure move-in creates sim-001");
    assert!(!sim.outbound_resolved_today);
    assert!(!sim.outbound_arrived_today);
    // The spawned trip carries its spawn-time plan and the implied status
    // (walking toward the workplace) instead of a planless Idle payload.
    assert!(due.active_trips.iter().any(|trip| {
        trip.sim_id == "sim-001"
            && trip.purpose == TripPurpose::CommuteOutbound
            && trip.status == caelum_core::model::TripStatus::Walking
            && trip.route_plan.is_some()
    }));
}

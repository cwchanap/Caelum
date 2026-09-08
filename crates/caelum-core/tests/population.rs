use caelum_core::commute::departure_minute_for_sim;
use caelum_core::model::{
    ActiveTrip, CitizenRoutine, GameSnapshot, Point, RouteLeg, RoutePlan, ScheduledActivityKind,
    Sim, TransitMode, TripPosition, TripPurpose, TripStatus,
};
use caelum_core::{clock, GameEngine, GameIntent};

fn scheduled_time_seconds(day: u32, minute: u16) -> f64 {
    f64::from(day) * clock::GAME_DAY_SECONDS
        + (f64::from(minute) / f64::from(clock::MINUTES_PER_DAY)) * clock::GAME_DAY_SECONDS
}

fn is_worker(sim: &Sim) -> bool {
    matches!(sim.routine, CitizenRoutine::Worker { .. })
}

fn workplace_of(sim: &Sim) -> Option<Point> {
    match &sim.routine {
        CitizenRoutine::Worker { workplace, .. } => *workplace,
        CitizenRoutine::Student => None,
    }
}

fn set_workplace(sim: &mut Sim, workplace: Option<Point>) {
    if let CitizenRoutine::Worker {
        workplace: slot, ..
    } = &mut sim.routine
    {
        *slot = workplace;
    }
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
    let workers: Vec<_> = snapshot.sims.iter().filter(|sim| is_worker(sim)).collect();
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
    let assigned: Vec<_> = workers.iter().filter_map(|sim| workplace_of(sim)).collect();
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
    let workers: Vec<_> = snapshot.sims.iter().filter(|sim| is_worker(sim)).collect();
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
    let assigned: Vec<_> = workers.iter().filter_map(|sim| workplace_of(sim)).collect();
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

    let departure = departure_minute_for_sim("sim-003", "standard", "outbound");
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
        !(trip.sim_id == "sim-003" && trip.purpose == TripPurpose::CommuteOutbound)
    }));

    let next_day_departure = scheduled_time_seconds(1, departure);
    let until_next_departure = next_day_departure - due.time;
    engine.tick(until_next_departure);
    let next_day = engine.snapshot();
    assert!(next_day
        .active_trips
        .iter()
        .any(|trip| { trip.sim_id == "sim-003" && trip.purpose == TripPurpose::CommuteOutbound }));
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
    assert!(
        sim.next_activity.is_none(),
        "the spawned outbound trip owns the citizen"
    );
    // The spawned trip carries its spawn-time plan and the implied status
    // (walking toward the workplace) instead of a planless Idle payload.
    assert!(due.active_trips.iter().any(|trip| {
        trip.sim_id == "sim-001"
            && trip.purpose == TripPurpose::CommuteOutbound
            && trip.status == caelum_core::model::TripStatus::Walking
            && trip.route_plan.is_some()
    }));
}

// === Task 5 re-pins: placement/demolition/refill/late-assignment behaviors
// deleted from engine-level tests by Task 3, now pinned end-to-end through
// GameEngine (dispatch + tick) against the live ECS population authority.

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
    for (building_type, origin) in [
        ("smallHouse", (2, 3)),
        ("smallHouse", (2, 7)),
        ("supermarket", (8, 3)),
    ] {
        assert!(
            engine
                .dispatch(GameIntent::PlaceBuilding {
                    building_type: building_type.to_string(),
                    origin: origin.into(),
                    rotation: 0,
                })
                .applied
        );
    }
    assert!(
        engine
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );
    engine.tick(600.0);
    let filled = engine.snapshot();
    assert_eq!(filled.sims.len(), 8);

    // Task 5 pins the intended precondition through the durable snapshot: the
    // four residents of the house being demolished are employed, while the
    // four residents in the surviving house are unassigned surplus.
    let first_house_tiles = filled
        .buildings
        .iter()
        .find(|building| building.origin == caelum_core::model::Point { x: 2, y: 3 })
        .expect("first house")
        .occupied_tiles
        .clone();
    let second_house_tiles = filled
        .buildings
        .iter()
        .find(|building| building.origin == caelum_core::model::Point { x: 2, y: 7 })
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
            set_workplace(sim, Some(supermarket_tile));
        } else if second_house_tiles.contains(&sim.home) {
            set_workplace(sim, None);
        }
    }
    engine = GameEngine::from_snapshot(prepared).expect("prepared occupancy snapshot");

    let removed = engine.dispatch(GameIntent::RemoveAtTile {
        point: (2, 3).into(),
    });
    assert!(removed.applied, "{removed:?}");
    assert_eq!(engine.snapshot().sims.len(), 4);
    assert!(engine
        .snapshot()
        .sims
        .iter()
        .all(|sim| { second_house_tiles.contains(&sim.home) && is_worker(sim) }));
    assert_eq!(
        engine
            .snapshot()
            .sims
            .iter()
            .filter(|sim| {
                workplace_of(sim).is_some_and(|workplace| supermarket_tiles.contains(&workplace))
            })
            .count(),
        4,
        "the freed job slots refill from the globally lowest unassigned survivors"
    );
}

#[test]
fn demolishing_workplace_clears_workers_and_refills_elsewhere_without_churn() {
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

    let supermarket_tiles = filled
        .buildings
        .iter()
        .find(|building| building.building_type == "supermarket")
        .expect("supermarket")
        .occupied_tiles
        .clone();
    let cinema_tiles = filled
        .buildings
        .iter()
        .find(|building| building.building_type == "cinema")
        .expect("cinema")
        .occupied_tiles
        .clone();
    assert_eq!(supermarket_tiles.len(), 4);
    assert_eq!(cinema_tiles.len(), 6);
    let assigned: Vec<_> = filled.sims.iter().filter_map(workplace_of).collect();
    assert_eq!(assigned.len(), 8);

    let removed = engine.dispatch(GameIntent::RemoveAtTile {
        point: (8, 3).into(),
    });
    assert!(removed.applied, "{removed:?}");

    let after = engine.snapshot();
    assert_eq!(after.sims.len(), 8, "workplace removal never despawns");
    let supermarket_workers = after
        .sims
        .iter()
        .filter(|sim| {
            workplace_of(sim).is_some_and(|workplace| supermarket_tiles.contains(&workplace))
        })
        .count();
    assert_eq!(
        supermarket_workers, 0,
        "removed workplace loses every worker"
    );
    let cinema_workers = after
        .sims
        .iter()
        .filter(|sim| workplace_of(sim).is_some_and(|workplace| cinema_tiles.contains(&workplace)))
        .count();
    assert_eq!(
        cinema_workers, 6,
        "survivors refill the free cinema slots in stable order"
    );
    assert_eq!(
        after
            .sims
            .iter()
            .filter(|sim| workplace_of(sim).is_none())
            .count(),
        2,
        "exactly the surplus workers stay unassigned"
    );
}

#[test]
fn late_workplace_assignment_stays_dormant_until_next_day_end_to_end() {
    let mut engine = GameEngine::new();
    assert!(
        engine
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );

    let departure = departure_minute_for_sim("sim-003", "standard", "outbound");
    // Advance past today's departure while the town still has no buildings.
    assert!(
        engine
            .tick(scheduled_time_seconds(0, departure) + 1.0)
            .applied
    );

    // Move a resident in after the departure boundary (the move-in is due at
    // its placement timestamp, so one tick admits exactly slot zero).
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
    assert!(engine.tick(0.0).applied);
    assert_eq!(engine.snapshot().sims.len(), 1);
    assert!(engine.snapshot().active_trips.is_empty());

    // Mid-day destination: the late assignment must not gain a retroactive
    // outbound today, but the reconcile assigns the free slot immediately.
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
    let assigned = engine.snapshot();
    assert_eq!(assigned.sims.len(), 1);
    assert!(
        workplace_of(&assigned.sims[0]).is_some(),
        "reconcile assigns the free job slot immediately"
    );
    assert!(
        assigned
            .active_trips
            .iter()
            .all(|trip| !(trip.sim_id == "sim-003"
                && trip.purpose == TripPurpose::CommuteOutbound)),
        "no retroactive outbound after the departure boundary"
    );

    // The worker commutes normally on the next day.
    let next_day_departure = scheduled_time_seconds(1, departure);
    engine.tick(next_day_departure - assigned.time);
    let next_day = engine.snapshot();
    assert!(next_day
        .active_trips
        .iter()
        .any(|trip| trip.sim_id == "sim-003" && trip.purpose == TripPurpose::CommuteOutbound));
}

/// A hand-authored non-terminal outbound trip owning its citizen. Mirrors the
/// durable shape `validate_sims` accepts: `next_activity = None` plus a
/// non-terminal outbound trip for the same sim.
fn mid_outbound_trip(
    sim_id: &str,
    purpose: TripPurpose,
    origin: Point,
    destination: Point,
) -> ActiveTrip {
    ActiveTrip {
        id: "trip-day-0-trip-001".to_string(),
        sim_id: sim_id.to_string(),
        purpose,
        origin,
        destination,
        position: TripPosition::from(origin),
        status: TripStatus::Walking,
        deadline: 3_600.0,
        route_plan: Some(RoutePlan {
            legs: vec![RouteLeg {
                mode: TransitMode::Walk,
                from: origin,
                to: destination,
                line_id: None,
                service_direction: None,
                board_itinerary_index: None,
                alight_itinerary_index: None,
            }],
            estimated_seconds: 60.0,
        }),
        current_leg_index: 0,
        patience_remaining: 240.0,
        current_leg_wait_seconds: 0.0,
        private_car_trip: None,
    }
}

/// [P1] Bulldozing the only workplace while a worker is mid-outbound must not
/// leave that citizen permanently dormant. ECS reconciliation owns the trip
/// removal: with no replacement it drops the orphaned outbound AND schedules
/// next-day daily-routine recovery, so the citizen keeps a `NextActivity`.
/// The shell-side trip drop this replaces would preempt reconciliation, leaving
/// the citizen with neither an active trip nor a wake.
#[test]
fn bulldozing_only_workplace_with_in_flight_outbound_schedules_recovery() {
    let mut engine = assigned_workplace_engine();
    engine.tick(900.0);
    let filled = engine.snapshot();
    assert_eq!(filled.sims.len(), 4, "one smallHouse fills four residents");

    let supermarket_tiles = filled
        .buildings
        .iter()
        .find(|building| building.building_type == "supermarket")
        .expect("supermarket")
        .occupied_tiles
        .clone();
    let workplace_tile = supermarket_tiles[0];
    let worker = filled
        .sims
        .iter()
        .find(|sim| workplace_of(sim) == Some(workplace_tile))
        .expect("a worker assigned to the supermarket");
    let worker_id = worker.id.clone();

    // Rebuild the engine with that worker forced mid-outbound targeting the
    // supermarket, then bulldoze the supermarket through the real dispatch path.
    let mut mid = engine.snapshot();
    let home = mid
        .sims
        .iter()
        .find(|sim| sim.id == worker_id)
        .map(|sim| sim.home)
        .expect("worker home");
    for sim in &mut mid.sims {
        if sim.id == worker_id {
            sim.next_activity = None;
        }
    }
    // Replace only the target worker's trips so other travelling sims (if any)
    // keep their trips and stay valid against `validate_sims`.
    mid.active_trips.retain(|trip| trip.sim_id != worker_id);
    mid.active_trips.push(mid_outbound_trip(
        &worker_id,
        TripPurpose::CommuteOutbound,
        home,
        workplace_tile,
    ));
    let mut engine = GameEngine::from_snapshot(mid).expect("mid-outbound snapshot loads");

    let removed = engine.dispatch(GameIntent::RemoveAtTile {
        point: workplace_tile,
    });
    assert!(removed.applied, "{removed:?}");

    let after = engine.snapshot();
    // The orphaned outbound is gone (no replacement workplace exists).
    assert!(!after
        .active_trips
        .iter()
        .any(|trip| trip.sim_id == worker_id && trip.purpose == TripPurpose::CommuteOutbound));
    // The citizen is NOT dormant: reconciliation scheduled a recovery wake.
    let worker = after
        .sims
        .iter()
        .find(|sim| sim.id == worker_id)
        .expect("worker remains");
    assert!(
        worker.next_activity.is_some(),
        "reconciliation schedules recovery for a dropped outbound, not dormancy"
    );
    assert!(
        workplace_of(worker).is_none(),
        "no replacement workplace exists, so the worker stays unassigned"
    );
}

/// [P1] Bulldozing one of two workplaces while a worker is mid-outbound to it
/// retargets the in-flight trip to the replacement workplace rather than
/// dropping it.
#[test]
fn bulldozing_one_of_two_workplaces_retargets_in_flight_outbound() {
    let mut engine = GameEngine::new();
    for (area, start, end) in [
        ("residential", (2, 3), (3, 3)),
        ("commercial", (4, 3), (5, 4)),
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
        ("supermarket", (4, 3)),
        ("cinema", (8, 5)),
    ] {
        assert!(
            engine
                .dispatch(GameIntent::PlaceBuilding {
                    building_type: building_type.to_string(),
                    origin: origin.into(),
                    rotation: 0,
                })
                .applied
        );
    }
    assert!(
        engine
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );
    engine.tick(900.0);
    let filled = engine.snapshot();
    assert_eq!(filled.sims.len(), 4);

    let supermarket_tiles = filled
        .buildings
        .iter()
        .find(|building| building.building_type == "supermarket")
        .expect("supermarket")
        .occupied_tiles
        .clone();
    let cinema_tiles = filled
        .buildings
        .iter()
        .find(|building| building.building_type == "cinema")
        .expect("cinema")
        .occupied_tiles
        .clone();
    let workplace_tile = supermarket_tiles[0];
    let worker = filled
        .sims
        .iter()
        .find(|sim| workplace_of(sim) == Some(workplace_tile))
        .expect("a worker assigned to the supermarket");
    let worker_id = worker.id.clone();

    let mut mid = engine.snapshot();
    let home = mid
        .sims
        .iter()
        .find(|sim| sim.id == worker_id)
        .map(|sim| sim.home)
        .expect("worker home");
    for sim in &mut mid.sims {
        if sim.id == worker_id {
            sim.next_activity = None;
        }
    }
    mid.active_trips.retain(|trip| trip.sim_id != worker_id);
    mid.active_trips.push(mid_outbound_trip(
        &worker_id,
        TripPurpose::CommuteOutbound,
        home,
        workplace_tile,
    ));
    let mut engine = GameEngine::from_snapshot(mid).expect("mid-outbound snapshot loads");

    let removed = engine.dispatch(GameIntent::RemoveAtTile {
        point: workplace_tile,
    });
    assert!(removed.applied, "{removed:?}");

    let after = engine.snapshot();
    let worker = after
        .sims
        .iter()
        .find(|sim| sim.id == worker_id)
        .expect("worker remains");
    // The worker is retargeted to the cinema (the surviving workplace).
    let new_workplace = workplace_of(worker).expect("retargeted to a replacement");
    assert!(
        cinema_tiles.contains(&new_workplace),
        "retargeted to the cinema, not left unassigned"
    );
    // The in-flight outbound is retargeted (still present, heading to the
    // cinema), not dropped.
    let trip = after
        .active_trips
        .iter()
        .find(|trip| trip.sim_id == worker_id && trip.purpose == TripPurpose::CommuteOutbound)
        .expect("outbound retargeted, not dropped");
    assert_eq!(trip.destination, new_workplace);
}

/// [P2] The citizen-ID allocator high-water mark survives save/restore after
/// the highest-ID resident is despawned. Without the persisted
/// `next_citizen_ordinal`, `build_world` would fall back to
/// `max(surviving sim id suffix)+1` and the next move-in would reuse the
/// deleted id — diverging shift jitter, days off, and daily seeds from
/// uninterrupted play.
#[test]
fn allocator_high_water_mark_survives_save_restore_and_move_in() {
    let mut engine = zoned_engine("smallHouse", (2, 3), (3, 3));
    assert!(
        engine
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );
    // Move in four residents: sim-001..sim-004.
    engine.tick(600.0);
    let filled = engine.snapshot();
    assert_eq!(filled.sims.len(), 4);
    let highest_id = filled.sims.iter().map(|sim| sim.id.clone()).max().unwrap();
    assert_eq!(highest_id, "sim-004");
    let highest_home = filled
        .sims
        .iter()
        .find(|sim| sim.id == highest_id)
        .map(|sim| sim.home)
        .unwrap();

    // Demolish the smallHouse, which despawns all four residents including the
    // highest-ID one. The live allocator must stay at 5, not rewind to 4.
    let house_tile = filled
        .buildings
        .iter()
        .find(|building| building.building_type == "smallHouse")
        .map(|building| building.occupied_tiles[0])
        .unwrap();
    assert!(
        engine
            .dispatch(GameIntent::RemoveAtTile { point: house_tile })
            .applied
    );
    let after_demolish = engine.snapshot();
    assert!(after_demolish.sims.is_empty());
    // The durable snapshot carries the live high-water mark (5).
    assert_eq!(after_demolish.next_citizen_ordinal, 5);

    // Save/restore through the real engine pipeline.
    let saved = engine.snapshot_for_save();
    assert_eq!(saved.next_citizen_ordinal, 5);
    let mut restored = GameEngine::from_snapshot(saved).expect("restore succeeds");

    // Place a new smallHouse and tick to trigger a move-in. The next id must be
    // sim-005, not a reused sim-004. Restore forces `paused = true`, so unpause
    // first — move-ins only fire on the first running tick.
    assert!(
        restored
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );
    assert!(
        restored
            .dispatch(GameIntent::PlaceBuilding {
                building_type: "smallHouse".to_string(),
                origin: (2, 3).into(),
                rotation: 0,
            })
            .applied
    );
    let _ = restored.tick(1.0);
    let after_move_in = restored.snapshot();
    let new_sim = after_move_in.sims.first().expect("a new resident moved in");
    assert_eq!(
        new_sim.id, "sim-005",
        "persisted ordinal prevents id reuse after save/restore"
    );
    assert_ne!(
        new_sim.home, highest_home,
        "the reused-id case would also replay the same home slot"
    );
}

/// [P2] Bulldozing a school while a Student is mid-outbound to it must drop the
/// orphaned commute and schedule recovery. Students are not in the Worker
/// `replacements` map, so the Worker retarget path never sees them; the
/// footprint-based destination demolition path owns this case. Pins the
/// Student case through the real `RemoveAtTile` engine path.
#[test]
fn bulldozing_school_with_in_flight_student_outbound_schedules_recovery() {
    let mut engine = GameEngine::new();
    for origin in [(2, 3), (5, 3), (8, 3)] {
        assert!(
            engine
                .dispatch(GameIntent::PaintAreaRectangle {
                    area: "residential".to_string(),
                    start: origin.into(),
                    end: (origin.0 + 1, origin.1).into(),
                })
                .applied
        );
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
            .dispatch(GameIntent::PaintAreaRectangle {
                area: "civic".to_string(),
                start: (6, 10).into(),
                end: (8, 11).into(),
            })
            .applied
    );
    assert!(
        engine
            .dispatch(GameIntent::PlaceBuilding {
                building_type: "school".to_string(),
                origin: (6, 10).into(),
                rotation: 0,
            })
            .applied
    );
    assert!(
        engine
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );
    // Twelve housing slots move in; sim-010 is the canonical Student.
    let _ = engine.tick(1_600.0);
    let filled = engine.snapshot();
    assert_eq!(filled.sims.len(), 12);
    let student = filled
        .sims
        .iter()
        .find(|sim| matches!(sim.routine, CitizenRoutine::Student))
        .expect("a canonical Student moved in");
    assert_eq!(student.id, "sim-010");
    let student_id = student.id.clone();
    let home = student.home;
    let school_tiles = filled
        .buildings
        .iter()
        .find(|building| building.building_type == "school")
        .expect("school")
        .occupied_tiles
        .clone();
    let school_tile = school_tiles[0];

    // Force the Student mid-outbound to the school, then bulldoze the school
    // through the real dispatch path.
    let mut mid = engine.snapshot();
    for sim in &mut mid.sims {
        if sim.id == student_id {
            sim.next_activity = None;
        }
    }
    mid.active_trips.retain(|trip| trip.sim_id != student_id);
    mid.active_trips.push(mid_outbound_trip(
        &student_id,
        TripPurpose::CommuteOutbound,
        home,
        school_tile,
    ));
    let mut engine = GameEngine::from_snapshot(mid).expect("mid-outbound snapshot loads");

    let removed = engine.dispatch(GameIntent::RemoveAtTile { point: school_tile });
    assert!(removed.applied, "{removed:?}");

    let after = engine.snapshot();
    // The Student's orphaned school commute is gone.
    assert!(!after
        .active_trips
        .iter()
        .any(|trip| trip.sim_id == student_id && trip.purpose == TripPurpose::CommuteOutbound));
    // The Student is NOT dormant: reconciliation scheduled a recovery wake.
    let student = after
        .sims
        .iter()
        .find(|sim| sim.id == student_id)
        .expect("student remains");
    assert!(
        student.next_activity.is_some(),
        "reconciliation schedules recovery for a dropped school commute, not dormancy"
    );
    let recovery = student.next_activity.as_ref().unwrap();
    assert_eq!(
        recovery.kind,
        ScheduledActivityKind::DailyRoutine,
        "recovery is a daily-routine wake, not a phantom outbound"
    );
}

/// [P2] Bulldozing an optional-outing site while a citizen is mid-outbound to
/// it must drop the orphaned outing and schedule recovery. Optional outings
/// target supermarket/cinema/clinic/parkPlaza footprints but their citizens are
/// not in the Worker `replacements` map, so the footprint-based destination
/// demolition path owns this case. The citizen's own workplace is untouched.
/// Pins the Optional case through the real `RemoveAtTile` engine path.
#[test]
fn bulldozing_optional_site_with_in_flight_outing_schedules_recovery() {
    let mut engine = GameEngine::new();
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
    // Factory placed first so the four workers fill it; the parkPlaza keeps no
    // assigned workers, isolating the optional-outing demolition path.
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
            .dispatch(GameIntent::PaintAreaRectangle {
                area: "park".to_string(),
                start: (12, 3).into(),
                end: (13, 4).into(),
            })
            .applied
    );
    assert!(
        engine
            .dispatch(GameIntent::PlaceBuilding {
                building_type: "parkPlaza".to_string(),
                origin: (12, 3).into(),
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
    assert_eq!(filled.sims.len(), 4);
    let worker = filled
        .sims
        .iter()
        .find(|sim| is_worker(sim))
        .expect("a worker moved in");
    let worker_id = worker.id.clone();
    let home = worker.home;
    let factory_tile = workplace_of(worker).expect("worker assigned to the factory");
    let park_tiles = filled
        .buildings
        .iter()
        .find(|building| building.building_type == "parkPlaza")
        .expect("parkPlaza")
        .occupied_tiles
        .clone();
    let park_tile = park_tiles[0];

    // Force the worker mid-outbound on an optional outing to the parkPlaza,
    // then bulldoze the parkPlaza through the real dispatch path.
    let mut mid = engine.snapshot();
    for sim in &mut mid.sims {
        if sim.id == worker_id {
            sim.next_activity = None;
        }
    }
    mid.active_trips.retain(|trip| trip.sim_id != worker_id);
    mid.active_trips.push(mid_outbound_trip(
        &worker_id,
        TripPurpose::OptionalOutbound,
        home,
        park_tile,
    ));
    let mut engine = GameEngine::from_snapshot(mid).expect("mid-outbound snapshot loads");

    let removed = engine.dispatch(GameIntent::RemoveAtTile { point: park_tile });
    assert!(removed.applied, "{removed:?}");

    let after = engine.snapshot();
    // The orphaned optional outing is gone.
    assert!(!after
        .active_trips
        .iter()
        .any(|trip| trip.sim_id == worker_id && trip.purpose == TripPurpose::OptionalOutbound));
    // The citizen is NOT dormant: reconciliation scheduled a recovery wake.
    let worker = after
        .sims
        .iter()
        .find(|sim| sim.id == worker_id)
        .expect("worker remains");
    assert!(
        worker.next_activity.is_some(),
        "reconciliation schedules recovery for a dropped optional outing, not dormancy"
    );
    assert_eq!(
        worker.next_activity.as_ref().unwrap().kind,
        ScheduledActivityKind::DailyRoutine,
        "recovery is a daily-routine wake, not a phantom outing"
    );
    // The citizen's own workplace (the factory) is untouched by the
    // parkPlaza demolition — only the optional outing was cancelled.
    assert_eq!(
        workplace_of(worker),
        Some(factory_tile),
        "the factory workplace survives the unrelated parkPlaza demolition"
    );
}

/// [P2] Restoring a partially occupied building must not replay move-ins for
/// slots already filled by durable residents. Before the fix, `build_world`
/// scheduled every slot `0..capacity`; past-due events for already-occupied
/// slots minted extra citizens at the wrong due time and home tile. After the
/// fix, only vacant slots are scheduled, so restore preserves resident IDs and
/// home assignments without minting duplicates, and the remaining slots still
/// fill on subsequent ticks.
#[test]
fn restore_preserves_partially_occupied_building_without_replaying_filled_slots() {
    let mut engine = zoned_engine("smallHouse", (2, 3), (3, 3));
    assert!(
        engine
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );
    // Move in 2 of 4 residents (slots at t=0 and t=50; interval = 50s).
    engine.tick(75.0);
    let partial = engine.snapshot();
    assert_eq!(partial.sims.len(), 2, "two residents moved in before save");
    let saved_ids: Vec<String> = partial.sims.iter().map(|sim| sim.id.clone()).collect();
    let saved_homes: Vec<Point> = partial.sims.iter().map(|sim| sim.home).collect();
    assert_eq!(
        saved_ids,
        vec!["sim-001".to_string(), "sim-002".to_string()]
    );

    // Save and restore through the real engine pipeline.
    let saved = engine.snapshot_for_save();
    let mut restored = GameEngine::from_snapshot(saved).expect("restore succeeds");

    // Restore must not mint duplicate residents for already-occupied slots.
    let restored_snapshot = restored.snapshot();
    assert_eq!(
        restored_snapshot.sims.len(),
        2,
        "restore does not replay move-ins for already-occupied slots"
    );
    assert_eq!(
        restored_snapshot
            .sims
            .iter()
            .map(|sim| sim.id.clone())
            .collect::<Vec<_>>(),
        saved_ids,
        "resident IDs preserved across restore"
    );
    assert_eq!(
        restored_snapshot
            .sims
            .iter()
            .map(|sim| sim.home)
            .collect::<Vec<_>>(),
        saved_homes,
        "home assignments preserved across restore"
    );

    // A small tick (t=75 → t=76) must not mint past-due replay residents.
    // With the bug, slots 0 and 1 (at t=0 and t=50) would fire as past-due
    // and mint two extra citizens immediately. With the fix, the next
    // move-ins are at t=100 and t=150 — still in the future at t=76.
    assert!(
        restored
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );
    restored.tick(1.0);
    let after_small_tick = restored.snapshot();
    assert_eq!(
        after_small_tick.sims.len(),
        2,
        "no past-due move-in replays fire on the first small tick"
    );

    // The remaining 2 slots (at t=100 and t=150) still fill when ticked
    // far enough.
    restored.tick(100.0);
    let filled = restored.snapshot();
    assert_eq!(
        filled.sims.len(),
        4,
        "remaining vacant slots fill after restore"
    );
    for id in &saved_ids {
        assert!(
            filled.sims.iter().any(|sim| &sim.id == id),
            "original resident {id} still present after remaining slots fill"
        );
    }
    assert_eq!(
        filled.next_citizen_ordinal, 5,
        "allocator advanced to 5 after two post-restore move-ins"
    );
}

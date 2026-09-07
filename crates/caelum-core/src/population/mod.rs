use crate::clock::{GAME_DAY_SECONDS, MINUTES_PER_DAY};

mod components;
mod schedule;

pub const MOVE_IN_INTERVAL_SECONDS: f64 = GAME_DAY_SECONDS / 24.0;

pub(crate) use schedule::{
    apply_trip_resolutions, build_schedule, build_world, drain_trip_demands,
    next_population_boundary, presentation_aggregates, reconcile_buildings, run_due,
    scheduler_boundary_generation, scheduler_due_key_count, snapshot_sims, TripDemand,
    TripResolution,
};

#[cfg(test)]
pub(crate) use schedule::population_count;

fn scheduled_time_seconds(day: u32, minute: u16) -> f64 {
    f64::from(day) * GAME_DAY_SECONDS
        + (f64::from(minute) / f64::from(MINUTES_PER_DAY)) * GAME_DAY_SECONDS
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use bevy_ecs::prelude::{Entity, World};

    use super::components::{CitizenId, HomeAssignment, NextActivity, Routine, SettledPosition};
    use super::schedule::{
        build_schedule, build_world, drain_trip_demands, job_occupancy_for_building,
        population_count, rebuilt_index, reconcile_buildings, resident_occupancy_for_building,
        run_due, snapshot_sims, spawn_indexed_citizen, NextCitizenOrdinal, PopulationIndex,
        PopulationMutation,
    };
    use super::{scheduled_time_seconds, MOVE_IN_INTERVAL_SECONDS};
    use crate::building_catalog::building_definition;
    use crate::clock::GAME_DAY_SECONDS;
    use crate::commute::{departure_minute_for_sim, trip_deadline_seconds};
    use crate::ids::entity_id;
    use crate::model::{
        ActiveTrip, CitizenRoutine, GameMode, GameSnapshot, PlacedBuilding, Point, PrivateCarTrip,
        RoutePlan, ScheduledActivity, ScheduledActivityKind, Sim, TransitMode, TripPosition,
        TripPurpose, TripStatus, Vehicle,
    };
    use crate::sandbox::{create_sandbox_snapshot, SandboxCreationRequest};
    use crate::state::create_initial_snapshot;

    pub(super) fn population_fixture() -> GameSnapshot {
        let mut snapshot = create_sandbox_snapshot(SandboxCreationRequest {
            template_id: "smallTown".to_string(),
            economy_preset: "standard".to_string(),
            starting_capital: Some(f64::from(crate::DEFAULT_STARTING_CAPITAL)),
            demand_multiplier: Some(1.0),
        })
        .expect("small town template must remain valid");
        snapshot.day = 5;
        let housing: Vec<Point> = snapshot
            .buildings
            .iter()
            .filter(|building| {
                building_definition(&building.building_type)
                    .is_some_and(|definition| definition.resident_capacity > 0)
            })
            .flat_map(|building| building.occupied_tiles.iter().copied())
            .collect();
        let jobs: Vec<Point> = snapshot
            .buildings
            .iter()
            .filter(|building| {
                building_definition(&building.building_type)
                    .is_some_and(|definition| definition.job_capacity > 0)
            })
            .flat_map(|building| building.occupied_tiles.iter().copied())
            .collect();
        let home = housing[0];
        let other_home = housing[1];
        let shop = jobs[0];
        let factory = jobs[jobs.len() - 1];
        // Strip housing so no template move-ins are scheduled: these tests pin
        // the durable-sim wake semantics, not move-ins.
        snapshot.buildings.retain(|building| {
            building_definition(&building.building_type)
                .is_some_and(|definition| definition.resident_capacity == 0)
        });
        let worker_wake = |sim_id: &str, template: &str| ScheduledActivity {
            kind: ScheduledActivityKind::DailyRoutine,
            due_time: scheduled_time_seconds(
                snapshot.day,
                departure_minute_for_sim(sim_id, template, "outbound"),
            ),
        };
        let worker = |sim_id: &str, template: &str, workplace, home: Point| Sim {
            id: sim_id.to_string(),
            home,
            position: home,
            routine: CitizenRoutine::Worker {
                shift_template: template.to_string(),
                workplace,
            },
            next_activity: Some(worker_wake(sim_id, template)),
        };
        snapshot.sims = vec![
            worker("sim-001", "standard", Some(shop), home),
            Sim {
                position: Point {
                    x: other_home.x + 1,
                    y: other_home.y,
                },
                routine: CitizenRoutine::Worker {
                    shift_template: "swing".to_string(),
                    workplace: None,
                },
                ..worker("sim-002", "swing", None, other_home)
            },
            worker("sim-003", "standard", Some(factory), home),
            Sim {
                routine: CitizenRoutine::Student,
                next_activity: Some(ScheduledActivity {
                    kind: ScheduledActivityKind::DailyRoutine,
                    due_time: scheduled_time_seconds(snapshot.day + 1, 0),
                }),
                ..worker("sim-004", "", None, other_home)
            },
        ];
        snapshot
    }

    fn despawn_highest_fixture_citizen(world: &mut World) {
        let mut query = world.query::<(Entity, &CitizenId)>();
        let highest = query
            .iter(world)
            .max_by(|left, right| (left.1).0.cmp(&(right.1).0))
            .map(|(entity, _)| entity)
            .expect("fixture world must contain citizens");
        world.despawn(highest);
    }

    #[test]
    fn ecs_world_round_trips_current_durable_sims_in_stable_id_order() {
        let snapshot = population_fixture();
        let world = build_world(&snapshot);
        assert_eq!(population_count(&world), snapshot.sims.len() as u32);
        assert_eq!(snapshot_sims(&world, snapshot.day), snapshot.sims);
    }

    #[test]
    fn allocator_does_not_reuse_a_deleted_highest_id() {
        let snapshot = population_fixture();
        let mut world = build_world(&snapshot);
        let before = world.resource::<NextCitizenOrdinal>().0;
        despawn_highest_fixture_citizen(&mut world);
        assert_eq!(world.resource::<NextCitizenOrdinal>().0, before);
    }

    #[test]
    fn rebuilt_index_matches_the_index_built_from_snapshot() {
        let snapshot = population_fixture();
        let mut world = build_world(&snapshot);
        assert_eq!(
            rebuilt_index(&mut world),
            *world.resource::<PopulationIndex>()
        );
    }

    #[test]
    fn structural_construction_scales_to_200k_citizens() {
        let mut world = World::new();
        let mut index = PopulationIndex::default();
        for ordinal in 1..=200_000usize {
            let point = Point::from(((ordinal % 50) as i32, ((ordinal / 50) % 50) as i32));
            spawn_indexed_citizen(
                &mut world,
                &mut index,
                (
                    CitizenId(entity_id("sim", ordinal)),
                    HomeAssignment {
                        building_id: Some("building-001".to_string()),
                        point,
                    },
                    SettledPosition(point),
                    Routine::Worker {
                        shift_template: "standard".to_string(),
                        workplace: None,
                    },
                ),
            );
        }
        world.insert_resource(index);
        world.insert_resource(NextCitizenOrdinal(200_001));
        assert_eq!(population_count(&world), 200_000);
        assert_eq!(
            resident_occupancy_for_building(&world, "building-001"),
            200_000
        );
        assert_eq!(job_occupancy_for_building(&world, "building-001"), 0);
        assert_eq!(
            rebuilt_index(&mut world),
            *world.resource::<PopulationIndex>()
        );
    }

    // === Task 3: targeted ECS building reconciliation ===

    fn reconcile_sandbox(time: f64) -> GameSnapshot {
        let mut snapshot = create_sandbox_snapshot(SandboxCreationRequest {
            template_id: "smallTown".to_string(),
            economy_preset: "standard".to_string(),
            starting_capital: Some(f64::from(crate::DEFAULT_STARTING_CAPITAL)),
            demand_multiplier: Some(1.0),
        })
        .expect("small town template must remain valid");
        snapshot.buildings.clear();
        snapshot.sims.clear();
        snapshot.active_trips.clear();
        snapshot.transit.vehicles.clear();
        snapshot.time = time;
        snapshot.day = crate::clock::day_index(time);
        snapshot
    }

    fn reconcile_house(id: &str, origin: Point, placed_at: f64) -> PlacedBuilding {
        PlacedBuilding {
            id: id.to_string(),
            building_type: "smallHouse".to_string(),
            origin,
            rotation: 0,
            occupied_tiles: vec![origin, Point::from((origin.x + 1, origin.y))],
            placed_at,
            transit_node_id: None,
        }
    }

    fn reconcile_market(id: &str, origin: Point, placed_at: f64) -> PlacedBuilding {
        PlacedBuilding {
            id: id.to_string(),
            building_type: "supermarket".to_string(),
            origin,
            rotation: 0,
            occupied_tiles: vec![
                origin,
                Point::from((origin.x + 1, origin.y)),
                Point::from((origin.x, origin.y + 1)),
                Point::from((origin.x + 1, origin.y + 1)),
            ],
            placed_at,
            transit_node_id: None,
        }
    }

    fn reconcile_worker(id: &str, home: Point, workplace: Option<Point>) -> Sim {
        Sim {
            id: id.to_string(),
            home,
            position: home,
            routine: CitizenRoutine::Worker {
                shift_template: "standard".to_string(),
                workplace,
            },
            next_activity: Some(ScheduledActivity {
                kind: ScheduledActivityKind::DailyRoutine,
                due_time: scheduled_time_seconds(
                    1,
                    departure_minute_for_sim(id, "standard", "outbound"),
                ),
            }),
        }
    }

    fn reconcile_trip(
        id: &str,
        sim_id: &str,
        purpose: TripPurpose,
        origin: Point,
        destination: Point,
        status: TripStatus,
    ) -> ActiveTrip {
        ActiveTrip {
            id: id.to_string(),
            sim_id: sim_id.to_string(),
            purpose,
            origin,
            destination,
            position: TripPosition {
                x: f64::from(origin.x),
                y: f64::from(origin.y),
            },
            status,
            deadline: 900.0,
            route_plan: None,
            current_leg_index: 0,
            patience_remaining: 240.0,
            current_leg_wait_seconds: 0.0,
            private_car_trip: None,
        }
    }

    fn reconcile_vehicle(passenger_ids: &[&str]) -> Vehicle {
        Vehicle {
            id: "vehicle-001".to_string(),
            mode: TransitMode::Bus,
            line_id: "route-001".to_string(),
            capacity: 18,
            passenger_ids: passenger_ids.iter().map(|id| (*id).to_string()).collect(),
            itinerary_index: 0,
            path_step_index: 0,
            step_progress: 0.0,
            parked_position: None,
        }
    }

    fn sim_departure_time(sim_id: &str, day: u32) -> f64 {
        scheduled_time_seconds(
            day,
            departure_minute_for_sim(sim_id, "standard", "outbound"),
        )
    }

    fn citizen_workplaces(world: &mut World, day: u32) -> Vec<(String, Option<Point>)> {
        snapshot_sims(world, day)
            .into_iter()
            .map(|sim| match sim.routine {
                CitizenRoutine::Worker { workplace, .. } => (sim.id, workplace),
                CitizenRoutine::Student => (sim.id, None),
            })
            .collect()
    }

    fn assert_index_rebuilt(world: &mut World) {
        assert_eq!(
            rebuilt_index(world),
            *world.resource::<PopulationIndex>(),
            "derived index must equal its rebuild after this lifecycle mutation"
        );
    }

    #[test]
    fn reconcile_fills_added_sandbox_housing_and_assigns_exactly_four_workers() {
        let before = reconcile_sandbox(0.0);
        let mut after = before.clone();
        after.buildings = vec![
            reconcile_house("building-001", Point::from((2, 3)), 0.0),
            reconcile_house("building-002", Point::from((2, 7)), 0.0),
            reconcile_market("building-003", Point::from((8, 3)), 0.0),
        ];
        let mut world = build_world(&before);
        let ordinal_before = world.resource::<NextCitizenOrdinal>().0;

        // Scheduling future move-ins alone is not a population mutation.
        let mutation = reconcile_buildings(&mut world, &before, &mut after);
        assert_eq!(mutation, PopulationMutation { changed: false });

        let mut schedule = build_schedule();
        let result = run_due(&mut world, &mut schedule, 3.0 * MOVE_IN_INTERVAL_SECONDS);
        assert!(result.changed);

        assert_eq!(population_count(&world), 8);
        let sims = snapshot_sims(&world, after.day);
        assert_eq!(
            sims.iter().map(|sim| sim.id.as_str()).collect::<Vec<_>>(),
            [
                "sim-001", "sim-002", "sim-003", "sim-004", "sim-005", "sim-006", "sim-007",
                "sim-008"
            ]
        );
        let market_tiles: HashSet<Point> =
            after.buildings[2].occupied_tiles.iter().copied().collect();
        let workplace_of = |sim: &Sim| match &sim.routine {
            CitizenRoutine::Worker { workplace, .. } => *workplace,
            CitizenRoutine::Student => None,
        };
        let assigned: Vec<Option<Point>> = sims.iter().map(workplace_of).collect();
        assert_eq!(
            assigned
                .iter()
                .filter(|workplace| workplace.is_some())
                .count(),
            4,
            "exactly the four supermarket slots may be assigned"
        );
        for workplace in assigned.iter().flatten() {
            assert!(market_tiles.contains(workplace));
        }
        for sim in sims.iter().take(4) {
            assert!(
                workplace_of(sim).is_some(),
                "lowest IDs fill the free slots"
            );
        }
        for sim in sims.iter().skip(4) {
            assert!(
                workplace_of(sim).is_none(),
                "surplus workers stay unassigned"
            );
        }
        assert_index_rebuilt(&mut world);
        assert_eq!(
            world.resource::<NextCitizenOrdinal>().0,
            ordinal_before + 8,
            "the allocator must stay monotonic across move-ins"
        );
    }

    #[test]
    fn freed_job_slots_refill_from_the_globally_lowest_unassigned_citizens() {
        let mut before = reconcile_sandbox(0.0);
        before.buildings = vec![
            reconcile_market("building-001", Point::from((8, 3)), 0.0),
            reconcile_market("building-002", Point::from((12, 3)), 0.0),
        ];
        before.sims = vec![
            // sim-001 was already unassigned before the removal; sim-002 is
            // cleared by the removal of building-001.
            reconcile_worker("sim-001", Point::from((1, 1)), None),
            reconcile_worker("sim-002", Point::from((1, 2)), Some(Point::from((8, 3)))),
        ];
        let mut after = before.clone();
        after
            .buildings
            .retain(|building| building.id != "building-001");
        let mut world = build_world(&before);
        let ordinal_before = world.resource::<NextCitizenOrdinal>().0;

        let mutation = reconcile_buildings(&mut world, &before, &mut after);

        assert!(mutation.changed);
        let workplaces = citizen_workplaces(&mut world, after.day);
        let replacement_tiles = [
            Point::from((12, 3)),
            Point::from((13, 3)),
            Point::from((12, 4)),
            Point::from((13, 4)),
        ];
        assert_eq!(
            workplaces,
            vec![
                ("sim-001".to_string(), Some(replacement_tiles[0])),
                ("sim-002".to_string(), Some(replacement_tiles[1])),
            ],
            "the already-unassigned lower ID takes the first freed slot"
        );
        assert_index_rebuilt(&mut world);
        assert_eq!(
            world.resource::<NextCitizenOrdinal>().0,
            ordinal_before,
            "workplace reconciliation never touches the allocator"
        );
    }

    #[test]
    fn added_workplace_fills_from_global_unassigned_set_in_citizen_id_order() {
        let mut before = reconcile_sandbox(0.0);
        before.sims = vec![
            reconcile_worker("sim-001", Point::from((1, 1)), None),
            reconcile_worker("sim-002", Point::from((1, 2)), None),
            reconcile_worker("sim-003", Point::from((1, 3)), None),
        ];
        let mut after = before.clone();
        after
            .buildings
            .push(reconcile_market("building-001", Point::from((8, 3)), 0.0));
        let mut world = build_world(&before);
        let ordinal_before = world.resource::<NextCitizenOrdinal>().0;

        let mutation = reconcile_buildings(&mut world, &before, &mut after);

        assert!(mutation.changed);
        assert_eq!(
            citizen_workplaces(&mut world, after.day),
            vec![
                ("sim-001".to_string(), Some(Point::from((8, 3)))),
                ("sim-002".to_string(), Some(Point::from((9, 3)))),
                ("sim-003".to_string(), Some(Point::from((8, 4)))),
            ],
            "free slots fill in stable citizen-ID order from the global unassigned set"
        );
        assert_index_rebuilt(&mut world);
        assert_eq!(world.resource::<NextCitizenOrdinal>().0, ordinal_before);
    }

    #[test]
    fn housing_removal_despawns_only_its_residents_and_scrubs_their_trips() {
        let mut before = reconcile_sandbox(0.0);
        let house_one_tiles = [Point::from((2, 3)), Point::from((3, 3))];
        let house_two_tiles = [Point::from((2, 7)), Point::from((3, 7))];
        // Pre-existing housing is placed far in the future so its vacant slots
        // stay outside this test's move-in horizon; only the reconcile-added
        // replacement housing admits residents.
        before.buildings = vec![
            reconcile_house("building-001", Point::from((2, 3)), 1.0e6),
            reconcile_house("building-002", Point::from((2, 7)), 1.0e6),
            reconcile_market("building-003", Point::from((8, 3)), 0.0),
        ];
        before.sims = vec![
            reconcile_worker("sim-001", house_one_tiles[0], Some(Point::from((9, 3)))),
            reconcile_worker("sim-002", house_one_tiles[1], None),
            reconcile_worker("sim-003", house_two_tiles[0], Some(Point::from((8, 3)))),
            reconcile_worker("sim-004", house_two_tiles[1], None),
        ];
        before.active_trips = vec![
            reconcile_trip(
                "trip-1",
                "sim-001",
                TripPurpose::CommuteOutbound,
                house_one_tiles[0],
                Point::from((9, 3)),
                TripStatus::Riding,
            ),
            reconcile_trip(
                "trip-2",
                "sim-002",
                TripPurpose::CommuteReturn,
                Point::from((5, 5)),
                house_one_tiles[1],
                TripStatus::Waiting,
            ),
            reconcile_trip(
                "trip-3",
                "sim-003",
                TripPurpose::CommuteOutbound,
                house_two_tiles[0],
                Point::from((8, 3)),
                TripStatus::Walking,
            ),
        ];
        before.transit.vehicles = vec![reconcile_vehicle(&["trip-1", "trip-2", "trip-3"])];
        // The same reconcile also adds replacement housing: the new residents
        // must receive fresh monotonic IDs, never the despawned ones.
        let mut after = before.clone();
        after
            .buildings
            .retain(|building| building.id != "building-001");
        after
            .buildings
            .push(reconcile_house("building-004", Point::from((6, 3)), 0.0));
        let mut world = build_world(&before);
        let ordinal_before = world.resource::<NextCitizenOrdinal>().0;

        let mutation = reconcile_buildings(&mut world, &before, &mut after);
        assert!(mutation.changed);

        let survivors = citizen_workplaces(&mut world, after.day);
        assert_eq!(
            survivors,
            vec![
                ("sim-003".to_string(), Some(Point::from((8, 3)))),
                // sim-001's despawn freed slot one; the globally lowest
                // unassigned survivor takes it.
                ("sim-004".to_string(), Some(Point::from((9, 3)))),
            ],
            "only building-001's residents may be despawned"
        );
        assert_eq!(
            after
                .active_trips
                .iter()
                .map(|trip| trip.id.as_str())
                .collect::<Vec<_>>(),
            ["trip-3"],
            "despawned residents' trips are removed"
        );
        assert_eq!(after.transit.vehicles[0].passenger_ids, vec!["trip-3"]);

        let mut schedule = build_schedule();
        run_due(&mut world, &mut schedule, 3.0 * MOVE_IN_INTERVAL_SECONDS);
        assert_eq!(population_count(&world), 6);
        let sims = snapshot_sims(&world, after.day);
        assert_eq!(
            sims.iter().map(|sim| sim.id.as_str()).collect::<Vec<_>>(),
            ["sim-003", "sim-004", "sim-005", "sim-006", "sim-007", "sim-008"],
            "replacement housing spawns fresh monotonic IDs, never reused ones"
        );
        for sim in sims.iter().skip(2) {
            assert!(after.buildings[2].occupied_tiles.contains(&sim.home));
        }
        assert_index_rebuilt(&mut world);
        assert_eq!(
            world.resource::<NextCitizenOrdinal>().0,
            ordinal_before + 4,
            "the allocator never reuses despawned IDs"
        );
    }

    #[test]
    fn campaign_reconciliation_schedules_no_resident_move_ins() {
        let mut before = create_initial_snapshot();
        before.rules.game_mode = GameMode::Campaign;
        before.sims.clear();
        before.active_trips.clear();
        let mut after = before.clone();
        let anchor = Point::from((20, 3));
        after
            .buildings
            .push(reconcile_house("building-new", anchor, after.time));
        let mut world = build_world(&before);

        let mutation = reconcile_buildings(&mut world, &before, &mut after);

        assert!(!mutation.changed);
        let mut schedule = build_schedule();
        let result = run_due(
            &mut world,
            &mut schedule,
            f64::from(after.day + 10) * GAME_DAY_SECONDS,
        );
        assert!(!result.changed);
        assert_eq!(
            population_count(&world),
            0,
            "campaign housing never moves residents in"
        );
        assert!(drain_trip_demands(&mut world).is_empty());
    }

    #[test]
    fn late_workplace_assignment_stays_dormant_until_next_day() {
        let departure = sim_departure_time("sim-001", 0);
        let mut before = reconcile_sandbox(departure + 1.0);
        before.sims = vec![reconcile_worker("sim-001", Point::from((2, 3)), None)];
        // A late load: today's departure already passed, so the durable wake is
        // tomorrow's routine.
        let dormant = ScheduledActivity {
            kind: ScheduledActivityKind::DailyRoutine,
            due_time: departure + GAME_DAY_SECONDS,
        };
        before.sims[0].next_activity = Some(dormant.clone());
        let mut after = before.clone();
        after
            .buildings
            .push(reconcile_market("building-001", Point::from((8, 3)), 0.0));
        let mut world = build_world(&before);
        let entity = world.resource::<PopulationIndex>().by_id["sim-001"];
        let dormant = world.get::<NextActivity>(entity).unwrap().0.clone();
        assert_eq!(dormant.kind, ScheduledActivityKind::DailyRoutine);
        assert_eq!(dormant.due_time, departure + GAME_DAY_SECONDS);

        let mutation = reconcile_buildings(&mut world, &before, &mut after);

        assert!(mutation.changed);
        assert_eq!(
            citizen_workplaces(&mut world, after.day),
            vec![("sim-001".to_string(), Some(Point::from((8, 3))))]
        );
        assert_eq!(
            world.get::<NextActivity>(entity).unwrap().0,
            dormant,
            "a late assignment must not gain a retroactive outbound"
        );
        assert_index_rebuilt(&mut world);
        let mut schedule = build_schedule();
        let missed = run_due(&mut world, &mut schedule, departure);
        assert!(!missed.changed);
        assert!(drain_trip_demands(&mut world).is_empty());

        let next_departure = departure + GAME_DAY_SECONDS;
        let result = run_due(&mut world, &mut schedule, next_departure);
        assert!(result.changed);
        let demands = drain_trip_demands(&mut world);
        assert_eq!(demands.len(), 1);
        assert_eq!(demands[0].citizen_id, "sim-001");
        assert_eq!(demands[0].scheduled_time, next_departure);
    }

    #[test]
    fn reconciled_removal_leaves_cross_midnight_traveller_unwakeable() {
        let mut before = reconcile_sandbox(100.0);
        before.buildings = vec![reconcile_market("building-001", Point::from((8, 3)), 0.0)];
        before.sims = vec![reconcile_worker(
            "sim-001",
            Point::from((2, 3)),
            Some(Point::from((8, 3))),
        )];
        before.active_trips = vec![reconcile_trip(
            "trip-1",
            "sim-001",
            TripPurpose::CommuteOutbound,
            Point::from((2, 3)),
            Point::from((8, 3)),
            TripStatus::Riding,
        )];
        let mut after = before.clone();
        after.buildings.clear();
        after
            .buildings
            .push(reconcile_market("building-002", Point::from((12, 3)), 0.0));
        let mut world = build_world(&before);
        let entity = world.resource::<PopulationIndex>().by_id["sim-001"];
        assert!(world.get::<NextActivity>(entity).is_none());

        let mutation = reconcile_buildings(&mut world, &before, &mut after);

        assert!(mutation.changed);
        let trip = &after.active_trips[0];
        assert_eq!(trip.status, TripStatus::Idle);
        assert_eq!(trip.destination, Point::from((12, 3)));
        assert_eq!(
            citizen_workplaces(&mut world, after.day),
            vec![("sim-001".to_string(), Some(Point::from((12, 3))))]
        );
        assert!(
            world.get::<NextActivity>(entity).is_none(),
            "an active trip owns the citizen; no NextActivity may appear"
        );
        let mut schedule = build_schedule();
        let departure = sim_departure_time("sim-001", before.day);
        let missed = run_due(&mut world, &mut schedule, departure);
        assert!(!missed.changed, "CollectDue must not wake the traveller");
        let much_later = run_due(
            &mut world,
            &mut schedule,
            departure + 10.0 * GAME_DAY_SECONDS,
        );
        assert!(!much_later.changed);
        assert!(drain_trip_demands(&mut world).is_empty());
        assert_index_rebuilt(&mut world);
    }

    #[test]
    fn stranded_worker_schedules_next_day_recovery_without_phantom_outbound() {
        let mut before = reconcile_sandbox(100.0);
        before.buildings = vec![reconcile_market("building-001", Point::from((8, 3)), 0.0)];
        before.sims = vec![reconcile_worker(
            "sim-001",
            Point::from((2, 3)),
            Some(Point::from((8, 3))),
        )];
        before.active_trips = vec![reconcile_trip(
            "trip-1",
            "sim-001",
            TripPurpose::CommuteOutbound,
            Point::from((2, 3)),
            Point::from((8, 3)),
            TripStatus::Walking,
        )];
        before.transit.vehicles = vec![reconcile_vehicle(&["trip-1", "trip-other"])];
        let mut after = before.clone();
        after.buildings.clear();
        let mut world = build_world(&before);
        let entity = world.resource::<PopulationIndex>().by_id["sim-001"];

        let mutation = reconcile_buildings(&mut world, &before, &mut after);

        assert!(mutation.changed);
        assert!(
            after.active_trips.is_empty(),
            "the orphaned outbound is dropped"
        );
        assert_eq!(
            after.transit.vehicles[0].passenger_ids,
            vec!["trip-other"],
            "only the dropped trip loses its seat"
        );
        let recovery = world.get::<NextActivity>(entity).unwrap().0.clone();
        assert_eq!(recovery.kind, ScheduledActivityKind::DailyRoutine);
        assert_eq!(
            recovery.due_time,
            sim_departure_time("sim-001", 0) + GAME_DAY_SECONDS,
            "recovery is next day's routine wake, never a phantom outbound"
        );

        let mut schedule = build_schedule();
        run_due(&mut world, &mut schedule, recovery.due_time);
        assert!(
            drain_trip_demands(&mut world).is_empty(),
            "without a workplace the recovery wake must emit nothing"
        );
        assert_eq!(
            world.get::<NextActivity>(entity).unwrap().0.due_time,
            recovery.due_time + GAME_DAY_SECONDS
        );
        assert_index_rebuilt(&mut world);
    }

    #[test]
    fn retargeted_outbound_gets_fresh_deadline_patience_and_passenger_scrub() {
        let mut before = reconcile_sandbox(5_000.0);
        before.buildings = vec![
            reconcile_market("building-001", Point::from((8, 3)), 0.0),
            reconcile_market("building-002", Point::from((12, 3)), 0.0),
        ];
        before.sims = vec![reconcile_worker(
            "sim-001",
            Point::from((2, 5)),
            Some(Point::from((8, 3))),
        )];
        let mut trip = reconcile_trip(
            "trip-001",
            "sim-001",
            TripPurpose::CommuteOutbound,
            Point::from((2, 5)),
            Point::from((8, 3)),
            TripStatus::Riding,
        );
        // Mid-commute: deadline elapsed, patience nearly drained.
        trip.deadline = 1_000.0;
        trip.patience_remaining = 2.0;
        trip.route_plan = Some(RoutePlan {
            legs: Vec::new(),
            estimated_seconds: 120.0,
        });
        trip.private_car_trip = Some(PrivateCarTrip {
            path: crate::model::TransitPath::Road {
                steps: Vec::new(),
                total_travel_seconds: 0.0,
            },
            arrival_time: 101.25,
        });
        before.active_trips = vec![trip];
        before.transit.vehicles = vec![reconcile_vehicle(&["trip-001", "trip-other"])];
        let mut after = before.clone();
        after
            .buildings
            .retain(|building| building.id != "building-001");
        let mut world = build_world(&before);

        let mutation = reconcile_buildings(&mut world, &before, &mut after);

        assert!(mutation.changed);
        let trip = &after.active_trips[0];
        assert_eq!(trip.status, TripStatus::Idle);
        assert!(trip.route_plan.is_none());
        assert!(trip.private_car_trip.is_none());
        assert_eq!(trip.current_leg_index, 0);
        assert_eq!(trip.current_leg_wait_seconds, 0.0);
        assert_eq!(trip.destination, Point::from((12, 3)));
        assert_eq!(
            trip.deadline,
            trip_deadline_seconds(after.time),
            "retargeting starts a fresh trip window"
        );
        assert_eq!(trip.patience_remaining, crate::trips::WAIT_PATIENCE_SECONDS);
        assert_eq!(
            after.transit.vehicles[0].passenger_ids,
            vec!["trip-other"],
            "the reset trip must not keep a ghost seat"
        );
        assert_index_rebuilt(&mut world);
    }

    #[test]
    fn return_trip_keeps_home_destination_through_workplace_removal() {
        let mut before = reconcile_sandbox(100.0);
        before.buildings = vec![
            reconcile_market("building-001", Point::from((8, 3)), 0.0),
            reconcile_market("building-002", Point::from((12, 3)), 0.0),
        ];
        before.sims = vec![reconcile_worker(
            "sim-001",
            Point::from((2, 3)),
            Some(Point::from((8, 3))),
        )];
        let mut trip = reconcile_trip(
            "trip-1",
            "sim-001",
            TripPurpose::CommuteReturn,
            Point::from((8, 3)),
            Point::from((2, 3)),
            TripStatus::Walking,
        );
        trip.route_plan = Some(RoutePlan {
            legs: Vec::new(),
            estimated_seconds: 60.0,
        });
        before.active_trips = vec![trip];
        let mut after = before.clone();
        after
            .buildings
            .retain(|building| building.id != "building-001");
        let mut world = build_world(&before);
        let entity = world.resource::<PopulationIndex>().by_id["sim-001"];

        let mutation = reconcile_buildings(&mut world, &before, &mut after);

        assert!(mutation.changed);
        // Workplace reassigned to the replacement...
        assert_eq!(
            citizen_workplaces(&mut world, after.day),
            vec![("sim-001".to_string(), Some(Point::from((12, 3))))]
        );
        // ...but the in-flight return trip still heads home.
        let trip = &after.active_trips[0];
        assert_eq!(trip.purpose, TripPurpose::CommuteReturn);
        assert_eq!(trip.destination, Point::from((2, 3)));
        assert_eq!(trip.status, TripStatus::Walking);
        assert!(trip.route_plan.is_some());
        assert_eq!(trip.deadline, 900.0);
        assert_eq!(trip.patience_remaining, 240.0);
        assert!(world.get::<NextActivity>(entity).is_none());
        assert_index_rebuilt(&mut world);
    }
}

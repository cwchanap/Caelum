use crate::building_catalog::building_definition;
use crate::buildings::assign_workplaces;
use crate::clock::{GAME_DAY_SECONDS, MINUTES_PER_DAY};
use crate::commute::{departure_minute_for_sim, shift_template_for_id, worker_profile_for_id};
use crate::ids::next_entity_id;
use crate::model::{GameMode, GameSnapshot, PlacedBuilding, Sim};

mod components;
mod schedule;

pub const MOVE_IN_INTERVAL_SECONDS: f64 = GAME_DAY_SECONDS / 24.0;

pub fn resident_occupancy(state: &GameSnapshot, building: &PlacedBuilding) -> usize {
    state
        .sims
        .iter()
        .filter(|sim| building.occupied_tiles.contains(&sim.home))
        .count()
}

pub(crate) fn job_occupancy(state: &GameSnapshot, building: &PlacedBuilding) -> usize {
    state
        .sims
        .iter()
        .filter(|sim| {
            sim.workplace
                .is_some_and(|workplace| building.occupied_tiles.contains(&workplace))
        })
        .count()
}

pub fn apply_due_move_ins(state: &mut GameSnapshot) {
    if state.rules.game_mode != GameMode::Sandbox {
        return;
    }

    let mut housing_ids: Vec<String> = state
        .buildings
        .iter()
        .filter(|building| {
            building_definition(&building.building_type)
                .is_some_and(|definition| definition.resident_capacity > 0)
        })
        .map(|building| building.id.clone())
        .collect();
    housing_ids.sort();

    let mut added_resident = false;
    for building_id in housing_ids {
        let Some(building) = state
            .buildings
            .iter()
            .find(|building| building.id == building_id)
            .cloned()
        else {
            continue;
        };
        let Some(definition) = building_definition(&building.building_type) else {
            continue;
        };
        let Some(tile_count) =
            (!building.occupied_tiles.is_empty()).then_some(building.occupied_tiles.len())
        else {
            continue;
        };
        let capacity = usize::from(definition.resident_capacity);
        let mut occupancy = resident_occupancy(state, &building);

        while occupancy < capacity {
            let due = building.placed_at + occupancy as f64 * MOVE_IN_INTERVAL_SECONDS;
            if due > state.time {
                break;
            }

            let sim_id = next_entity_id("sim", state.sims.iter().map(|sim| sim.id.clone()));
            let home = building.occupied_tiles[occupancy % tile_count];
            let worker_profile = worker_profile_for_id(&sim_id);
            let shift_template = shift_template_for_id(&sim_id).map(str::to_string);
            let outbound_resolved_today = shift_template.as_deref().is_some_and(|template| {
                let departure = departure_minute_for_sim(&sim_id, template, "outbound");
                state.time > scheduled_time_seconds(state.day, departure)
            });

            state.sims.push(Sim {
                id: sim_id,
                home,
                position: home,
                worker_profile,
                shift_template,
                workplace: None,
                commute_day: state.day,
                outbound_resolved_today,
                outbound_arrived_today: false,
                return_resolved_today: false,
                returned_home_today: false,
            });
            occupancy += 1;
            added_resident = true;
        }
    }

    if added_resident {
        assign_workplaces(state);
    }
}

fn scheduled_time_seconds(day: u32, minute: u16) -> f64 {
    f64::from(day) * GAME_DAY_SECONDS
        + (f64::from(minute) / f64::from(MINUTES_PER_DAY)) * GAME_DAY_SECONDS
}

#[cfg(test)]
mod tests {
    use bevy_ecs::prelude::{Entity, World};

    use super::building_definition;
    use super::components::{CitizenId, HomeAssignment, LegacyDayState, Routine, SettledPosition};
    use super::job_occupancy;
    use super::schedule::{
        build_world_v9, job_occupancy_for_building, population_count, rebuilt_index,
        resident_occupancy_for_building, snapshot_sims_v9, spawn_indexed_citizen,
        NextCitizenOrdinal, PopulationIndex,
    };
    use crate::ids::entity_id;
    use crate::model::{GameSnapshot, PlacedBuilding, Point, Sim, WorkerProfile};
    use crate::sandbox::{create_sandbox_snapshot, SandboxCreationRequest};
    use crate::state::create_initial_snapshot;

    fn population_fixture() -> GameSnapshot {
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
        let base = Sim {
            id: String::new(),
            home,
            position: home,
            worker_profile: WorkerProfile::Worker,
            shift_template: Some("standard".to_string()),
            workplace: Some(shop),
            commute_day: 5,
            outbound_resolved_today: false,
            outbound_arrived_today: false,
            return_resolved_today: false,
            returned_home_today: false,
        };
        snapshot.sims = vec![
            Sim {
                id: "sim-001".to_string(),
                ..base.clone()
            },
            Sim {
                id: "sim-002".to_string(),
                home: other_home,
                position: Point {
                    x: other_home.x + 1,
                    y: other_home.y,
                },
                shift_template: Some("swing".to_string()),
                workplace: None,
                ..base.clone()
            },
            Sim {
                id: "sim-003".to_string(),
                workplace: Some(factory),
                ..base.clone()
            },
            Sim {
                id: "sim-004".to_string(),
                home: other_home,
                worker_profile: WorkerProfile::NonWorker,
                shift_template: None,
                workplace: None,
                ..base
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
        let world = build_world_v9(&snapshot);
        assert_eq!(population_count(&world), snapshot.sims.len() as u32);
        assert_eq!(snapshot_sims_v9(&world, snapshot.day), snapshot.sims);
    }

    #[test]
    fn allocator_does_not_reuse_a_deleted_highest_id() {
        let snapshot = population_fixture();
        let mut world = build_world_v9(&snapshot);
        let before = world.resource::<NextCitizenOrdinal>().0;
        despawn_highest_fixture_citizen(&mut world);
        assert_eq!(world.resource::<NextCitizenOrdinal>().0, before);
    }

    #[test]
    fn rebuilt_index_matches_the_index_built_from_snapshot() {
        let snapshot = population_fixture();
        let mut world = build_world_v9(&snapshot);
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
                    LegacyDayState {
                        commute_day: 0,
                        outbound_resolved: false,
                        outbound_arrived: false,
                        return_resolved: false,
                        returned_home: true,
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

    #[test]
    fn job_occupancy_counts_workplace_membership() {
        let mut snapshot = create_initial_snapshot();
        let building = PlacedBuilding {
            id: "building-001".to_string(),
            building_type: "supermarket".to_string(),
            origin: Point::from((4, 4)),
            rotation: 0,
            occupied_tiles: vec![Point::from((4, 4)), Point::from((5, 4))],
            placed_at: 0.0,
            transit_node_id: None,
        };
        snapshot.sims = vec![
            Sim {
                id: "sim-inside".to_string(),
                home: Point::from((0, 0)),
                position: Point::from((0, 0)),
                worker_profile: WorkerProfile::Worker,
                shift_template: None,
                workplace: Some(Point::from((5, 4))),
                commute_day: 0,
                outbound_resolved_today: false,
                outbound_arrived_today: false,
                return_resolved_today: false,
                returned_home_today: false,
            },
            Sim {
                id: "sim-outside".to_string(),
                home: Point::from((0, 0)),
                position: Point::from((0, 0)),
                worker_profile: WorkerProfile::Worker,
                shift_template: None,
                workplace: Some(Point::from((9, 9))),
                commute_day: 0,
                outbound_resolved_today: false,
                outbound_arrived_today: false,
                return_resolved_today: false,
                returned_home_today: false,
            },
            Sim {
                id: "sim-none".to_string(),
                home: Point::from((0, 0)),
                position: Point::from((0, 0)),
                worker_profile: WorkerProfile::Worker,
                shift_template: None,
                workplace: None,
                commute_day: 0,
                outbound_resolved_today: false,
                outbound_arrived_today: false,
                return_resolved_today: false,
                returned_home_today: false,
            },
        ];

        assert_eq!(job_occupancy(&snapshot, &building), 1);
    }
}

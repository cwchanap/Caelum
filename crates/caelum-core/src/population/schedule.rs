use std::collections::{BTreeMap, BTreeSet, HashMap};

use bevy_ecs::prelude::*;

use super::components::{
    BuildingAssignment, CitizenId, HomeAssignment, LegacyDayState, Routine, SettledPosition,
};
use crate::building_catalog::building_definition;
use crate::commute::numeric_id_suffix;
use crate::model::{GameSnapshot, Point, Sim, WorkerProfile};

/// Rebuildable derived indexes over the population world. Reconstructed from
/// components via [`rebuilt_index`] (test-only) or maintained incrementally by
/// [`spawn_indexed_citizen`].
#[derive(Resource, Clone, Debug, Default, PartialEq)]
pub(super) struct PopulationIndex {
    by_id: BTreeMap<String, Entity>,
    residents_by_building: BTreeMap<String, Vec<Entity>>,
    workers_by_building: BTreeMap<String, Vec<Entity>>,
    unassigned_workers: BTreeSet<String>,
    buildings: BTreeMap<String, PopulationBuilding>,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct PopulationBuilding {
    pub(super) occupied_tiles: Vec<Point>,
    pub(super) resident_capacity: u16,
    pub(super) job_capacity: u16,
}

/// Monotonic citizen allocator. Initialized once from the durable sim ids and
/// never recomputed after despawn, so a deleted highest id is never reused.
#[derive(Resource, Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct NextCitizenOrdinal(pub(super) usize);

pub(crate) fn build_world_v9(snapshot: &GameSnapshot) -> World {
    let mut buildings = BTreeMap::new();
    let mut building_by_tile: HashMap<Point, String> = HashMap::new();
    for building in &snapshot.buildings {
        let Some(definition) = building_definition(&building.building_type) else {
            continue;
        };
        if definition.resident_capacity == 0 && definition.job_capacity == 0 {
            continue;
        }
        buildings.insert(
            building.id.clone(),
            PopulationBuilding {
                occupied_tiles: building.occupied_tiles.clone(),
                resident_capacity: definition.resident_capacity,
                job_capacity: definition.job_capacity,
            },
        );
        for tile in &building.occupied_tiles {
            building_by_tile.insert(*tile, building.id.clone());
        }
    }

    let mut index = PopulationIndex {
        buildings,
        ..Default::default()
    };
    let mut world = World::new();
    let next_ordinal = snapshot
        .sims
        .iter()
        .map(|sim| numeric_id_suffix(&sim.id))
        .max()
        .unwrap_or(0)
        + 1;

    for sim in &snapshot.sims {
        let home = HomeAssignment {
            building_id: building_by_tile.get(&sim.home).cloned(),
            point: sim.home,
        };
        let routine = match sim.worker_profile {
            WorkerProfile::Worker => Routine::Worker {
                shift_template: sim.shift_template.clone().unwrap_or_default(),
                workplace: sim.workplace.map(|point| BuildingAssignment {
                    building_id: building_by_tile.get(&point).cloned(),
                    point,
                }),
            },
            WorkerProfile::NonWorker => Routine::Student,
        };
        let day_state = LegacyDayState {
            commute_day: sim.commute_day,
            outbound_resolved: sim.outbound_resolved_today,
            outbound_arrived: sim.outbound_arrived_today,
            return_resolved: sim.return_resolved_today,
            returned_home: sim.returned_home_today,
        };
        spawn_indexed_citizen(
            &mut world,
            &mut index,
            (
                CitizenId(sim.id.clone()),
                home,
                SettledPosition(sim.position),
                routine,
                day_state,
            ),
        );
    }

    world.insert_resource(index);
    world.insert_resource(NextCitizenOrdinal(next_ordinal));
    world
}

pub(crate) fn snapshot_sims_v9(world: &World, _day: u32) -> Vec<Sim> {
    let index = world.resource::<PopulationIndex>();
    let mut ids: Vec<&String> = index.by_id.keys().collect();
    ids.sort_by_key(|id| numeric_id_suffix(id));
    ids.into_iter()
        .map(|id| {
            let entity = index.by_id[id];
            let citizen_id = world
                .get::<CitizenId>(entity)
                .expect("indexed citizen must carry a CitizenId");
            let home = world
                .get::<HomeAssignment>(entity)
                .expect("indexed citizen must carry a HomeAssignment");
            let position = world
                .get::<SettledPosition>(entity)
                .expect("indexed citizen must carry a SettledPosition");
            let routine = world
                .get::<Routine>(entity)
                .expect("indexed citizen must carry a Routine");
            let day_state = world
                .get::<LegacyDayState>(entity)
                .expect("indexed citizen must carry a LegacyDayState");
            let (worker_profile, shift_template, workplace) = match routine {
                Routine::Worker {
                    shift_template,
                    workplace,
                } => (
                    WorkerProfile::Worker,
                    Some(shift_template.clone()),
                    workplace.as_ref().map(|assignment| assignment.point),
                ),
                Routine::Student => (WorkerProfile::NonWorker, None, None),
            };
            Sim {
                id: citizen_id.0.clone(),
                home: home.point,
                position: position.0,
                worker_profile,
                shift_template,
                workplace,
                commute_day: day_state.commute_day,
                outbound_resolved_today: day_state.outbound_resolved,
                outbound_arrived_today: day_state.outbound_arrived,
                return_resolved_today: day_state.return_resolved,
                returned_home_today: day_state.returned_home,
            }
        })
        .collect()
}

pub(crate) fn population_count(world: &World) -> u32 {
    world.resource::<PopulationIndex>().by_id.len() as u32
}

pub(crate) fn resident_occupancy_for_building(world: &World, building_id: &str) -> u32 {
    world
        .resource::<PopulationIndex>()
        .residents_by_building
        .get(building_id)
        .map_or(0, Vec::len) as u32
}

pub(crate) fn job_occupancy_for_building(world: &World, building_id: &str) -> u32 {
    world
        .resource::<PopulationIndex>()
        .workers_by_building
        .get(building_id)
        .map_or(0, Vec::len) as u32
}

/// Spawns one citizen bundle and maintains every entity-derived index entry.
/// Shared by [`build_world_v9`] and the 200k structural construction test.
pub(super) fn spawn_indexed_citizen(
    world: &mut World,
    index: &mut PopulationIndex,
    components: (
        CitizenId,
        HomeAssignment,
        SettledPosition,
        Routine,
        LegacyDayState,
    ),
) -> Entity {
    let (citizen_id, home, position, routine, day_state) = components;
    let entity = world
        .spawn((
            citizen_id.clone(),
            home.clone(),
            position,
            routine.clone(),
            day_state,
        ))
        .id();
    index_citizen(index, entity, &citizen_id, &home, &routine);
    entity
}

fn index_citizen(
    index: &mut PopulationIndex,
    entity: Entity,
    citizen_id: &CitizenId,
    home: &HomeAssignment,
    routine: &Routine,
) {
    index.by_id.insert(citizen_id.0.clone(), entity);
    if let Some(building_id) = &home.building_id {
        index
            .residents_by_building
            .entry(building_id.clone())
            .or_default()
            .push(entity);
    }
    match routine {
        Routine::Worker {
            workplace: Some(assignment),
            ..
        } => {
            if let Some(building_id) = &assignment.building_id {
                index
                    .workers_by_building
                    .entry(building_id.clone())
                    .or_default()
                    .push(entity);
            }
        }
        Routine::Worker {
            workplace: None, ..
        } => {
            index.unassigned_workers.insert(citizen_id.0.clone());
        }
        Routine::Student => {}
    }
}

/// Independent reconstruction of every entity-derived index field from the
/// live components. Never reconstructs [`NextCitizenOrdinal`].
#[cfg(test)]
pub(super) fn rebuilt_index(world: &mut World) -> PopulationIndex {
    let mut rebuilt = PopulationIndex {
        buildings: world.resource::<PopulationIndex>().buildings.clone(),
        ..Default::default()
    };
    let mut query = world.query::<(Entity, &CitizenId, &HomeAssignment, &Routine)>();
    let mut rows = query
        .iter(world)
        .map(|(entity, citizen_id, home, routine)| {
            (entity, citizen_id.clone(), home.clone(), routine.clone())
        })
        .collect::<Vec<_>>();
    rows.sort_by_key(|(entity, ..)| entity.index_u32());
    for (entity, citizen_id, home, routine) in rows {
        index_citizen(&mut rebuilt, entity, &citizen_id, &home, &routine);
    }
    rebuilt
}

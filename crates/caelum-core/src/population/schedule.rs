use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::ops::Bound::{Excluded, Unbounded};

use bevy_ecs::prelude::*;

use super::components::{
    BuildingAssignment, CitizenId, HomeAssignment, LegacyDayState, NextActivity, Routine,
    SettledPosition,
};
use super::{scheduled_time_seconds, MOVE_IN_INTERVAL_SECONDS};
use crate::building_catalog::building_definition;
use crate::clock::{day_index, GAME_DAY_SECONDS};
use crate::commute::{
    departure_minute_for_sim, numeric_id_suffix, shift_template_for_id, trip_deadline_seconds,
    worker_profile_for_id,
};
use crate::ids::entity_id;
use crate::model::{
    GameMode, GameSnapshot, PlacedBuilding, Point, ScheduledActivity, ScheduledActivityKind, Sim,
    TripPurpose, TripStatus, WorkerProfile,
};
use crate::trips::{is_terminal_status, EPSILON, WAIT_PATIENCE_SECONDS};

/// Rebuildable derived indexes over the population world. Reconstructed from
/// components via [`rebuilt_index`] (test-only) or maintained incrementally by
/// [`spawn_indexed_citizen`].
#[derive(Resource, Clone, Debug, Default, PartialEq)]
pub(super) struct PopulationIndex {
    pub(super) by_id: BTreeMap<String, Entity>,
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

    let mut pending_activities = Vec::with_capacity(snapshot.sims.len());
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
        // Convert the v9 daily state into final scheduler kinds exactly once
        // on load; the scheduler owns every wake afterwards. No per-tick
        // population scan re-derives these.
        let next_activity = if snapshot
            .active_trips
            .iter()
            .any(|trip| trip.sim_id == sim.id && !is_terminal_status(trip.status))
        {
            // Cross-midnight travellers carry no NextActivity until their trip
            // resolves.
            None
        } else {
            match &routine {
                Routine::Worker { shift_template, .. } => Some(worker_next_activity(
                    &sim.id,
                    shift_template,
                    sim.commute_day,
                    &day_state,
                    snapshot.time,
                )),
                Routine::Student => Some(next_student_daily_routine(sim.commute_day)),
            }
        };
        pending_activities.push((sim.id.clone(), next_activity));
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
    // Template and restored housing: schedule every housing slot as an
    // exact-time move-in (Sandbox only), mirroring `reconcile_buildings` for
    // added housing. This replaces the deleted shell move-in scan;
    // `apply_move_in` revalidates occupancy, so slots already filled by
    // durable sims are skipped when their due time arrives.
    if snapshot.rules.game_mode == GameMode::Sandbox {
        let mut scheduler = PopulationScheduler::default();
        for building in &snapshot.buildings {
            let Some(definition) = building_definition(&building.building_type) else {
                continue;
            };
            if definition.resident_capacity == 0 || building.occupied_tiles.is_empty() {
                continue;
            }
            for slot in 0..definition.resident_capacity {
                insert_scheduler_event(
                    &mut scheduler,
                    building.placed_at + f64::from(slot) * MOVE_IN_INTERVAL_SECONDS,
                    PopulationEvent::MoveIn {
                        building_id: building.id.clone(),
                        slot,
                    },
                );
            }
        }
        world.insert_resource(scheduler);
    } else {
        world.insert_resource(PopulationScheduler::default());
    }
    world.insert_resource(DuePopulationEvents::default());
    world.insert_resource(PendingTripDemands::default());
    world.insert_resource(SchedulerNow(snapshot.time));
    for (citizen_id, next_activity) in pending_activities {
        let Some(next_activity) = next_activity else {
            continue;
        };
        let entity = world.resource::<PopulationIndex>().by_id[&citizen_id];
        schedule_activity(&mut world, entity, next_activity);
    }
    world
}

pub(crate) fn snapshot_sims_v9(world: &World, day: u32) -> Vec<Sim> {
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
            // Mirror the deleted shell midnight reset: a citizen whose flags
            // still belong to a previous day exports fresh flags for the
            // current day (their wake rolls the live component itself).
            let exported_day_state = if day_state.commute_day == day {
                day_state.clone()
            } else if day_state.commute_day < day {
                LegacyDayState {
                    commute_day: day,
                    outbound_resolved: false,
                    outbound_arrived: false,
                    return_resolved: false,
                    returned_home: false,
                }
            } else {
                day_state.clone()
            };
            let (worker_profile, shift_template, workplace) = match routine {
                Routine::Worker {
                    shift_template,
                    workplace,
                } => (
                    WorkerProfile::Worker,
                    // The `""` sentinel maps back to the durable `None`.
                    (!shift_template.is_empty()).then(|| shift_template.clone()),
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
                commute_day: exported_day_state.commute_day,
                outbound_resolved_today: exported_day_state.outbound_resolved,
                outbound_arrived_today: exported_day_state.outbound_arrived,
                return_resolved_today: exported_day_state.return_resolved,
                returned_home_today: exported_day_state.returned_home,
            }
        })
        .collect()
}

#[cfg(test)]
pub(crate) fn population_count(world: &World) -> u32 {
    world.resource::<PopulationIndex>().by_id.len() as u32
}

/// Number of distinct scheduler due-time keys. The tick's initial substep cap
/// includes these so every currently scheduled wake can fire within one tick.
pub(crate) fn scheduler_due_key_count(world: &World) -> usize {
    world.resource::<PopulationScheduler>().buckets.len()
}

/// Live presentation aggregates derived from the ECS population indexes. The
/// engine supplies these to the projector instead of reconstructing a
/// population mirror into the shell snapshot.
pub(crate) fn presentation_aggregates(world: &World) -> crate::presentation::PopulationAggregates {
    let index = world.resource::<PopulationIndex>();
    let building_occupancy = index
        .buildings
        .keys()
        .map(|building_id| {
            let occupancy = if index.buildings[building_id].resident_capacity > 0 {
                index
                    .residents_by_building
                    .get(building_id)
                    .map_or(0, Vec::len)
            } else {
                index
                    .workers_by_building
                    .get(building_id)
                    .map_or(0, Vec::len)
            };
            (building_id.clone(), occupancy as u32)
        })
        .collect();
    crate::presentation::PopulationAggregates {
        population_count: index.by_id.len() as u32,
        building_occupancy,
    }
}

#[cfg(test)]
pub(crate) fn resident_occupancy_for_building(world: &World, building_id: &str) -> u32 {
    world
        .resource::<PopulationIndex>()
        .residents_by_building
        .get(building_id)
        .map_or(0, Vec::len) as u32
}

#[cfg(test)]
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

// === Targeted building reconciliation ===

/// Outcome of one [`reconcile_buildings`] pass. Scheduling future move-ins
/// alone is not a population mutation; despawns, workplace (re)assignment,
/// trip retargets/drops, and recovery scheduling are.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PopulationMutation {
    pub(crate) changed: bool,
}

fn take_index(world: &mut World) -> PopulationIndex {
    world
        .remove_resource::<PopulationIndex>()
        .expect("population index must exist")
}

/// Reconcile the live population world with a shell candidate whose building
/// set changed. Only changed building IDs are handled:
///
/// - added Sandbox housing schedules each slot as an exact-time move-in
///   (campaign reconciliation schedules nothing);
/// - removed housing despawns exactly its residents and scrubs their trips
///   and vehicle passenger references from the candidate;
/// - removed workplaces clear their surviving workers into the shared
///   unassigned set, then one global refill exposes every free job slot in
///   stable building-ID/slot order to the globally lowest unassigned IDs;
/// - affected outbound trips are retargeted with the existing idle-reset
///   semantics (fresh deadline/patience window) or — without a replacement —
///   dropped, with next-day daily-routine recovery for the stranded citizen.
///
/// Shell and preview paths never call this; the engine applies it to real
/// building-changing candidates only.
pub(crate) fn reconcile_buildings(
    world: &mut World,
    before: &GameSnapshot,
    after: &mut GameSnapshot,
) -> PopulationMutation {
    let mut changed = false;
    let before_ids: BTreeSet<&str> = before
        .buildings
        .iter()
        .map(|building| building.id.as_str())
        .collect();
    let after_ids: BTreeSet<&str> = after
        .buildings
        .iter()
        .map(|building| building.id.as_str())
        .collect();
    let added: Vec<&PlacedBuilding> = after
        .buildings
        .iter()
        .filter(|building| !before_ids.contains(building.id.as_str()))
        .collect();
    let removed_ids: Vec<String> = before
        .buildings
        .iter()
        .filter(|building| !after_ids.contains(building.id.as_str()))
        .map(|building| building.id.clone())
        .collect();

    // Structural entries: drop removed buildings, register added ones.
    {
        let mut index = take_index(world);
        for building_id in &removed_ids {
            index.buildings.remove(building_id);
        }
        for building in &added {
            let Some(definition) = building_definition(&building.building_type) else {
                continue;
            };
            if definition.resident_capacity == 0 && definition.job_capacity == 0 {
                continue;
            }
            index.buildings.insert(
                building.id.clone(),
                PopulationBuilding {
                    occupied_tiles: building.occupied_tiles.clone(),
                    resident_capacity: definition.resident_capacity,
                    job_capacity: definition.job_capacity,
                },
            );
        }
        world.insert_resource(index);
    }

    // Added Sandbox housing schedules every slot at its exact due time;
    // `apply_move_in` revalidates occupancy, so slots already due fill in
    // canonical (building_id, slot) order. Campaign reconciliation schedules
    // nothing.
    if after.rules.game_mode == GameMode::Sandbox {
        for building in &added {
            let Some(definition) = building_definition(&building.building_type) else {
                continue;
            };
            if definition.resident_capacity == 0 || building.occupied_tiles.is_empty() {
                continue;
            }
            for slot in 0..definition.resident_capacity {
                let due_time = building.placed_at + f64::from(slot) * MOVE_IN_INTERVAL_SECONDS;
                insert_scheduler_event(
                    &mut world.resource_mut::<PopulationScheduler>(),
                    due_time,
                    PopulationEvent::MoveIn {
                        building_id: building.id.clone(),
                        slot,
                    },
                );
            }
        }
    }

    // Removed housing despawns exactly its residents; removed workplaces clear
    // their surviving workers back into the shared unassigned set. Despawned
    // residents were already removed from every worker entry with their
    // entity, so a cleared building's own workers are all survivors.
    let mut despawned_ids: HashSet<String> = HashSet::new();
    let mut cleared: Vec<(Entity, String)> = Vec::new();
    {
        let mut index = take_index(world);
        for building_id in &removed_ids {
            let residents = index
                .residents_by_building
                .get(building_id)
                .cloned()
                .unwrap_or_default();
            for entity in residents {
                let Some(citizen_id) = world.get::<CitizenId>(entity).map(|c| c.0.clone()) else {
                    continue;
                };
                let job_building_id = match world.get::<Routine>(entity) {
                    Some(Routine::Worker {
                        workplace: Some(assignment),
                        ..
                    }) => assignment.building_id.clone(),
                    _ => None,
                };
                world.despawn(entity);
                index.by_id.remove(&citizen_id);
                index.unassigned_workers.remove(&citizen_id);
                if let Some(job_building_id) = job_building_id {
                    if let Some(rows) = index.workers_by_building.get_mut(&job_building_id) {
                        rows.retain(|row| *row != entity);
                    }
                }
                despawned_ids.insert(citizen_id);
                changed = true;
            }
            index.residents_by_building.remove(building_id);

            let workers = index
                .workers_by_building
                .get(building_id)
                .cloned()
                .unwrap_or_default();
            for entity in workers {
                let Some(citizen_id) = world.get::<CitizenId>(entity).map(|c| c.0.clone()) else {
                    continue;
                };
                if let Some(mut routine) = world.get_mut::<Routine>(entity) {
                    if let Routine::Worker { workplace, .. } = &mut *routine {
                        *workplace = None;
                    }
                }
                index.unassigned_workers.insert(citizen_id.clone());
                cleared.push((entity, citizen_id));
                changed = true;
            }
            index.workers_by_building.remove(building_id);
        }
        world.insert_resource(index);
    }

    // One global refill: every free job slot in stable building-ID/slot order
    // goes to the globally lowest unassigned citizen IDs — never just the
    // workers this reconciliation happened to clear.
    {
        let mut index = take_index(world);
        let building_ids: Vec<String> = index.buildings.keys().cloned().collect();
        for building_id in building_ids {
            let Some(building) = index.buildings.get(&building_id).cloned() else {
                continue;
            };
            if building.job_capacity == 0 || building.occupied_tiles.is_empty() {
                continue;
            }
            loop {
                let used = index
                    .workers_by_building
                    .get(&building_id)
                    .map_or(0, Vec::len);
                if used >= usize::from(building.job_capacity) {
                    break;
                }
                let Some((citizen_id, &entity)) =
                    index
                        .unassigned_workers
                        .iter()
                        .next()
                        .and_then(|citizen_id| {
                            index
                                .by_id
                                .get(citizen_id)
                                .map(|entity| (citizen_id, entity))
                        })
                else {
                    break;
                };
                let citizen_id = citizen_id.clone();
                let point = building.occupied_tiles[used % building.occupied_tiles.len()];
                index.unassigned_workers.remove(&citizen_id);
                index
                    .workers_by_building
                    .entry(building_id.clone())
                    .or_default()
                    .push(entity);
                if let Some(mut routine) = world.get_mut::<Routine>(entity) {
                    if let Routine::Worker { workplace, .. } = &mut *routine {
                        *workplace = Some(BuildingAssignment {
                            building_id: Some(building_id.clone()),
                            point,
                        });
                    }
                }
                changed = true;
            }
        }
        world.insert_resource(index);
    }

    // Trip reconciliation on the shell candidate. Despawned residents lose
    // every trip; only outbound trips of cleared citizens are retargeted or
    // dropped. In-flight returns keep heading home.
    let mut scrubbed_trip_ids: HashSet<String> = HashSet::new();
    if !despawned_ids.is_empty() {
        for trip in &after.active_trips {
            if despawned_ids.contains(&trip.sim_id) {
                scrubbed_trip_ids.insert(trip.id.clone());
            }
        }
        after
            .active_trips
            .retain(|trip| !despawned_ids.contains(&trip.sim_id));
        changed = true;
    }

    let mut replacements: BTreeMap<String, Option<Point>> = BTreeMap::new();
    for (entity, citizen_id) in &cleared {
        let replacement = world
            .get::<Routine>(*entity)
            .and_then(|routine| match routine {
                Routine::Worker { workplace, .. } => {
                    workplace.as_ref().map(|assignment| assignment.point)
                }
                _ => None,
            });
        replacements.insert(citizen_id.clone(), replacement);
    }

    let now = after.time;
    let mut invalidated_trip_ids: HashSet<String> = HashSet::new();
    let mut dropped: Vec<(String, String)> = Vec::new();
    for trip in &mut after.active_trips {
        if trip.purpose != TripPurpose::CommuteOutbound {
            continue;
        }
        let Some(replacement) = replacements.get(&trip.sim_id) else {
            continue;
        };
        invalidated_trip_ids.insert(trip.id.clone());
        match replacement {
            Some(point) => {
                trip.status = TripStatus::Idle;
                trip.route_plan = None;
                trip.private_car_trip = None;
                trip.current_leg_index = 0;
                trip.current_leg_wait_seconds = 0.0;
                trip.destination = *point;
                // Retargeting starts a fresh trip window, mirroring trip
                // creation: an already-drained patience or elapsed deadline
                // must not unserve a validly retargeted trip.
                trip.deadline = trip_deadline_seconds(now);
                trip.patience_remaining = WAIT_PATIENCE_SECONDS;
            }
            None => dropped.push((trip.id.clone(), trip.sim_id.clone())),
        }
    }

    if !invalidated_trip_ids.is_empty() {
        let dropped_ids: HashSet<String> =
            dropped.iter().map(|(trip_id, _)| trip_id.clone()).collect();
        after
            .active_trips
            .retain(|trip| !dropped_ids.contains(&trip.id));
        changed = true;
    }

    scrubbed_trip_ids.extend(invalidated_trip_ids.iter().cloned());
    if !scrubbed_trip_ids.is_empty() {
        for vehicle in &mut after.transit.vehicles {
            vehicle
                .passenger_ids
                .retain(|passenger_id| !scrubbed_trip_ids.contains(passenger_id));
        }
        changed = true;
    }

    // A citizen whose outbound was dropped without a replacement is stranded:
    // schedule next day's daily-routine recovery rather than a phantom
    // zero-distance outbound.
    for (_trip_id, citizen_id) in &dropped {
        let Some(&entity) = world.resource::<PopulationIndex>().by_id.get(citizen_id) else {
            continue;
        };
        let still_travelling = after
            .active_trips
            .iter()
            .any(|trip| trip.sim_id == *citizen_id && !is_terminal_status(trip.status));
        if still_travelling || world.get::<NextActivity>(entity).is_some() {
            continue;
        }
        let Some(Routine::Worker { shift_template, .. }) = world.get::<Routine>(entity) else {
            continue;
        };
        let shift_template = shift_template.clone();
        let commute_day = world
            .get::<LegacyDayState>(entity)
            .map(|state| state.commute_day)
            .unwrap_or_else(|| day_index(now));
        schedule_activity(
            world,
            entity,
            next_worker_daily_routine(citizen_id, &shift_template, commute_day),
        );
        changed = true;
    }

    PopulationMutation { changed }
}

// === Exact-time population scheduler ===

/// Exact validated due timestamp used as a sparse scheduler bucket key.
/// Normalizes signed zero and orders with `f64::total_cmp` so no due time is
/// lost to quotient-minute bucketing or NaN ordering.
#[derive(Clone, Copy, Debug)]
struct ScheduledTime(f64);

impl ScheduledTime {
    fn new(value: f64) -> Self {
        debug_assert!(value.is_finite() && value >= 0.0);
        Self(if value == 0.0 { 0.0 } else { value })
    }
}

impl PartialEq for ScheduledTime {
    fn eq(&self, other: &Self) -> bool {
        self.0.total_cmp(&other.0).is_eq()
    }
}

impl Eq for ScheduledTime {}

impl PartialOrd for ScheduledTime {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for ScheduledTime {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0.total_cmp(&other.0)
    }
}

#[derive(Debug)]
enum PopulationEvent {
    MoveIn { building_id: String, slot: u16 },
    Activity { entity: Entity },
}

/// Sparse exact-time scheduler. `boundary_generation` increments only when an
/// insertion creates a previously vacant exact-time key, so the trip loop can
/// widen its substep cap whenever population work created a new boundary.
#[derive(Resource, Default, Debug)]
struct PopulationScheduler {
    buckets: BTreeMap<ScheduledTime, Vec<PopulationEvent>>,
    boundary_generation: u64,
}

/// Events canonicalized by [`collect_due_events`] for one [`run_due`] pass.
#[derive(Resource, Default)]
struct DuePopulationEvents(Vec<(f64, PopulationEvent)>);

/// Trip rows emitted by [`apply_due_events`], consumed by the trip bridge.
#[derive(Resource, Default)]
struct PendingTripDemands(Vec<TripDemand>);

/// Current engine time for the running pass; refreshed by [`run_due`].
#[derive(Resource, Clone, Copy, Debug, Default)]
struct SchedulerNow(f64);

#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
enum PopulationSet {
    CollectDue,
    ApplyDue,
    EmitTripDemand,
}

/// One trip row handed to the existing `build_commute_trip` routing path.
/// ECS emits demand; it never routes.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TripDemand {
    pub(crate) citizen_id: String,
    pub(crate) purpose: TripPurpose,
    pub(crate) origin: Point,
    pub(crate) destination: Point,
    pub(crate) scheduled_time: f64,
}

/// Outcome of one [`run_due`] pass. `changed` feeds the tick commit invariant
/// (`applied = shell_changed || population_changed`); `boundary_generation`
/// lets the trip loop widen its substep cap by the generation increase.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PopulationRunResult {
    pub(crate) changed: bool,
    pub(crate) boundary_generation: u64,
}

pub(crate) fn build_schedule() -> Schedule {
    let mut schedule = Schedule::default();
    schedule.add_systems((
        collect_due_events.in_set(PopulationSet::CollectDue),
        apply_due_events.in_set(PopulationSet::ApplyDue),
        emit_trip_demands.in_set(PopulationSet::EmitTripDemand),
    ));
    schedule.configure_sets(
        (
            PopulationSet::CollectDue,
            PopulationSet::ApplyDue,
            PopulationSet::EmitTripDemand,
        )
            .chain(),
    );
    schedule
}

/// Drain every scheduler key inside the due band at `now` and run the chained
/// population schedule, repeating while processing created another event due
/// at `now` (e.g. a move-in landing exactly on its citizen's departure).
/// Systems must never reschedule into the same due band — the design forbids
/// same-timestamp retries.
pub(crate) fn run_due(world: &mut World, schedule: &mut Schedule, now: f64) -> PopulationRunResult {
    let mut processed = false;
    loop {
        let horizon = ScheduledTime::new(now + EPSILON);
        let has_due = world
            .resource::<PopulationScheduler>()
            .buckets
            .keys()
            .next()
            .is_some_and(|time| *time <= horizon);
        if !has_due {
            break;
        }
        world.insert_resource(SchedulerNow(now));
        schedule.run(world);
        processed = true;
    }
    PopulationRunResult {
        changed: processed,
        boundary_generation: scheduler_boundary_generation(world),
    }
}

/// Take the accumulated trip demands in canonical
/// `(scheduled_time, citizen_id, purpose-rank)` order.
pub(crate) fn drain_trip_demands(world: &mut World) -> Vec<TripDemand> {
    let mut demands = std::mem::take(&mut world.resource_mut::<PendingTripDemands>().0);
    sort_trip_demands(&mut demands);
    demands
}

/// Earliest exact scheduler key strictly beyond the due band at `now`. Due-now
/// work belongs to [`run_due`]; this is the next future wake for tick boundary
/// discovery — never reconstructed through clock-minute arithmetic.
pub(crate) fn next_population_boundary(world: &World, now: f64) -> Option<f64> {
    let horizon = ScheduledTime::new(now + EPSILON);
    world
        .resource::<PopulationScheduler>()
        .buckets
        .range((Excluded(horizon), Unbounded))
        .next()
        .map(|(time, _)| time.0)
}

pub(crate) fn scheduler_boundary_generation(world: &World) -> u64 {
    world.resource::<PopulationScheduler>().boundary_generation
}

fn insert_scheduler_event(
    scheduler: &mut PopulationScheduler,
    due_time: f64,
    event: PopulationEvent,
) {
    let time = ScheduledTime::new(due_time);
    let vacant = !scheduler.buckets.contains_key(&time);
    scheduler.buckets.entry(time).or_default().push(event);
    if vacant {
        scheduler.boundary_generation = scheduler.boundary_generation.saturating_add(1);
    }
}

/// Install the durable [`NextActivity`] component and its wake event. The
/// component is authoritative state; the bucket entry is only the wake-up.
fn schedule_activity(world: &mut World, entity: Entity, activity: ScheduledActivity) {
    insert_scheduler_event(
        &mut world.resource_mut::<PopulationScheduler>(),
        activity.due_time,
        PopulationEvent::Activity { entity },
    );
    world.entity_mut(entity).insert(NextActivity(activity));
}

/// Canonical same-time order: MoveIn before Activity, MoveIn by
/// `(building_id, slot)`, Activity by resolved stable `CitizenId`.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum DueOrder {
    MoveIn { building_id: String, slot: u16 },
    Activity { citizen_id: String },
}

fn collect_due_events(
    now: Res<SchedulerNow>,
    citizens: Query<&CitizenId>,
    mut scheduler: ResMut<PopulationScheduler>,
    mut due: ResMut<DuePopulationEvents>,
) {
    let horizon = now.0 + EPSILON;
    let mut drained: Vec<(f64, PopulationEvent)> = Vec::new();
    while let Some((&time, _)) = scheduler.buckets.iter().next() {
        if time.0 > horizon {
            break;
        }
        let (_, events) = scheduler
            .buckets
            .remove_entry(&time)
            .expect("key just observed");
        drained.extend(events.into_iter().map(|event| (time.0, event)));
    }

    let mut rows: Vec<(f64, DueOrder, PopulationEvent)> = Vec::with_capacity(drained.len());
    for (due_time, event) in drained {
        let order = match &event {
            PopulationEvent::MoveIn { building_id, slot } => DueOrder::MoveIn {
                building_id: building_id.clone(),
                slot: *slot,
            },
            // Generational handles that no longer resolve are stale and are
            // dropped here, never applied.
            PopulationEvent::Activity { entity } => {
                let Ok(citizen) = citizens.get(*entity) else {
                    continue;
                };
                DueOrder::Activity {
                    citizen_id: citizen.0.clone(),
                }
            }
        };
        rows.push((due_time, order, event));
    }
    rows.sort_by(|left, right| left.0.total_cmp(&right.0).then(left.1.cmp(&right.1)));
    *due = DuePopulationEvents(
        rows.into_iter()
            .map(|(due_time, _, event)| (due_time, event))
            .collect(),
    );
}

/// Exclusive: applies the canonical due events through world-level spawning
/// and index maintenance.
fn apply_due_events(world: &mut World) {
    let due_events = std::mem::take(&mut world.resource_mut::<DuePopulationEvents>().0);
    for (due_time, event) in due_events {
        match event {
            PopulationEvent::MoveIn { building_id, slot } => {
                apply_move_in(world, &building_id, slot)
            }
            PopulationEvent::Activity { entity } => apply_activity(world, entity, due_time),
        }
    }
}

fn apply_move_in(world: &mut World, building_id: &str, slot: u16) {
    // Revalidate the building still offers this housing slot.
    let Some(building) = world
        .resource::<PopulationIndex>()
        .buildings
        .get(building_id)
        .cloned()
        .filter(|building| building.resident_capacity > 0 && !building.occupied_tiles.is_empty())
    else {
        return;
    };
    let occupancy = world
        .resource::<PopulationIndex>()
        .residents_by_building
        .get(building_id)
        .map_or(0, Vec::len);
    if occupancy >= usize::from(building.resident_capacity) {
        return;
    }

    let now = world.resource::<SchedulerNow>().0;
    let ordinal = world.resource::<NextCitizenOrdinal>().0;
    let sim_id = entity_id("sim", ordinal);
    let home = building.occupied_tiles[slot as usize % building.occupied_tiles.len()];
    let commute_day = day_index(now);

    let worker_profile = worker_profile_for_id(&sim_id);
    let shift_template = shift_template_for_id(&sim_id).unwrap_or_default();
    let (day_state, next_activity) = match worker_profile {
        WorkerProfile::Worker => {
            let scheduled = scheduled_time_seconds(
                commute_day,
                departure_minute_for_sim(&sim_id, shift_template, "outbound"),
            );
            // The v9 adapter flag mirrors the conversion: only a departure
            // already lost to a late assignment counts as resolved today.
            let missed_today = now > scheduled + EPSILON;
            let day_state = LegacyDayState {
                commute_day,
                outbound_resolved: missed_today,
                outbound_arrived: false,
                return_resolved: false,
                returned_home: false,
            };
            let next_activity =
                worker_next_activity(&sim_id, shift_template, commute_day, &day_state, now);
            (day_state, next_activity)
        }
        WorkerProfile::NonWorker => (
            LegacyDayState {
                commute_day,
                outbound_resolved: false,
                outbound_arrived: false,
                return_resolved: false,
                returned_home: false,
            },
            next_student_daily_routine(commute_day),
        ),
    };

    // Assign a workplace if one has a free slot (stable building-ID order).
    // Task 3's reconciliation owns the global preserve-and-refill ordering.
    let workplace = match worker_profile {
        WorkerProfile::Worker => find_available_workplace(world.resource::<PopulationIndex>()),
        WorkerProfile::NonWorker => None,
    };
    let routine = match worker_profile {
        WorkerProfile::Worker => Routine::Worker {
            shift_template: shift_template.to_string(),
            workplace: workplace.map(|(job_building_id, point)| BuildingAssignment {
                building_id: Some(job_building_id),
                point,
            }),
        },
        WorkerProfile::NonWorker => Routine::Student,
    };

    world.resource_mut::<NextCitizenOrdinal>().0 = ordinal + 1;
    let mut index = world
        .remove_resource::<PopulationIndex>()
        .expect("population index must exist");
    let entity = spawn_indexed_citizen(
        world,
        &mut index,
        (
            CitizenId(sim_id.clone()),
            HomeAssignment {
                building_id: Some(building_id.to_string()),
                point: home,
            },
            SettledPosition(home),
            routine,
            day_state,
        ),
    );
    world.insert_resource(index);
    schedule_activity(world, entity, next_activity);
}

fn apply_activity(world: &mut World, entity: Entity, due_time: f64) {
    // A missing component means an earlier same-time wake already consumed
    // this citizen's activity; the event is dropped.
    let Some(next) = world.entity_mut(entity).take::<NextActivity>() else {
        return;
    };
    let Some(citizen_id) = world
        .get::<CitizenId>(entity)
        .map(|citizen| citizen.0.clone())
    else {
        return;
    };
    match next.0.kind {
        ScheduledActivityKind::DailyRoutine => {
            apply_daily_routine(world, entity, &citizen_id, due_time);
        }
        ScheduledActivityKind::PrimaryReturn => {
            let Some(origin) = world
                .get::<SettledPosition>(entity)
                .map(|settled| settled.0)
            else {
                return;
            };
            let Some(destination) = world.get::<HomeAssignment>(entity).map(|home| home.point)
            else {
                return;
            };
            world
                .resource_mut::<PendingTripDemands>()
                .0
                .push(TripDemand {
                    citizen_id,
                    purpose: TripPurpose::CommuteReturn,
                    origin,
                    destination,
                    scheduled_time: due_time,
                });
            // The return trip owns the citizen until its resolution handler
            // schedules the next DailyRoutine.
        }
        // Stage B owns optional outings; Stage A never constructs this kind.
        ScheduledActivityKind::OptionalReturn => {}
    }
}

fn apply_daily_routine(world: &mut World, entity: Entity, citizen_id: &str, due_time: f64) {
    // A wake on a new day rolls the v9 daily flags fresh, mirroring the
    // deleted shell `reset_daily_commute_flags` midnight reset.
    let commute_day = day_index(due_time);
    // A destination must resolve to a live job building, mirroring the
    // `has_valid_workplace_destination` spawn condition. A Stage-A Student
    // (current NonWorker) has none and stays dormant — Task 7 replaces this.
    let destination = world
        .get::<Routine>(entity)
        .and_then(|routine| match routine {
            Routine::Worker {
                workplace: Some(assignment),
                ..
            } => assignment.building_id.as_ref().map(|_| assignment.point),
            _ => None,
        });
    let Some(destination) = destination else {
        world.entity_mut(entity).insert(LegacyDayState {
            commute_day,
            outbound_resolved: false,
            outbound_arrived: false,
            return_resolved: false,
            returned_home: false,
        });
        schedule_activity(
            world,
            entity,
            ScheduledActivity {
                kind: ScheduledActivityKind::DailyRoutine,
                due_time: due_time + GAME_DAY_SECONDS,
            },
        );
        return;
    };
    let Some(origin) = world.get::<HomeAssignment>(entity).map(|home| home.point) else {
        return;
    };

    // Stranded-worker guard, mirroring the deleted spawn-scan guard: a worker
    // with a valid destination who is not at home at the day's outbound wake
    // was stranded by a previous unserved return. Emitting an outbound would
    // anchor a phantom commute to a worker away from `origin`, so resolve the
    // outbound instead and unlock today's return trip to bring them home.
    let stranded = world
        .get::<SettledPosition>(entity)
        .map(|settled| settled.0)
        .is_some_and(|position| position != origin);
    if stranded {
        let Some(routine) = world.get::<Routine>(entity).cloned() else {
            return;
        };
        let Routine::Worker { shift_template, .. } = routine else {
            return;
        };
        let day_state = LegacyDayState {
            commute_day,
            outbound_resolved: true,
            outbound_arrived: true,
            return_resolved: false,
            returned_home: false,
        };
        world.entity_mut(entity).insert(day_state.clone());
        schedule_activity(
            world,
            entity,
            worker_next_activity(
                citizen_id,
                &shift_template,
                commute_day,
                &day_state,
                due_time,
            ),
        );
        return;
    }

    world.entity_mut(entity).insert(LegacyDayState {
        commute_day,
        outbound_resolved: false,
        outbound_arrived: false,
        return_resolved: false,
        returned_home: false,
    });
    world
        .resource_mut::<PendingTripDemands>()
        .0
        .push(TripDemand {
            citizen_id: citizen_id.to_string(),
            purpose: TripPurpose::CommuteOutbound,
            origin,
            destination,
            scheduled_time: due_time,
        });
    // The outbound trip owns the citizen until its resolution handler
    // schedules the PrimaryReturn.
}

// === Terminal trip resolution feedback ===

/// One terminal trip transition collected by the trip loop before the trip is
/// removed, and fed back into the population world by
/// [`apply_trip_resolutions`].
pub(crate) struct TripResolution {
    pub(crate) citizen_id: String,
    pub(crate) purpose: TripPurpose,
    pub(crate) destination: Point,
    /// `true` when the trip reached `Arrived`/`Late` (the deleted
    /// `apply_arrival_to_sim` gate on `completed_trips > 0`).
    pub(crate) completed: bool,
    pub(crate) service_day: Option<u32>,
}

/// Apply terminal trip transitions to the population world: settle the
/// traveller's position, mirror the v9 daily flags, and schedule their next
/// activity — exactly the feedback the deleted `apply_arrival_to_sim` /
/// `apply_commute_resolution_to_sim` shell mutations used to provide, so
/// explicit v9 snapshots stay equivalent until Task 6 removes them.
pub(crate) fn apply_trip_resolutions(
    world: &mut World,
    resolutions: &[TripResolution],
    now_day: u32,
    now: f64,
) -> bool {
    let mut changed = false;
    for row in resolutions {
        changed |= apply_trip_resolution(world, row, now_day, now);
    }
    changed
}

fn apply_trip_resolution(world: &mut World, row: &TripResolution, now_day: u32, now: f64) -> bool {
    let Some(&entity) = world
        .resource::<PopulationIndex>()
        .by_id
        .get(&row.citizen_id)
    else {
        return false;
    };
    let Some(routine) = world.get::<Routine>(entity).cloned() else {
        return false;
    };
    let Routine::Worker { shift_template, .. } = routine else {
        return false;
    };
    let citizen_id = row.citizen_id.clone();
    let same_day = row.service_day.is_some_and(|day| day == now_day);
    // Whether today's outbound window is already closed at the resolution
    // instant. A cross-midnight resolution landing after today's departure has
    // missed it — the v9 flag mirrors the deleted late-assignment guard.
    let late_today = now
        > scheduled_time_seconds(
            now_day,
            departure_minute_for_sim(&citizen_id, &shift_template, "outbound"),
        ) + EPSILON;

    let fresh_day =
        |commute_day: u32, outbound_resolved: bool, outbound_arrived: bool| LegacyDayState {
            commute_day,
            outbound_resolved,
            outbound_arrived,
            return_resolved: false,
            returned_home: false,
        };

    match row.purpose {
        TripPurpose::CommuteOutbound => {
            if row.completed {
                if let Some(mut position) = world.get_mut::<SettledPosition>(entity) {
                    position.0 = row.destination;
                }
                if same_day {
                    let day_state = fresh_day(now_day, true, true);
                    world.entity_mut(entity).insert(day_state.clone());
                    schedule_activity(
                        world,
                        entity,
                        worker_next_activity(
                            &citizen_id,
                            &shift_template,
                            now_day,
                            &day_state,
                            now,
                        ),
                    );
                } else {
                    // Cross-midnight arrival at the workplace: the trip's own
                    // commute day is over, so today's outbound/return stay
                    // untouched (the deleted resolution handler never resolved
                    // a previous day's trip into today's flags). The worker
                    // simply sits at the destination until their next future
                    // outbound wake, which re-evaluates dormancy or the
                    // stranded guard.
                    schedule_activity(
                        world,
                        entity,
                        worker_next_activity(
                            &citizen_id,
                            &shift_template,
                            now_day,
                            &fresh_day(now_day, false, false),
                            now,
                        ),
                    );
                }
            } else {
                let day_state = fresh_day(now_day, late_today, false);
                world.entity_mut(entity).insert(day_state.clone());
                schedule_activity(
                    world,
                    entity,
                    worker_next_activity(&citizen_id, &shift_template, now_day, &day_state, now),
                );
            }
        }
        TripPurpose::CommuteReturn => {
            if row.completed {
                if let Some(mut position) = world.get_mut::<SettledPosition>(entity) {
                    position.0 = row.destination;
                }
            }
            if same_day {
                if let Some(mut day_state) = world.get_mut::<LegacyDayState>(entity) {
                    day_state.return_resolved = true;
                    day_state.returned_home = row.completed;
                }
                schedule_activity(
                    world,
                    entity,
                    next_worker_daily_routine(&citizen_id, &shift_template, now_day),
                );
            } else if row.completed {
                // Cross-midnight arrival home: the previous commute day is
                // over, so the flags roll fresh for today and the worker takes
                // their next future outbound wake — no retroactive return.
                schedule_activity(
                    world,
                    entity,
                    worker_next_activity(
                        &citizen_id,
                        &shift_template,
                        now_day,
                        &fresh_day(now_day, false, false),
                        now,
                    ),
                );
            } else {
                // Cross-midnight unserved return: the traveller is stranded at
                // the far end. Mirror the deleted stranded guard: resolve and
                // arrive today's outbound, unlocking today's return trip.
                let day_state = fresh_day(now_day, true, true);
                world.entity_mut(entity).insert(day_state.clone());
                schedule_activity(
                    world,
                    entity,
                    worker_next_activity(&citizen_id, &shift_template, now_day, &day_state, now),
                );
            }
        }
    }
    true
}

fn emit_trip_demands(mut pending: ResMut<PendingTripDemands>) {
    sort_trip_demands(&mut pending.0);
}

/// Canonical demand output: exact scheduled time, stable citizen ID, then an
/// explicit purpose rank. Never the entity handle or an enum discriminant.
fn sort_trip_demands(demands: &mut [TripDemand]) {
    demands.sort_by(|left, right| {
        left.scheduled_time
            .total_cmp(&right.scheduled_time)
            .then_with(|| left.citizen_id.cmp(&right.citizen_id))
            .then_with(|| trip_purpose_rank(left.purpose).cmp(&trip_purpose_rank(right.purpose)))
    });
}

fn trip_purpose_rank(purpose: TripPurpose) -> u8 {
    match purpose {
        TripPurpose::CommuteOutbound => 0,
        TripPurpose::CommuteReturn => 1,
    }
}

/// Deterministic single-spawn workplace pick: the first building in stable ID
/// order with a free job slot. `workers_by_building` holds the live counts.
fn find_available_workplace(index: &PopulationIndex) -> Option<(String, Point)> {
    index
        .buildings
        .iter()
        .filter(|(_, building)| building.job_capacity > 0 && !building.occupied_tiles.is_empty())
        .find(|(building_id, building)| {
            index
                .workers_by_building
                .get(*building_id)
                .map_or(0, Vec::len)
                < usize::from(building.job_capacity)
        })
        .map(|(building_id, building)| {
            let used = index
                .workers_by_building
                .get(building_id)
                .map_or(0, Vec::len);
            (
                building_id.clone(),
                building.occupied_tiles[used % building.occupied_tiles.len()],
            )
        })
}

/// Final activity kind for a Worker whose day flags describe `commute_day`,
/// mirroring the spawn conditions of `trips::spawn_due_commute_trips` on the
/// same shift-template math. Late assignments (workplace appeared after
/// today's departure) get no retroactive outbound — next day's routine.
fn worker_next_activity(
    sim_id: &str,
    shift_template: &str,
    commute_day: u32,
    day: &LegacyDayState,
    now: f64,
) -> ScheduledActivity {
    let outbound_minute = departure_minute_for_sim(sim_id, shift_template, "outbound");
    if !day.outbound_resolved && !day.outbound_arrived {
        let departure = scheduled_time_seconds(commute_day, outbound_minute);
        if now <= departure + EPSILON {
            return ScheduledActivity {
                kind: ScheduledActivityKind::DailyRoutine,
                due_time: departure,
            };
        }
        return next_worker_daily_routine(sim_id, shift_template, commute_day);
    }
    if day.outbound_arrived && !day.return_resolved && !day.returned_home {
        let return_minute = departure_minute_for_sim(sim_id, shift_template, "return");
        return ScheduledActivity {
            kind: ScheduledActivityKind::PrimaryReturn,
            due_time: scheduled_time_seconds(commute_day, return_minute),
        };
    }
    next_worker_daily_routine(sim_id, shift_template, commute_day)
}

fn next_worker_daily_routine(
    sim_id: &str,
    shift_template: &str,
    commute_day: u32,
) -> ScheduledActivity {
    ScheduledActivity {
        kind: ScheduledActivityKind::DailyRoutine,
        due_time: scheduled_time_seconds(
            commute_day + 1,
            departure_minute_for_sim(sim_id, shift_template, "outbound"),
        ),
    }
}

/// Dormant Stage-A wake for current NonWorkers: next midnight, emits nothing.
fn next_student_daily_routine(commute_day: u32) -> ScheduledActivity {
    ScheduledActivity {
        kind: ScheduledActivityKind::DailyRoutine,
        due_time: f64::from(commute_day + 1) * GAME_DAY_SECONDS,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::super::tests::population_fixture;
    use super::*;
    use crate::model::{ActiveTrip, TripPosition, TripStatus};

    fn single_worker_fixture() -> GameSnapshot {
        let mut snapshot = population_fixture();
        let worker = snapshot.sims[0].clone();
        snapshot.sims = vec![worker];
        snapshot
    }

    fn sim_departure(sim: &Sim, day: u32) -> f64 {
        let template = sim.shift_template.as_deref().unwrap_or_default();
        scheduled_time_seconds(day, departure_minute_for_sim(&sim.id, template, "outbound"))
    }

    fn scheduler_world(buildings: BTreeMap<String, PopulationBuilding>) -> World {
        let mut world = World::new();
        world.insert_resource(PopulationIndex {
            buildings,
            ..Default::default()
        });
        world.insert_resource(NextCitizenOrdinal(1));
        world.insert_resource(PopulationScheduler::default());
        world.insert_resource(DuePopulationEvents::default());
        world.insert_resource(PendingTripDemands::default());
        world.insert_resource(SchedulerNow(0.0));
        world
    }

    fn housing_building(tiles: &[Point]) -> PopulationBuilding {
        PopulationBuilding {
            occupied_tiles: tiles.to_vec(),
            resident_capacity: tiles.len() as u16,
            job_capacity: 0,
        }
    }

    #[test]
    fn same_time_move_ins_allocate_ids_by_building_and_slot_regardless_of_insertion_order() {
        let mut buildings = BTreeMap::new();
        buildings.insert(
            "building-a".to_string(),
            housing_building(&[Point::from((2, 2)), Point::from((3, 2))]),
        );
        buildings.insert(
            "building-b".to_string(),
            housing_building(&[Point::from((8, 2)), Point::from((9, 2))]),
        );
        let mut world = scheduler_world(buildings);
        for (building_id, slot) in [
            ("building-b", 1u16),
            ("building-a", 1),
            ("building-b", 0),
            ("building-a", 0),
        ] {
            insert_scheduler_event(
                &mut world.resource_mut::<PopulationScheduler>(),
                100.0,
                PopulationEvent::MoveIn {
                    building_id: building_id.to_string(),
                    slot,
                },
            );
        }

        let mut schedule = build_schedule();
        let result = run_due(&mut world, &mut schedule, 100.0);

        assert!(result.changed);
        let mut placements: Vec<(String, Point, String)> = world
            .query::<(&CitizenId, &HomeAssignment)>()
            .iter(&world)
            .map(|(citizen, home)| {
                (
                    home.building_id.clone().unwrap(),
                    home.point,
                    citizen.0.clone(),
                )
            })
            .collect();
        placements.sort_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then(left.1.x.cmp(&right.1.x))
                .then(left.1.y.cmp(&right.1.y))
        });
        assert_eq!(
            placements,
            vec![
                (
                    "building-a".to_string(),
                    Point::from((2, 2)),
                    "sim-001".to_string()
                ),
                (
                    "building-a".to_string(),
                    Point::from((3, 2)),
                    "sim-002".to_string()
                ),
                (
                    "building-b".to_string(),
                    Point::from((8, 2)),
                    "sim-003".to_string()
                ),
                (
                    "building-b".to_string(),
                    Point::from((9, 2)),
                    "sim-004".to_string()
                ),
            ]
        );
        assert_eq!(
            rebuilt_index(&mut world),
            *world.resource::<PopulationIndex>()
        );
    }

    #[test]
    fn boundary_generation_increments_only_on_new_exact_time_keys() {
        let mut world = World::new();
        let entity_a = world.spawn_empty().id();
        let entity_b = world.spawn_empty().id();
        let mut scheduler = PopulationScheduler::default();

        insert_scheduler_event(
            &mut scheduler,
            5.0,
            PopulationEvent::MoveIn {
                building_id: "building-a".to_string(),
                slot: 0,
            },
        );
        insert_scheduler_event(
            &mut scheduler,
            5.0,
            PopulationEvent::Activity { entity: entity_a },
        );
        assert_eq!(scheduler.boundary_generation, 1);
        assert_eq!(scheduler.buckets[&ScheduledTime::new(5.0)].len(), 2);

        insert_scheduler_event(
            &mut scheduler,
            9.0,
            PopulationEvent::Activity { entity: entity_b },
        );
        assert_eq!(scheduler.boundary_generation, 2);
    }

    #[test]
    fn run_due_drains_only_keys_within_the_due_band() {
        let mut buildings = BTreeMap::new();
        buildings.insert(
            "building-a".to_string(),
            housing_building(&[
                Point::from((2, 2)),
                Point::from((3, 2)),
                Point::from((4, 2)),
            ]),
        );
        let mut world = scheduler_world(buildings);
        let future = 100.0 + 10.0 * EPSILON;
        for due in [100.0 - 0.5 * EPSILON, 100.0] {
            insert_scheduler_event(
                &mut world.resource_mut::<PopulationScheduler>(),
                due,
                PopulationEvent::MoveIn {
                    building_id: "building-a".to_string(),
                    slot: 0,
                },
            );
        }
        insert_scheduler_event(
            &mut world.resource_mut::<PopulationScheduler>(),
            future,
            PopulationEvent::MoveIn {
                building_id: "building-a".to_string(),
                slot: 1,
            },
        );

        let mut schedule = build_schedule();
        let result = run_due(&mut world, &mut schedule, 100.0);

        assert!(result.changed);
        assert_eq!(population_count(&world), 2);
        assert_eq!(next_population_boundary(&world, 100.0), Some(future));
    }

    #[test]
    fn stale_activity_handle_is_dropped_and_replacement_emits_no_demand() {
        let snapshot = single_worker_fixture();
        let departure = sim_departure(&snapshot.sims[0], snapshot.day);
        let mut world = build_world_v9(&snapshot);
        let entity_a = world.resource::<PopulationIndex>().by_id["sim-001"];
        assert!(world.get::<NextActivity>(entity_a).is_some());
        world.despawn(entity_a);

        // The replacement may receive A's recycled entity index with a fresh
        // generation; the assertion below stays semantic either way.
        let mut index = world.remove_resource::<PopulationIndex>().unwrap();
        let entity_b = spawn_indexed_citizen(
            &mut world,
            &mut index,
            (
                CitizenId("sim-005".to_string()),
                HomeAssignment {
                    building_id: None,
                    point: Point::from((0, 0)),
                },
                SettledPosition(Point::from((0, 0))),
                Routine::Worker {
                    shift_template: "standard".to_string(),
                    workplace: None,
                },
                LegacyDayState {
                    commute_day: snapshot.day,
                    outbound_resolved: false,
                    outbound_arrived: false,
                    return_resolved: false,
                    returned_home: false,
                },
            ),
        );
        world.insert_resource(index);

        let mut schedule = build_schedule();
        run_due(&mut world, &mut schedule, departure);
        assert!(drain_trip_demands(&mut world).is_empty());
        assert!(world.get::<CitizenId>(entity_b).is_some());
        assert!(world.get::<NextActivity>(entity_b).is_none());
        assert!(next_population_boundary(&world, departure).is_none());
    }

    #[test]
    fn worker_daily_routine_emits_one_exact_time_outbound_demand() {
        let snapshot = single_worker_fixture();
        let departure = sim_departure(&snapshot.sims[0], snapshot.day);
        let mut world = build_world_v9(&snapshot);
        let entity = world.resource::<PopulationIndex>().by_id["sim-001"];
        assert_eq!(
            world.get::<NextActivity>(entity).unwrap().0,
            ScheduledActivity {
                kind: ScheduledActivityKind::DailyRoutine,
                due_time: departure,
            }
        );

        let mut schedule = build_schedule();
        let result = run_due(&mut world, &mut schedule, departure);

        assert!(result.changed);
        let demands = drain_trip_demands(&mut world);
        assert_eq!(demands.len(), 1);
        assert_eq!(demands[0].citizen_id, "sim-001");
        assert_eq!(demands[0].purpose, TripPurpose::CommuteOutbound);
        assert_eq!(demands[0].origin, snapshot.sims[0].home);
        assert_eq!(demands[0].destination, snapshot.sims[0].workplace.unwrap());
        assert_eq!(demands[0].scheduled_time, departure);
        assert!(world.get::<NextActivity>(entity).is_none());
        assert_eq!(
            rebuilt_index(&mut world),
            *world.resource::<PopulationIndex>()
        );
    }

    #[test]
    fn worker_daily_routine_without_destination_reschedules_next_day() {
        let mut snapshot = single_worker_fixture();
        snapshot.sims[0].workplace = None;
        let departure = sim_departure(&snapshot.sims[0], snapshot.day);
        let mut world = build_world_v9(&snapshot);
        let entity = world.resource::<PopulationIndex>().by_id["sim-001"];

        let mut schedule = build_schedule();
        let result = run_due(&mut world, &mut schedule, departure);

        assert!(result.changed);
        assert!(drain_trip_demands(&mut world).is_empty());
        let next = world.get::<NextActivity>(entity).unwrap().0.clone();
        assert_eq!(next.kind, ScheduledActivityKind::DailyRoutine);
        assert_eq!(next.due_time, departure + GAME_DAY_SECONDS);
    }

    #[test]
    fn student_daily_routine_is_dormant_and_reschedules_next_day() {
        let mut snapshot = population_fixture();
        let student = snapshot.sims[3].clone();
        snapshot.sims = vec![student];
        let midnight = f64::from(snapshot.day + 1) * GAME_DAY_SECONDS;
        let mut world = build_world_v9(&snapshot);
        let entity = world.resource::<PopulationIndex>().by_id["sim-004"];
        assert_eq!(
            world.get::<NextActivity>(entity).unwrap().0.due_time,
            midnight
        );

        let mut schedule = build_schedule();
        let result = run_due(&mut world, &mut schedule, midnight);

        assert!(result.changed);
        assert!(drain_trip_demands(&mut world).is_empty());
        assert_eq!(
            world.get::<NextActivity>(entity).unwrap().0.due_time,
            midnight + GAME_DAY_SECONDS
        );
    }

    #[test]
    fn primary_return_emits_one_exact_time_return_demand() {
        let mut snapshot = single_worker_fixture();
        snapshot.sims[0].outbound_resolved_today = true;
        snapshot.sims[0].outbound_arrived_today = true;
        let workplace = snapshot.sims[0].workplace.unwrap();
        snapshot.sims[0].position = workplace;
        let return_due = scheduled_time_seconds(
            snapshot.day,
            departure_minute_for_sim("sim-001", "standard", "return"),
        );
        let mut world = build_world_v9(&snapshot);
        let entity = world.resource::<PopulationIndex>().by_id["sim-001"];
        assert_eq!(
            world.get::<NextActivity>(entity).unwrap().0,
            ScheduledActivity {
                kind: ScheduledActivityKind::PrimaryReturn,
                due_time: return_due,
            }
        );

        let mut schedule = build_schedule();
        run_due(&mut world, &mut schedule, return_due);

        let demands = drain_trip_demands(&mut world);
        assert_eq!(demands.len(), 1);
        assert_eq!(demands[0].citizen_id, "sim-001");
        assert_eq!(demands[0].purpose, TripPurpose::CommuteReturn);
        assert_eq!(demands[0].origin, workplace);
        assert_eq!(demands[0].destination, snapshot.sims[0].home);
        assert_eq!(demands[0].scheduled_time, return_due);
        assert!(world.get::<NextActivity>(entity).is_none());
        assert_eq!(
            rebuilt_index(&mut world),
            *world.resource::<PopulationIndex>()
        );
    }

    #[test]
    fn late_assigned_worker_defers_to_next_day_without_retroactive_outbound() {
        let mut snapshot = single_worker_fixture();
        let day = snapshot.day;
        let departure = sim_departure(&snapshot.sims[0], day);
        snapshot.time = scheduled_time_seconds(day, 500);
        let next_departure = scheduled_time_seconds(
            day + 1,
            departure_minute_for_sim("sim-001", "standard", "outbound"),
        );
        let mut world = build_world_v9(&snapshot);
        let entity = world.resource::<PopulationIndex>().by_id["sim-001"];
        assert_eq!(
            world.get::<NextActivity>(entity).unwrap().0.due_time,
            next_departure
        );

        let mut schedule = build_schedule();
        let missed = run_due(&mut world, &mut schedule, departure);
        assert!(!missed.changed);
        assert!(drain_trip_demands(&mut world).is_empty());

        let result = run_due(&mut world, &mut schedule, next_departure);
        assert!(result.changed);
        let demands = drain_trip_demands(&mut world);
        assert_eq!(demands.len(), 1);
        assert_eq!(demands[0].scheduled_time, next_departure);
    }

    #[test]
    fn active_trip_loads_without_next_activity_or_wake() {
        let mut snapshot = single_worker_fixture();
        let home = snapshot.sims[0].home;
        let workplace = snapshot.sims[0].workplace.unwrap();
        snapshot.active_trips.push(ActiveTrip {
            id: "trip-day-5-trip-1".to_string(),
            sim_id: "sim-001".to_string(),
            purpose: TripPurpose::CommuteOutbound,
            origin: home,
            destination: workplace,
            position: TripPosition {
                x: f64::from(home.x),
                y: f64::from(home.y),
            },
            status: TripStatus::Riding,
            deadline: 0.0,
            route_plan: None,
            current_leg_index: 0,
            patience_remaining: 900.0,
            current_leg_wait_seconds: 0.0,
            private_car_trip: None,
        });
        let departure = sim_departure(&snapshot.sims[0], snapshot.day);
        let mut world = build_world_v9(&snapshot);
        assert!(world.resource::<PopulationScheduler>().buckets.is_empty());
        let mut query = world.query::<&NextActivity>();
        assert_eq!(query.iter(&world).count(), 0);

        let mut schedule = build_schedule();
        let result = run_due(&mut world, &mut schedule, departure);
        assert!(!result.changed);
        assert!(drain_trip_demands(&mut world).is_empty());
    }

    #[test]
    fn move_in_at_departure_timestamp_emits_the_outbound_in_the_same_run() {
        let mut buildings = BTreeMap::new();
        buildings.insert(
            "building-h".to_string(),
            housing_building(&[Point::from((2, 2))]),
        );
        buildings.insert(
            "building-j".to_string(),
            PopulationBuilding {
                occupied_tiles: vec![Point::from((8, 8))],
                resident_capacity: 0,
                job_capacity: 1,
            },
        );
        let mut world = scheduler_world(buildings);
        let departure = scheduled_time_seconds(
            0,
            departure_minute_for_sim("sim-001", "standard", "outbound"),
        );
        insert_scheduler_event(
            &mut world.resource_mut::<PopulationScheduler>(),
            departure,
            PopulationEvent::MoveIn {
                building_id: "building-h".to_string(),
                slot: 0,
            },
        );

        let mut schedule = build_schedule();
        let result = run_due(&mut world, &mut schedule, departure);

        assert!(result.changed);
        let demands = drain_trip_demands(&mut world);
        assert_eq!(demands.len(), 1);
        assert_eq!(demands[0].citizen_id, "sim-001");
        assert_eq!(demands[0].purpose, TripPurpose::CommuteOutbound);
        assert_eq!(demands[0].origin, Point::from((2, 2)));
        assert_eq!(demands[0].destination, Point::from((8, 8)));
        assert_eq!(demands[0].scheduled_time, departure);
        assert_eq!(population_count(&world), 1);
        assert_eq!(
            rebuilt_index(&mut world),
            *world.resource::<PopulationIndex>()
        );
        assert!(next_population_boundary(&world, departure).is_none());
    }

    #[test]
    fn trip_demands_sort_by_time_citizen_and_purpose_rank() {
        let snapshot = single_worker_fixture();
        let mut world = build_world_v9(&snapshot);
        let demand = |citizen_id: &str, purpose: TripPurpose, scheduled_time: f64| TripDemand {
            citizen_id: citizen_id.to_string(),
            purpose,
            origin: Point::from((0, 0)),
            destination: Point::from((1, 0)),
            scheduled_time,
        };
        world.resource_mut::<PendingTripDemands>().0 = vec![
            demand("sim-002", TripPurpose::CommuteReturn, 100.0),
            demand("sim-001", TripPurpose::CommuteReturn, 100.0),
            demand("sim-003", TripPurpose::CommuteOutbound, 50.0),
            demand("sim-001", TripPurpose::CommuteOutbound, 100.0),
        ];

        let mut schedule = build_schedule();
        world.insert_resource(SchedulerNow(0.0));
        schedule.run(&mut world);

        let live = world.resource::<PendingTripDemands>().0.clone();
        let drained = drain_trip_demands(&mut world);
        assert_eq!(live, drained);
        let order: Vec<(f64, &str, u8)> = drained
            .iter()
            .map(|row| {
                (
                    row.scheduled_time,
                    row.citizen_id.as_str(),
                    trip_purpose_rank(row.purpose),
                )
            })
            .collect();
        assert_eq!(
            order,
            [
                (50.0, "sim-003", 0),
                (100.0, "sim-001", 0),
                (100.0, "sim-001", 1),
                (100.0, "sim-002", 1),
            ]
        );
    }
}

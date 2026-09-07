use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::ops::Bound::{Excluded, Unbounded};

use bevy_ecs::prelude::*;

use super::components::{
    BuildingAssignment, CitizenId, HomeAssignment, NextActivity, Routine, SettledPosition,
};
use super::{scheduled_time_seconds, MOVE_IN_INTERVAL_SECONDS};
use crate::building_catalog::building_definition;
use crate::clock::{day_index, GAME_DAY_SECONDS};
use crate::commute::{
    departure_minute_for_sim, is_day_off, numeric_id_suffix, optional_departure_minute,
    shift_template_for_id, stable_daily_seed, student_departure_minute, trip_deadline_seconds,
    OPTIONAL_SALT, SCHOOL_SALT,
};
use crate::ids::entity_id;
use crate::model::{
    CitizenRoutine, GameMode, GameSnapshot, PlacedBuilding, Point, ScheduledActivity,
    ScheduledActivityKind, Sim, TripPurpose, TripStatus,
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
    pub(super) building_type: &'static str,
    pub(super) occupied_tiles: Vec<Point>,
    pub(super) resident_capacity: u16,
    pub(super) job_capacity: u16,
}

/// Monotonic citizen allocator. Initialized once from the durable sim ids and
/// never recomputed after despawn, so a deleted highest id is never reused.
#[derive(Resource, Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct NextCitizenOrdinal(pub(super) usize);

pub(crate) fn build_world(snapshot: &GameSnapshot) -> World {
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
                building_type: definition.building_type,
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
        let routine = match &sim.routine {
            CitizenRoutine::Worker {
                shift_template,
                workplace,
            } => Routine::Worker {
                shift_template: shift_template.clone(),
                workplace: workplace.map(|point| BuildingAssignment {
                    building_id: building_by_tile.get(&point).cloned(),
                    point,
                }),
            },
            CitizenRoutine::Student => Routine::Student,
        };
        // The durable `next_activity` is the authority: travelling citizens
        // carry none (their active trip owns them) and idle citizens map
        // directly onto the scheduler's wake for their persisted due time.
        let travelling = snapshot
            .active_trips
            .iter()
            .any(|trip| trip.sim_id == sim.id && !is_terminal_status(trip.status));
        pending_activities.push((
            sim.id.clone(),
            sim.next_activity.clone().filter(|_| !travelling),
        ));
        spawn_indexed_citizen(
            &mut world,
            &mut index,
            (
                CitizenId(sim.id.clone()),
                home,
                SettledPosition(sim.position),
                routine,
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

pub(crate) fn snapshot_sims(world: &World, _day: u32) -> Vec<Sim> {
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
            let next_activity = world.get::<NextActivity>(entity).map(|wake| wake.0.clone());
            let routine = match routine {
                Routine::Worker {
                    shift_template,
                    workplace,
                } => CitizenRoutine::Worker {
                    shift_template: shift_template.clone(),
                    workplace: workplace.as_ref().map(|assignment| assignment.point),
                },
                Routine::Student => CitizenRoutine::Student,
            };
            Sim {
                id: citizen_id.0.clone(),
                home: home.point,
                position: position.0,
                routine,
                next_activity,
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
/// Shared by [`build_world`] and the 200k structural construction test.
pub(super) fn spawn_indexed_citizen(
    world: &mut World,
    index: &mut PopulationIndex,
    components: (CitizenId, HomeAssignment, SettledPosition, Routine),
) -> Entity {
    let (citizen_id, home, position, routine) = components;
    let entity = world
        .spawn((citizen_id.clone(), home.clone(), position, routine.clone()))
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
                    building_type: definition.building_type,
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
        let Some(routine) = world.get::<Routine>(entity).cloned() else {
            continue;
        };
        // Only Worker outbounds are retargeted/dropped by reconciliation, so
        // only they recover here.
        let Routine::Worker { .. } = routine else {
            continue;
        };
        schedule_activity(
            world,
            entity,
            next_daily_routine(&routine, citizen_id, day_index(now)),
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

    let shift_template = shift_template_for_id(&sim_id);
    let routine = match shift_template {
        Some(shift_template) => {
            // Assign a workplace if one has a free slot (stable building-ID
            // order). Task 3's reconciliation owns the global
            // preserve-and-refill ordering.
            let workplace = find_available_workplace(world.resource::<PopulationIndex>());
            Routine::Worker {
                shift_template: shift_template.to_string(),
                workplace: workplace.map(|(job_building_id, point)| BuildingAssignment {
                    building_id: Some(job_building_id),
                    point,
                }),
            }
        }
        // A canonical Student (every 10th id) keeps the school routine.
        None => Routine::Student,
    };
    let next_activity = routine_from_now(&routine, &sim_id, now);

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
        // Both return kinds emit one return-to-home trip; the resolution
        // handler owns what is scheduled next.
        kind @ (ScheduledActivityKind::PrimaryReturn | ScheduledActivityKind::OptionalReturn) => {
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
                    purpose: match kind {
                        ScheduledActivityKind::PrimaryReturn => TripPurpose::CommuteReturn,
                        _ => TripPurpose::OptionalReturn,
                    },
                    origin,
                    destination,
                    scheduled_time: due_time,
                });
            // The return trip owns the citizen until its resolution handler
            // schedules the next DailyRoutine.
        }
    }
}

fn apply_daily_routine(world: &mut World, entity: Entity, citizen_id: &str, due_time: f64) {
    let today = day_index(due_time);
    let Some(origin) = world.get::<HomeAssignment>(entity).map(|home| home.point) else {
        return;
    };
    let Some(routine) = world.get::<Routine>(entity).cloned() else {
        return;
    };

    // Rule 1: a citizen settled away from home returns home before any new
    // outbound — a previous unserved return stranded them, and emitting an
    // outbound would anchor a phantom commute away from `origin`. This also
    // covers day-off and no-destination citizens.
    let stranded = world
        .get::<SettledPosition>(entity)
        .map(|settled| settled.0)
        .is_some_and(|position| position != origin);
    if stranded {
        schedule_activity(
            world,
            entity,
            ScheduledActivity {
                kind: ScheduledActivityKind::PrimaryReturn,
                due_time: scheduled_time_seconds(
                    today,
                    routine_minute(&routine, citizen_id, "return"),
                ),
            },
        );
        return;
    }

    // One day in seven is a day off: the primary work/school outbound is
    // suppressed and the citizen may take their one bounded optional outing.
    if is_day_off(citizen_id, today) {
        let outing_departure =
            scheduled_time_seconds(today, optional_departure_minute(citizen_id, today));
        if outing_departure > due_time + EPSILON {
            schedule_activity(
                world,
                entity,
                ScheduledActivity {
                    kind: ScheduledActivityKind::DailyRoutine,
                    due_time: outing_departure,
                },
            );
        } else {
            apply_optional_outing(world, entity, citizen_id, &routine, today, due_time);
        }
        return;
    }

    // A destination must resolve for the primary outbound: a live assigned
    // workplace for Workers, a placed school for Students.
    let destination = match &routine {
        Routine::Worker {
            workplace: Some(assignment),
            ..
        } => assignment.building_id.as_ref().map(|_| assignment.point),
        Routine::Worker {
            workplace: None, ..
        } => None,
        Routine::Student => student_school_destination(world, citizen_id, today),
    };
    let Some(destination) = destination else {
        // No destination: no primary trip; the next DailyRoutine re-checks.
        schedule_activity(
            world,
            entity,
            next_daily_routine(&routine, citizen_id, today),
        );
        return;
    };

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

/// On a day off, emit the citizen's one bounded optional outing when the
/// daily seed makes them eligible and an eligible building exists; otherwise
/// hand them back to the next DailyRoutine.
fn apply_optional_outing(
    world: &mut World,
    entity: Entity,
    citizen_id: &str,
    routine: &Routine,
    today: u32,
    due_time: f64,
) {
    let eligible = stable_daily_seed(citizen_id, today, OPTIONAL_SALT).is_multiple_of(4);
    let destination = if eligible {
        optional_outing_site(world, citizen_id, today)
    } else {
        None
    };
    let Some(destination) = destination else {
        schedule_activity(
            world,
            entity,
            next_daily_routine(routine, citizen_id, today),
        );
        return;
    };
    let Some(origin) = world.get::<HomeAssignment>(entity).map(|home| home.point) else {
        return;
    };
    world
        .resource_mut::<PendingTripDemands>()
        .0
        .push(TripDemand {
            citizen_id: citizen_id.to_string(),
            purpose: TripPurpose::OptionalOutbound,
            origin,
            destination,
            scheduled_time: due_time,
        });
    // The outing trip owns the citizen until its resolution handler
    // schedules the OptionalReturn.
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
/// traveller's position and schedule their next activity — the feedback the
/// deleted `apply_arrival_to_sim` / `apply_commute_resolution_to_sim` shell
/// mutations used to provide. The scheduled kind IS the citizen's commute
/// stage: `DailyRoutine` waits for the outbound wake, `PrimaryReturn` waits at
/// the workplace, and no activity means a trip owns the citizen.
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
    let citizen_id = row.citizen_id.clone();
    let same_day = row.service_day.is_some_and(|day| day == now_day);
    let return_due = || ScheduledActivity {
        kind: ScheduledActivityKind::PrimaryReturn,
        due_time: scheduled_time_seconds(now_day, routine_minute(&routine, &citizen_id, "return")),
    };
    let settle = |world: &mut World, entity: Entity| {
        if let Some(mut position) = world.get_mut::<SettledPosition>(entity) {
            position.0 = row.destination;
        }
    };

    match row.purpose {
        TripPurpose::CommuteOutbound => {
            if row.completed {
                settle(world, entity);
                if same_day {
                    // Arrived at the destination: today's return wake brings
                    // the citizen home.
                    schedule_activity(world, entity, return_due());
                } else {
                    // Cross-midnight arrival: today's commute window may still
                    // be ahead (in which case the daily-routine stranded guard
                    // keeps that legitimate) or already closed.
                    schedule_activity(world, entity, routine_from_now(&routine, &citizen_id, now));
                }
            } else {
                // Unserved or late outbound: the departure window closed, so
                // the citizen retries with tomorrow's (or today's, if still
                // ahead) routine.
                schedule_activity(world, entity, routine_from_now(&routine, &citizen_id, now));
            }
        }
        TripPurpose::CommuteReturn => {
            if row.completed {
                settle(world, entity);
            }
            if same_day {
                // Home again (or the return window closed without service):
                // tomorrow's routine owns the next wake.
                schedule_activity(
                    world,
                    entity,
                    next_daily_routine(&routine, &citizen_id, now_day),
                );
            } else if row.completed {
                // Cross-midnight arrival home: today's commute window may
                // still be ahead or already closed (see the outbound case).
                schedule_activity(world, entity, routine_from_now(&routine, &citizen_id, now));
            } else {
                // Cross-midnight unserved return: the traveller is stranded at
                // the far end. Unlock today's return trip to bring them home.
                schedule_activity(world, entity, return_due());
            }
        }
        TripPurpose::OptionalOutbound => {
            if row.completed {
                settle(world, entity);
                // Dwell at the outing site for exactly 120 in-game minutes,
                // then the OptionalReturn wake brings the citizen home.
                schedule_activity(
                    world,
                    entity,
                    ScheduledActivity {
                        kind: ScheduledActivityKind::OptionalReturn,
                        due_time: now + OPTIONAL_DWELL_SECONDS,
                    },
                );
            } else {
                // The outing never started; back to the routine (today's
                // primary departure is already past on a day off, so this is
                // tomorrow's wake).
                schedule_activity(world, entity, routine_from_now(&routine, &citizen_id, now));
            }
        }
        TripPurpose::OptionalReturn => {
            if row.completed {
                settle(world, entity);
                if same_day {
                    schedule_activity(
                        world,
                        entity,
                        next_daily_routine(&routine, &citizen_id, now_day),
                    );
                } else {
                    schedule_activity(world, entity, routine_from_now(&routine, &citizen_id, now));
                }
            } else {
                // Unserved optional return: no same-day retry — the citizen
                // waits until the next DailyRoutine, whose away-from-home
                // guard brings them home.
                schedule_activity(
                    world,
                    entity,
                    next_daily_routine(&routine, &citizen_id, now_day),
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
        // Stage B owns optional outings; they never rank above commute demand.
        TripPurpose::OptionalOutbound => 2,
        TripPurpose::OptionalReturn => 3,
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

/// The citizen's next `DailyRoutine` from `now`: today's primary outbound
/// departure if it is still ahead, else tomorrow's. Mirrors the deleted v9
/// flag pairs (fresh or late-resolved outbound): both encoded "wait for the
/// next future departure".
fn routine_from_now(routine: &Routine, citizen_id: &str, now: f64) -> ScheduledActivity {
    let today = day_index(now);
    let departure = scheduled_time_seconds(today, routine_minute(routine, citizen_id, "outbound"));
    if now <= departure + EPSILON {
        ScheduledActivity {
            kind: ScheduledActivityKind::DailyRoutine,
            due_time: departure,
        }
    } else {
        next_daily_routine(routine, citizen_id, today)
    }
}

fn next_daily_routine(routine: &Routine, citizen_id: &str, today: u32) -> ScheduledActivity {
    ScheduledActivity {
        kind: ScheduledActivityKind::DailyRoutine,
        due_time: scheduled_time_seconds(
            today + 1,
            routine_minute(routine, citizen_id, "outbound"),
        ),
    }
}

/// The routine's departure window minute: Workers jitter inside their shift
/// template's windows, Students inside the fixed school windows.
fn routine_minute(routine: &Routine, citizen_id: &str, direction: &str) -> u16 {
    match routine {
        Routine::Worker { shift_template, .. } => {
            departure_minute_for_sim(citizen_id, shift_template, direction)
        }
        Routine::Student => student_departure_minute(citizen_id, direction),
    }
}

/// Dwell at an optional-outing site: exactly 120 in-game minutes.
const OPTIONAL_DWELL_SECONDS: f64 = GAME_DAY_SECONDS / 12.0;

/// Deterministic Student school destination: the stable building-ID order
/// picks the school, then a footprint tile, from the day's per-citizen seed.
/// `None` when no school is placed — no primary trip is emitted then.
fn student_school_destination(world: &World, citizen_id: &str, today: u32) -> Option<Point> {
    let index = world.resource::<PopulationIndex>();
    let schools: Vec<&PopulationBuilding> = index
        .buildings
        .values()
        .filter(|building| {
            building.building_type == "school" && !building.occupied_tiles.is_empty()
        })
        .collect();
    let seed = stable_daily_seed(citizen_id, today, SCHOOL_SALT);
    let count = schools.len() as u64;
    let building = if count == 0 {
        return None;
    } else {
        schools[(seed % count) as usize]
    };
    let tile =
        building.occupied_tiles[((seed >> 32) % building.occupied_tiles.len() as u64) as usize];
    Some(tile)
}

/// Deterministic optional-outing destination among the eligible building
/// types (supermarket, cinema, clinic, parkPlaza). No visitor capacity and no
/// chained stops: the seed picks the site and tile outright.
fn optional_outing_site(world: &World, citizen_id: &str, today: u32) -> Option<Point> {
    let index = world.resource::<PopulationIndex>();
    let sites: Vec<&PopulationBuilding> = index
        .buildings
        .values()
        .filter(|building| is_optional_site_type(building.building_type))
        .filter(|building| !building.occupied_tiles.is_empty())
        .collect();
    let seed = stable_daily_seed(citizen_id, today, OPTIONAL_SALT);
    let count = sites.len() as u64;
    let building = if count == 0 {
        return None;
    } else {
        sites[((seed >> 16) % count) as usize]
    };
    let tile =
        building.occupied_tiles[((seed >> 32) % building.occupied_tiles.len() as u64) as usize];
    Some(tile)
}

fn is_optional_site_type(building_type: &str) -> bool {
    matches!(
        building_type,
        "supermarket" | "cinema" | "clinic" | "parkPlaza"
    )
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::super::tests::population_fixture;
    use super::*;
    use crate::clock::GAME_DAY_SECONDS;
    use crate::model::{ActiveTrip, TripPosition, TripStatus};

    fn single_worker_fixture() -> GameSnapshot {
        let mut snapshot = population_fixture();
        let worker = snapshot.sims[0].clone();
        snapshot.sims = vec![worker];
        snapshot
    }

    fn sim_shift_template(sim: &Sim) -> &str {
        match &sim.routine {
            CitizenRoutine::Worker { shift_template, .. } => shift_template,
            CitizenRoutine::Student => "",
        }
    }

    fn sim_departure(sim: &Sim, day: u32) -> f64 {
        scheduled_time_seconds(
            day,
            departure_minute_for_sim(&sim.id, sim_shift_template(sim), "outbound"),
        )
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
            building_type: "smallHouse",
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
        let mut world = build_world(&snapshot);
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
        let mut world = build_world(&snapshot);
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
        assert_eq!(
            demands[0].destination,
            match &snapshot.sims[0].routine {
                CitizenRoutine::Worker {
                    workplace: Some(workplace),
                    ..
                } => *workplace,
                _ => panic!("fixture worker must carry a workplace"),
            }
        );
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
        snapshot.sims[0].routine = CitizenRoutine::Worker {
            shift_template: "standard".to_string(),
            workplace: None,
        };
        let departure = sim_departure(&snapshot.sims[0], snapshot.day);
        let mut world = build_world(&snapshot);
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
    fn optional_dwell_is_exactly_120_in_game_minutes() {
        // 120 in-game minutes at 1440 minutes per GAME_DAY_SECONDS day.
        let expected = (120.0 / f64::from(crate::clock::MINUTES_PER_DAY)) * GAME_DAY_SECONDS;
        assert_eq!(OPTIONAL_DWELL_SECONDS, expected);
        assert_eq!(OPTIONAL_DWELL_SECONDS, 100.0);
    }

    #[test]
    fn student_daily_routine_without_school_reschedules_to_next_school_window() {
        let mut snapshot = population_fixture();
        let student = snapshot.sims[3].clone();
        snapshot.sims = vec![student];
        let midnight = f64::from(snapshot.day + 1) * GAME_DAY_SECONDS;
        let mut world = build_world(&snapshot);
        let entity = world.resource::<PopulationIndex>().by_id["sim-004"];
        assert_eq!(
            world.get::<NextActivity>(entity).unwrap().0.due_time,
            midnight
        );

        let mut schedule = build_schedule();
        let result = run_due(&mut world, &mut schedule, midnight);

        assert!(result.changed);
        assert!(drain_trip_demands(&mut world).is_empty());
        // No school is placed, so the wake emits no primary trip and hands
        // the student to tomorrow's school-outbound window instead of
        // emitting anything today.
        assert_eq!(
            world.get::<NextActivity>(entity).unwrap().0,
            ScheduledActivity {
                kind: ScheduledActivityKind::DailyRoutine,
                due_time: scheduled_time_seconds(
                    snapshot.day + 2,
                    student_departure_minute("sim-004", "outbound")
                ),
            }
        );
    }

    #[test]
    fn student_daily_routine_emits_school_outbound_to_the_seeded_tile() {
        let mut snapshot = population_fixture();
        let student = snapshot.sims[3].clone();
        snapshot.sims = vec![student];
        // Hand-place a school next to the retained job buildings.
        snapshot.buildings.push(PlacedBuilding {
            id: "building-school".to_string(),
            building_type: "school".to_string(),
            origin: Point::from((18, 10)),
            rotation: 0,
            occupied_tiles: vec![
                Point::from((18, 10)),
                Point::from((19, 10)),
                Point::from((20, 10)),
                Point::from((18, 11)),
                Point::from((19, 11)),
                Point::from((20, 11)),
            ],
            placed_at: 0.0,
            transit_node_id: None,
        });
        let day = snapshot.day + 1;
        let wake = scheduled_time_seconds(day, student_departure_minute("sim-004", "outbound"));
        snapshot.sims[0].next_activity = Some(ScheduledActivity {
            kind: ScheduledActivityKind::DailyRoutine,
            due_time: wake,
        });
        let mut world = build_world(&snapshot);
        let entity = world.resource::<PopulationIndex>().by_id["sim-004"];

        let mut schedule = build_schedule();
        let result = run_due(&mut world, &mut schedule, wake);

        assert!(result.changed);
        let demands = drain_trip_demands(&mut world);
        assert_eq!(demands.len(), 1);
        assert_eq!(demands[0].citizen_id, "sim-004");
        assert_eq!(demands[0].purpose, TripPurpose::CommuteOutbound);
        assert_eq!(demands[0].origin, snapshot.sims[0].home);
        assert!(
            [18, 19, 20]
                .iter()
                .any(|&x| demands[0].destination == Point::from((x, 10)))
                || [18, 19, 20]
                    .iter()
                    .any(|&x| demands[0].destination == Point::from((x, 11))),
            "destination must be a seeded school footprint tile"
        );
        assert_eq!(demands[0].scheduled_time, wake);
        assert!(world.get::<NextActivity>(entity).is_none());
    }

    #[test]
    fn primary_return_emits_one_exact_time_return_demand() {
        let mut snapshot = single_worker_fixture();
        let workplace = match snapshot.sims[0].routine {
            CitizenRoutine::Worker {
                workplace: Some(workplace),
                ..
            } => workplace,
            _ => panic!("fixture worker must carry a workplace"),
        };
        snapshot.sims[0].position = workplace;
        let return_due = scheduled_time_seconds(
            snapshot.day,
            departure_minute_for_sim("sim-001", "standard", "return"),
        );
        snapshot.sims[0].next_activity = Some(ScheduledActivity {
            kind: ScheduledActivityKind::PrimaryReturn,
            due_time: return_due,
        });
        let mut world = build_world(&snapshot);
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
        // The load is late: the durable wake already points at tomorrow.
        snapshot.sims[0].next_activity = Some(ScheduledActivity {
            kind: ScheduledActivityKind::DailyRoutine,
            due_time: next_departure,
        });
        let mut world = build_world(&snapshot);
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
        let workplace = match snapshot.sims[0].routine {
            CitizenRoutine::Worker {
                workplace: Some(workplace),
                ..
            } => workplace,
            _ => panic!("fixture worker must carry a workplace"),
        };
        snapshot.sims[0].next_activity = None;
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
        let mut world = build_world(&snapshot);
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
                building_type: "supermarket",
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
        let mut world = build_world(&snapshot);
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

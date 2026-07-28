use std::collections::BTreeSet;

use crate::commute;
use crate::model::{
    ActiveTrip, GameMode, GameSnapshot, MetricsState, Point, TransitMode, TripOutcomeKind,
    TripPurpose, TripStatus, WorkerProfile,
};
use crate::{objectives, router, trips};

use super::entities::{parse_trip_id, EntityIndexes};
use super::{
    DerivedStateError, EntityError, EntityKind, EntityRef, ModeError, NumericError,
    PersistenceError, PersistenceResult, SnapshotField,
};

pub(super) fn validate_trips(
    snapshot: &GameSnapshot,
    indexes: &EntityIndexes<'_>,
) -> PersistenceResult<()> {
    validate_sims(snapshot)?;

    let mut trip_keys = BTreeSet::new();
    let mut max_current_day_sequence = 0;
    for trip in &snapshot.active_trips {
        let entity = entity_ref(EntityKind::ActiveTrip, &trip.id);
        let Some(sim) = indexes.sim(&trip.sim_id) else {
            return Err(PersistenceError::DanglingReference {
                source: entity.clone(),
                field: SnapshotField::EntityId,
                target: entity_ref(EntityKind::Sim, &trip.sim_id),
            });
        };
        let (service_day, sequence) =
            parse_trip_id(&trip.id).expect("entity stage validates canonical trip IDs");
        if service_day > snapshot.day {
            return Err(PersistenceError::InvalidEntity {
                entity: entity.clone(),
                field: SnapshotField::TripServiceDay,
                reason: EntityError::InvalidStaticShape,
            });
        }
        if service_day == snapshot.day {
            max_current_day_sequence = max_current_day_sequence.max(sequence);
        }
        if !trip_keys.insert((
            trip.sim_id.as_str(),
            service_day,
            purpose_order(trip.purpose),
        )) {
            return Err(PersistenceError::InvalidDerivedState {
                field: SnapshotField::TripPurpose,
                reason: DerivedStateError::TripStateMismatch {
                    trip: entity.clone(),
                },
            });
        }

        validate_trip_endpoints(snapshot, trip, sim)?;
        finite_non_negative(
            Some(entity.clone()),
            SnapshotField::TripDeadline,
            trip.deadline,
        )?;
        finite_range(
            Some(entity.clone()),
            SnapshotField::TripPatience,
            trip.patience_remaining,
            0.0,
            trips::WAIT_PATIENCE_SECONDS,
        )?;
        validate_world_position(snapshot, trip, entity.clone())?;
        validate_route_plan(snapshot, trip, entity.clone())?;
        validate_vehicle_membership(snapshot, trip, entity)?;
    }

    validate_trip_counters(snapshot, max_current_day_sequence)?;
    validate_metrics(snapshot)
}

fn validate_sims(snapshot: &GameSnapshot) -> PersistenceResult<()> {
    for sim in &snapshot.sims {
        let entity = entity_ref(EntityKind::Sim, &sim.id);
        validate_point(snapshot, &entity, SnapshotField::SimHome, sim.home)?;
        validate_point(snapshot, &entity, SnapshotField::SimPosition, sim.position)?;
        if let Some(workplace) = sim.workplace {
            validate_point(snapshot, &entity, SnapshotField::SimWorkplace, workplace)?;
        }

        let expected_profile = commute::worker_profile_for_id(&sim.id);
        if sim.worker_profile != expected_profile {
            return Err(invalid_entity_field(
                entity,
                SnapshotField::SimWorkerProfile,
            ));
        }
        let expected_shift = commute::shift_template_for_id(&sim.id);
        if sim.shift_template.as_deref() != expected_shift {
            return Err(invalid_entity_field(
                entity,
                SnapshotField::SimShiftTemplate,
            ));
        }
        if sim.worker_profile == WorkerProfile::NonWorker
            && (sim.shift_template.is_some() || sim.workplace.is_some())
        {
            return Err(invalid_entity_field(
                entity,
                SnapshotField::SimWorkerProfile,
            ));
        }
        if sim.commute_day > snapshot.day {
            return Err(invalid_entity_field(entity, SnapshotField::SimCommuteDay));
        }
        let invalid_flags = [
            sim.outbound_arrived_today && !sim.outbound_resolved_today,
            sim.returned_home_today && !sim.return_resolved_today,
            (sim.return_resolved_today || sim.returned_home_today)
                && (!sim.outbound_resolved_today || !sim.outbound_arrived_today),
        ]
        .into_iter()
        .any(std::convert::identity);
        if invalid_flags {
            return Err(invalid_entity_field(entity, SnapshotField::SimDailyFlags));
        }
    }
    Ok(())
}

fn validate_trip_endpoints(
    snapshot: &GameSnapshot,
    trip: &ActiveTrip,
    sim: &crate::model::Sim,
) -> PersistenceResult<()> {
    let entity = entity_ref(EntityKind::ActiveTrip, &trip.id);
    validate_point(snapshot, &entity, SnapshotField::TripOrigin, trip.origin)?;
    validate_point(
        snapshot,
        &entity,
        SnapshotField::TripDestination,
        trip.destination,
    )?;
    if sim.position != trip.origin {
        return Err(PersistenceError::InvalidDerivedState {
            field: SnapshotField::TripPosition,
            reason: DerivedStateError::TripPositionMismatch { trip: entity },
        });
    }
    let valid = match trip.purpose {
        TripPurpose::CommuteOutbound => {
            trip.origin == sim.home
                && (trip.destination == sim.home || sim.workplace == Some(trip.destination))
        }
        TripPurpose::CommuteReturn => trip.destination == sim.home,
    };
    if !valid {
        return Err(PersistenceError::InvalidDerivedState {
            field: match trip.purpose {
                TripPurpose::CommuteOutbound => SnapshotField::TripOrigin,
                TripPurpose::CommuteReturn => SnapshotField::TripDestination,
            },
            reason: DerivedStateError::TripStateMismatch { trip: entity },
        });
    }
    Ok(())
}

fn validate_world_position(
    snapshot: &GameSnapshot,
    trip: &ActiveTrip,
    entity: EntityRef,
) -> PersistenceResult<()> {
    if !trip.position.x.is_finite() || !trip.position.y.is_finite() {
        return Err(PersistenceError::InvalidNumericValue {
            entity: Some(entity),
            field: SnapshotField::TripPosition,
            reason: NumericError::NotFinite,
        });
    }
    if trip.position.x < 0.0
        || trip.position.y < 0.0
        || trip.position.x >= f64::from(snapshot.map.width)
        || trip.position.y >= f64::from(snapshot.map.height)
    {
        return Err(PersistenceError::InvalidNumericValue {
            entity: Some(entity),
            field: SnapshotField::TripPosition,
            reason: NumericError::OutOfRange {
                minimum: 0.0,
                maximum: f64::from(snapshot.map.width.max(snapshot.map.height)),
                actual: trip.position.x.max(trip.position.y),
            },
        });
    }
    Ok(())
}

fn validate_route_plan(
    snapshot: &GameSnapshot,
    trip: &ActiveTrip,
    entity: EntityRef,
) -> PersistenceResult<()> {
    let Some(plan) = &trip.route_plan else {
        if trip.current_leg_index != 0
            || !matches!(trip.status, TripStatus::Idle | TripStatus::Unserved)
        {
            return Err(trip_state_error(SnapshotField::TripCurrentLegIndex, entity));
        }
        return Ok(());
    };

    finite_non_negative(
        Some(entity.clone()),
        SnapshotField::TripEstimatedSeconds,
        plan.estimated_seconds,
    )?;
    // `trip.origin` remains the sim's settled departure point. When a route
    // mutation invalidates a trip mid-journey, the next tick legitimately
    // replans from the trip's snapped world position without rewriting that
    // historical origin, so the first leg cannot be required to equal it.
    if plan.legs.is_empty()
        || trip.current_leg_index >= plan.legs.len()
        || plan.legs.last().map(|leg| leg.to) != Some(trip.destination)
        || plan.legs.windows(2).any(|legs| legs[0].to != legs[1].from)
    {
        return Err(trip_state_error(SnapshotField::TripRoutePlan, entity));
    }
    for leg in &plan.legs {
        validate_point(snapshot, &entity, SnapshotField::TripRoutePlan, leg.from)?;
        validate_point(snapshot, &entity, SnapshotField::TripRoutePlan, leg.to)?;
    }
    if router::route_plan_estimated_seconds(snapshot, plan) != Some(plan.estimated_seconds) {
        return Err(trip_state_error(SnapshotField::TripRoutePlan, entity));
    }

    let current_mode = plan.legs[trip.current_leg_index].mode;
    let valid_status = match trip.status {
        TripStatus::Idle => false,
        TripStatus::Walking => current_mode == TransitMode::Walk,
        TripStatus::Waiting | TripStatus::Riding => current_mode != TransitMode::Walk,
        TripStatus::Arrived | TripStatus::Late => {
            trip.current_leg_index + 1 == plan.legs.len()
                && trip.position == crate::model::TripPosition::from(trip.destination)
        }
        TripStatus::Unserved => true,
    };
    if !valid_status {
        return Err(trip_state_error(SnapshotField::TripStatus, entity));
    }
    Ok(())
}

fn validate_vehicle_membership(
    snapshot: &GameSnapshot,
    trip: &ActiveTrip,
    entity: EntityRef,
) -> PersistenceResult<()> {
    let memberships = snapshot
        .transit
        .vehicles
        .iter()
        .filter(|vehicle| vehicle.passenger_ids.iter().any(|id| id == &trip.id))
        .count();
    let valid = if trip.status == TripStatus::Riding {
        memberships == 1
    } else {
        memberships == 0
    };
    if !valid {
        return Err(trip_state_error(SnapshotField::TripStatus, entity));
    }
    Ok(())
}

fn validate_trip_counters(
    snapshot: &GameSnapshot,
    max_current_day_sequence: u32,
) -> PersistenceResult<()> {
    let valid = snapshot.trip_sequence_day <= snapshot.day
        && snapshot.next_trip_sequence >= 1
        && snapshot.next_trip_sequence.checked_add(1).is_some()
        && (snapshot.trip_sequence_day != snapshot.day
            || snapshot.next_trip_sequence > max_current_day_sequence);
    if !valid {
        return Err(PersistenceError::InvalidDerivedState {
            field: SnapshotField::NextTripSequence,
            reason: DerivedStateError::TripCounterMismatch,
        });
    }
    Ok(())
}

fn validate_metrics(snapshot: &GameSnapshot) -> PersistenceResult<()> {
    finite_non_negative(
        None,
        SnapshotField::MetricsWaits,
        snapshot.metrics.total_wait_seconds,
    )?;
    finite_non_negative(
        None,
        SnapshotField::MetricsWaits,
        snapshot.metrics.average_wait_seconds,
    )?;

    let nonterminal_count = snapshot
        .active_trips
        .iter()
        .filter(|trip| {
            matches!(
                trip.status,
                TripStatus::Idle | TripStatus::Walking | TripStatus::Waiting | TripStatus::Riding
            )
        })
        .count();
    if snapshot.metrics.late_trips > snapshot.metrics.completed_trips
        || (snapshot.metrics.waiting_trip_count == 0
            && snapshot.metrics.average_wait_seconds != 0.0)
        || usize::try_from(snapshot.metrics.waiting_trip_count)
            .map_or(true, |waiting| waiting > nonterminal_count)
    {
        return Err(metrics_relationship_error());
    }

    let mut retained_completed = 0_u32;
    let mut retained_late = 0_u32;
    let mut retained_unserved = 0_u32;
    let mut previous_time = None;
    for outcome in &snapshot.metrics.trip_outcomes {
        finite_non_negative(
            None,
            SnapshotField::OutcomeWaitSeconds,
            outcome.wait_seconds,
        )?;
        finite_non_negative(None, SnapshotField::OutcomeTimestamp, outcome.time)?;
        if outcome.time > snapshot.time
            || previous_time.is_some_and(|previous| outcome.time < previous)
        {
            return Err(outcome_window_error());
        }
        previous_time = Some(outcome.time);
        match outcome.outcome {
            TripOutcomeKind::Arrived => retained_completed = retained_completed.saturating_add(1),
            TripOutcomeKind::Late => {
                retained_completed = retained_completed.saturating_add(1);
                retained_late = retained_late.saturating_add(1);
            }
            TripOutcomeKind::Unserved => {
                retained_unserved = retained_unserved.saturating_add(1);
            }
        }
    }
    if snapshot.metrics.completed_trips < retained_completed
        || snapshot.metrics.late_trips < retained_late
        || snapshot.metrics.unserved_trips < retained_unserved
    {
        return Err(metrics_relationship_error());
    }

    let mut expected = snapshot.metrics.trip_outcomes.clone();
    objectives::prune_trip_outcomes(
        &mut expected,
        snapshot.time,
        objectives::effective_rolling_window_seconds(snapshot),
    );
    if expected != snapshot.metrics.trip_outcomes {
        return Err(outcome_window_error());
    }
    validate_objective_state(snapshot)
}

fn validate_objective_state(snapshot: &GameSnapshot) -> PersistenceResult<()> {
    if snapshot.rules.game_mode == GameMode::Sandbox {
        return Ok(());
    }
    if snapshot.scenario.objectives.is_none() {
        if snapshot.metrics.state == MetricsState::Running && snapshot.metrics.loss_reason.is_none()
        {
            return Ok(());
        }
        return Err(PersistenceError::InvalidModeSettings {
            field: SnapshotField::MetricsState,
            reason: ModeError::CampaignTerminalWithoutObjectives,
        });
    }
    match snapshot.metrics.state {
        MetricsState::Running => {
            if snapshot.metrics.loss_reason.is_some()
                || objectives::evaluate_objectives_opt(snapshot).is_some()
            {
                return Err(objective_state_error());
            }
        }
        MetricsState::Won | MetricsState::Lost => {
            let mut running = snapshot.clone();
            running.metrics.state = MetricsState::Running;
            running.metrics.loss_reason = None;
            let Some(expected) = objectives::evaluate_objectives_opt(&running) else {
                return Err(objective_state_error());
            };

            let expected_state = expected.metrics.state;
            let expected_reason = expected.metrics.loss_reason.clone();
            let mut unchanged = expected;
            unchanged.metrics.state = MetricsState::Running;
            unchanged.metrics.loss_reason = None;
            if unchanged != running {
                return Err(objective_state_error());
            }
            if expected_state != snapshot.metrics.state {
                return Err(objective_state_error());
            }
            if expected_reason != snapshot.metrics.loss_reason {
                return Err(PersistenceError::InvalidDerivedState {
                    field: SnapshotField::MetricsLossReason,
                    reason: DerivedStateError::LossReasonMismatch,
                });
            }
        }
    }
    Ok(())
}

fn validate_point(
    snapshot: &GameSnapshot,
    entity: &EntityRef,
    field: SnapshotField,
    point: Point,
) -> PersistenceResult<()> {
    if point.x < 0
        || point.y < 0
        || point.x >= i32::from(snapshot.map.width)
        || point.y >= i32::from(snapshot.map.height)
    {
        return Err(invalid_entity_field(entity.clone(), field));
    }
    Ok(())
}

fn finite_non_negative(
    entity: Option<EntityRef>,
    field: SnapshotField,
    value: f64,
) -> PersistenceResult<()> {
    if !value.is_finite() {
        return Err(PersistenceError::InvalidNumericValue {
            entity,
            field,
            reason: NumericError::NotFinite,
        });
    }
    if value < 0.0 {
        return Err(PersistenceError::InvalidNumericValue {
            entity,
            field,
            reason: NumericError::Negative,
        });
    }
    Ok(())
}

fn finite_range(
    entity: Option<EntityRef>,
    field: SnapshotField,
    value: f64,
    minimum: f64,
    maximum: f64,
) -> PersistenceResult<()> {
    finite_non_negative(entity.clone(), field, value)?;
    if !(minimum..=maximum).contains(&value) {
        return Err(PersistenceError::InvalidNumericValue {
            entity,
            field,
            reason: NumericError::OutOfRange {
                minimum,
                maximum,
                actual: value,
            },
        });
    }
    Ok(())
}

fn purpose_order(purpose: TripPurpose) -> u8 {
    match purpose {
        TripPurpose::CommuteOutbound => 0,
        TripPurpose::CommuteReturn => 1,
    }
}

fn invalid_entity_field(entity: EntityRef, field: SnapshotField) -> PersistenceError {
    PersistenceError::InvalidEntity {
        entity,
        field,
        reason: EntityError::InvalidStaticShape,
    }
}

fn trip_state_error(field: SnapshotField, trip: EntityRef) -> PersistenceError {
    PersistenceError::InvalidDerivedState {
        field,
        reason: DerivedStateError::TripStateMismatch { trip },
    }
}

fn metrics_relationship_error() -> PersistenceError {
    PersistenceError::InvalidDerivedState {
        field: SnapshotField::MetricsCounters,
        reason: DerivedStateError::MetricsRelationshipMismatch,
    }
}

fn outcome_window_error() -> PersistenceError {
    PersistenceError::InvalidDerivedState {
        field: SnapshotField::MetricsTripOutcomes,
        reason: DerivedStateError::OutcomeWindowMismatch,
    }
}

fn objective_state_error() -> PersistenceError {
    PersistenceError::InvalidDerivedState {
        field: SnapshotField::MetricsState,
        reason: DerivedStateError::ObjectiveStateMismatch,
    }
}

fn entity_ref(kind: EntityKind, id: &str) -> EntityRef {
    EntityRef {
        kind,
        id: id.to_string(),
    }
}

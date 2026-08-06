use crate::commute;
use crate::model::{ActiveTrip, GameSnapshot, Point, TransitMode, TripStatus};
use crate::trips;

use super::entities::{parse_trip_id, EntityIndexes};
use super::{
    DerivedStateError, EntityError, EntityKind, EntityRef, NumericError, PersistenceError,
    PersistenceResult, SnapshotField,
};

pub(super) fn validate_trips(
    snapshot: &GameSnapshot,
    indexes: &EntityIndexes<'_>,
) -> PersistenceResult<()> {
    validate_sims(snapshot)?;

    let mut trip_keys = std::collections::BTreeSet::new();
    for trip in &snapshot.active_trips {
        let entity = entity_ref(EntityKind::ActiveTrip, &trip.id);
        if indexes.sim(&trip.sim_id).is_none() {
            return Err(PersistenceError::DanglingReference {
                source: entity.clone(),
                field: SnapshotField::EntityId,
                target: entity_ref(EntityKind::Sim, &trip.sim_id),
            });
        }

        // A duplicate generated key would cause the next tick to address two
        // trips as the same commute.  Arbitrary user-authored IDs remain valid;
        // only parseable generated IDs participate in this safety index.
        if let Some((service_day, sequence)) = parse_trip_id(&trip.id) {
            if !trip_keys.insert((trip.sim_id.as_str(), service_day, sequence)) {
                return Err(PersistenceError::InvalidEntity {
                    entity: entity.clone(),
                    field: SnapshotField::EntityId,
                    reason: EntityError::InvalidStaticShape,
                });
            }
        }

        validate_trip_endpoints(snapshot, trip)?;
        super::finite_non_negative(
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
        validate_vehicle_membership(indexes, trip, entity)?;
    }

    validate_metrics(snapshot)
}

pub(super) fn normalize_direct_fields(snapshot: &mut GameSnapshot) {
    for sim in &mut snapshot.sims {
        sim.worker_profile = commute::worker_profile_for_id(&sim.id);
        sim.shift_template = commute::shift_template_for_id(&sim.id).map(str::to_string);
    }

    let max_current_day_sequence = snapshot
        .active_trips
        .iter()
        .filter_map(|trip| parse_trip_id(&trip.id))
        .filter_map(|(day, sequence)| (day == snapshot.day).then_some(sequence))
        .max()
        .unwrap_or(0);
    snapshot.trip_sequence_day = snapshot.day;
    snapshot.next_trip_sequence = max_current_day_sequence.saturating_add(1).max(1);
}

fn validate_sims(snapshot: &GameSnapshot) -> PersistenceResult<()> {
    for sim in &snapshot.sims {
        let entity = entity_ref(EntityKind::Sim, &sim.id);
        validate_point(snapshot, &entity, SnapshotField::SimHome, sim.home)?;
        validate_point(snapshot, &entity, SnapshotField::SimPosition, sim.position)?;
        if let Some(workplace) = sim.workplace {
            validate_point(snapshot, &entity, SnapshotField::SimWorkplace, workplace)?;
        }
    }
    Ok(())
}

fn validate_trip_endpoints(snapshot: &GameSnapshot, trip: &ActiveTrip) -> PersistenceResult<()> {
    let entity = entity_ref(EntityKind::ActiveTrip, &trip.id);
    validate_point(snapshot, &entity, SnapshotField::TripOrigin, trip.origin)?;
    validate_point(
        snapshot,
        &entity,
        SnapshotField::TripDestination,
        trip.destination,
    )?;
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

    super::finite_non_negative(
        Some(entity.clone()),
        SnapshotField::TripEstimatedSeconds,
        plan.estimated_seconds,
    )?;
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
        if leg.mode != TransitMode::Walk && leg.line_id.as_deref().map_or(true, str::is_empty) {
            return Err(trip_state_error(
                SnapshotField::TripRoutePlan,
                entity.clone(),
            ));
        }
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
    indexes: &EntityIndexes<'_>,
    trip: &ActiveTrip,
    entity: EntityRef,
) -> PersistenceResult<()> {
    let memberships = indexes
        .vehicles_for_trip(&trip.id)
        .map(|vehicles| vehicles.len())
        .unwrap_or(0);
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

fn validate_metrics(snapshot: &GameSnapshot) -> PersistenceResult<()> {
    super::finite_non_negative(
        None,
        SnapshotField::MetricsWaits,
        snapshot.metrics.total_wait_seconds,
    )?;
    super::finite_non_negative(
        None,
        SnapshotField::MetricsWaits,
        snapshot.metrics.average_wait_seconds,
    )?;
    for outcome in &snapshot.metrics.trip_outcomes {
        super::finite_non_negative(
            None,
            SnapshotField::OutcomeWaitSeconds,
            outcome.wait_seconds,
        )?;
        super::finite_non_negative(None, SnapshotField::OutcomeTimestamp, outcome.time)?;
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

fn finite_range(
    entity: Option<EntityRef>,
    field: SnapshotField,
    value: f64,
    minimum: f64,
    maximum: f64,
) -> PersistenceResult<()> {
    super::finite_non_negative(entity.clone(), field, value)?;
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

fn entity_ref(kind: EntityKind, id: &str) -> EntityRef {
    EntityRef {
        kind,
        id: id.to_string(),
    }
}

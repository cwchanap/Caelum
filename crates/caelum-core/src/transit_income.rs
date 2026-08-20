use crate::model::{ActiveTrip, EconomyPreset, GameSnapshot, TripStatus};

pub(crate) const TRANSIT_TRIP_INCOME: i32 = 200;

pub(crate) fn completed_transit_trip_income(trip: &ActiveTrip) -> i32 {
    if !matches!(trip.status, TripStatus::Arrived | TripStatus::Late) {
        return 0;
    }

    if trip
        .route_plan
        .as_ref()
        .is_some_and(crate::trips::plan_used_transit)
    {
        TRANSIT_TRIP_INCOME
    } else {
        0
    }
}

pub(crate) fn apply_transit_income(state: &mut GameSnapshot, amount: i32) {
    if amount == 0 || state.rules.economy_preset == EconomyPreset::Creative {
        return;
    }

    state.budget = state.budget.saturating_add(amount);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        Point, RouteLeg, RoutePlan, ServiceDirection, TransitMode, TripPosition, TripPurpose,
    };

    fn trip(status: TripStatus, modes: &[TransitMode]) -> ActiveTrip {
        let legs = modes
            .iter()
            .enumerate()
            .map(|(index, mode)| RouteLeg {
                mode: *mode,
                from: Point {
                    x: index as i32,
                    y: 0,
                },
                to: Point {
                    x: index as i32 + 1,
                    y: 0,
                },
                line_id: match mode {
                    TransitMode::Bus => Some("bus-1".to_string()),
                    TransitMode::Metro => Some("metro-1".to_string()),
                    TransitMode::Walk => None,
                },
                service_direction: match mode {
                    TransitMode::Walk => None,
                    TransitMode::Bus | TransitMode::Metro => Some(ServiceDirection::Loop),
                },
                board_itinerary_index: None,
                alight_itinerary_index: None,
            })
            .collect();

        ActiveTrip {
            id: "trip-income-fixture".to_string(),
            sim_id: "sim-income-fixture".to_string(),
            purpose: TripPurpose::CommuteOutbound,
            origin: Point { x: 0, y: 0 },
            destination: Point {
                x: modes.len() as i32,
                y: 0,
            },
            position: TripPosition {
                x: modes.len() as f64,
                y: 0.0,
            },
            status,
            deadline: 1_000.0,
            route_plan: Some(RoutePlan {
                legs,
                estimated_seconds: 1.0,
            }),
            current_leg_index: modes.len(),
            patience_remaining: 240.0,
            current_leg_wait_seconds: 0.0,
            private_car_trip: None,
        }
    }

    #[test]
    fn completed_transit_journey_earns_fixed_income_once() {
        assert_eq!(
            completed_transit_trip_income(&trip(TripStatus::Arrived, &[TransitMode::Bus])),
            200,
        );
        assert_eq!(
            completed_transit_trip_income(&trip(TripStatus::Late, &[TransitMode::Metro])),
            200,
        );
        assert_eq!(
            completed_transit_trip_income(&trip(
                TripStatus::Arrived,
                &[TransitMode::Walk, TransitMode::Bus, TransitMode::Metro],
            )),
            200,
        );
    }

    #[test]
    fn non_revenue_trip_shapes_earn_zero() {
        assert_eq!(
            completed_transit_trip_income(&trip(TripStatus::Arrived, &[TransitMode::Walk])),
            0,
        );
        assert_eq!(
            completed_transit_trip_income(&trip(TripStatus::Arrived, &[])),
            0
        );
        assert_eq!(
            completed_transit_trip_income(&trip(TripStatus::Unserved, &[TransitMode::Bus])),
            0,
        );
        assert_eq!(
            completed_transit_trip_income(&trip(TripStatus::Riding, &[TransitMode::Bus])),
            0,
        );

        let mut planless = trip(TripStatus::Arrived, &[TransitMode::Bus]);
        planless.route_plan = None;
        assert_eq!(completed_transit_trip_income(&planless), 0);
    }

    #[test]
    fn standard_income_can_recover_negative_budget_and_saturates() {
        let mut state = crate::state::create_initial_snapshot();
        state.budget = -100;

        apply_transit_income(&mut state, 200);
        assert_eq!(state.budget, 100);

        state.budget = i32::MAX - 50;
        apply_transit_income(&mut state, 200);
        assert_eq!(state.budget, i32::MAX);
    }

    #[test]
    fn creative_and_zero_amount_do_not_mutate_budget() {
        let mut state = crate::state::create_initial_snapshot();
        state.budget = 123;
        state.rules.economy_preset = EconomyPreset::Creative;
        apply_transit_income(&mut state, 200);
        assert_eq!(state.budget, 123);

        state.rules.economy_preset = EconomyPreset::Standard;
        apply_transit_income(&mut state, 0);
        assert_eq!(state.budget, 123);
    }
}

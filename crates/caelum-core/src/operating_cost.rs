#![allow(dead_code)] // Staged authority API; Tasks 2-3 add its runtime consumers.

use crate::model::{EconomyPreset, GameSnapshot, RouteLegPath, TransitMode};
use crate::route_lifecycle::is_route_operational;

pub(crate) const BUS_DAILY_OPERATING_COST: i32 = 400;
pub(crate) const METRO_DAILY_OPERATING_COST: i32 = 2_500;

pub(crate) fn vehicle_daily_operating_cost(mode: TransitMode) -> i32 {
    match mode {
        TransitMode::Bus => BUS_DAILY_OPERATING_COST,
        TransitMode::Metro => METRO_DAILY_OPERATING_COST,
        TransitMode::Walk => 0,
    }
}

pub(crate) fn fleet_daily_operating_cost(mode: TransitMode, fleet: usize) -> i32 {
    let fleet = i32::try_from(fleet).unwrap_or(i32::MAX);
    vehicle_daily_operating_cost(mode).saturating_mul(fleet)
}

pub(crate) fn line_daily_operating_cost(
    route_active: bool,
    legs: &[RouteLegPath],
    mode: TransitMode,
    assigned_fleet: usize,
) -> i32 {
    if assigned_fleet == 0
        || legs.is_empty()
        || !is_route_operational(route_active, legs)
        || legs.iter().any(|leg| leg.current_path.is_none())
    {
        return 0;
    }
    fleet_daily_operating_cost(mode, assigned_fleet)
}

pub(crate) fn estimated_line_daily_operating_cost(
    mode: TransitMode,
    assigned_fleet: usize,
    required_fleet: Option<usize>,
) -> Option<i32> {
    if assigned_fleet > 0 {
        return None;
    }
    required_fleet.map(|required| fleet_daily_operating_cost(mode, required))
}

pub(crate) fn city_daily_operating_cost(state: &GameSnapshot) -> i32 {
    let bus = state.transit.routes.iter().fold(0_i32, |total, route| {
        total.saturating_add(line_daily_operating_cost(
            route.active,
            &route.legs,
            TransitMode::Bus,
            route.vehicle_ids.len(),
        ))
    });

    state.transit.metro_lines.iter().fold(bus, |total, line| {
        total.saturating_add(line_daily_operating_cost(
            line.active,
            &line.legs,
            TransitMode::Metro,
            line.vehicle_ids.len(),
        ))
    })
}

pub(crate) fn apply_day_boundary_charge(state: &mut GameSnapshot, previous_day: u32) {
    if state.day <= previous_day || state.rules.economy_preset == EconomyPreset::Creative {
        return;
    }
    let total = city_daily_operating_cost(state);
    if total > 0 {
        state.budget = state.budget.saturating_sub(total);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        MetroLine, Route, RouteLegKind, RouteLegStatus, ServiceDirection, ServicePattern,
        TransitPath,
    };

    fn connected_leg() -> RouteLegPath {
        RouteLegPath {
            from_waypoint_id: "a".into(),
            to_waypoint_id: "b".into(),
            direction: ServiceDirection::Loop,
            kind: RouteLegKind::Service,
            status: RouteLegStatus::Connected,
            current_path: Some(TransitPath::Road {
                steps: Vec::new(),
                total_travel_seconds: 0.0,
            }),
            last_valid_path: None,
            estimated_seconds: Some(1.0),
            failure_reason: None,
        }
    }

    #[test]
    fn actual_line_cost_is_only_for_assigned_operational_service() {
        let legs = vec![connected_leg()];
        assert_eq!(
            line_daily_operating_cost(true, &legs, TransitMode::Bus, 2),
            800
        );
        assert_eq!(
            line_daily_operating_cost(false, &legs, TransitMode::Bus, 2),
            0
        );
        assert_eq!(line_daily_operating_cost(true, &[], TransitMode::Bus, 2), 0);
        assert_eq!(
            line_daily_operating_cost(true, &legs, TransitMode::Bus, 0),
            0
        );

        let mut missing_path = connected_leg();
        missing_path.current_path = None;
        assert_eq!(
            line_daily_operating_cost(true, &[missing_path], TransitMode::Bus, 2),
            0,
        );

        let mut broken = connected_leg();
        broken.status = RouteLegStatus::NetworkDisconnected;
        assert_eq!(
            line_daily_operating_cost(true, &[broken], TransitMode::Bus, 2),
            0,
        );
    }

    #[test]
    fn estimated_cost_exists_only_before_fleet_assignment() {
        assert_eq!(
            estimated_line_daily_operating_cost(TransitMode::Bus, 0, Some(3)),
            Some(1_200),
        );
        assert_eq!(
            estimated_line_daily_operating_cost(TransitMode::Bus, 0, None),
            None,
        );
        assert_eq!(
            estimated_line_daily_operating_cost(TransitMode::Bus, 1, Some(3)),
            None,
        );
    }

    #[test]
    fn mode_costs_and_fleet_multiplication_are_explicit() {
        assert_eq!(vehicle_daily_operating_cost(TransitMode::Bus), 400);
        assert_eq!(vehicle_daily_operating_cost(TransitMode::Metro), 2_500);
        assert_eq!(vehicle_daily_operating_cost(TransitMode::Walk), 0);
        assert_eq!(fleet_daily_operating_cost(TransitMode::Metro, 3), 7_500);
        assert_eq!(
            fleet_daily_operating_cost(TransitMode::Metro, usize::MAX),
            i32::MAX
        );
    }

    fn test_bus_route(legs: Vec<RouteLegPath>, fleet: usize) -> Route {
        Route {
            id: "route-001".to_string(),
            name: "Fixture".to_string(),
            color: "#111111".to_string(),
            stop_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
            vehicle_ids: (0..fleet)
                .map(|index| format!("vehicle-{index:03}"))
                .collect(),
            active: true,
            pattern: ServicePattern::Shuttle,
            revision: 1,
            legs,
            path_broken: false,
            target_headway_seconds: None,
            service_metrics: None,
        }
    }

    fn test_metro_line(legs: Vec<RouteLegPath>, fleet: usize) -> MetroLine {
        MetroLine {
            id: "line-001".to_string(),
            name: "Fixture".to_string(),
            color: "#111111".to_string(),
            station_ids: vec!["station-001".to_string(), "station-002".to_string()],
            vehicle_ids: (0..fleet)
                .map(|index| format!("vehicle-{index:03}"))
                .collect(),
            active: true,
            pattern: ServicePattern::Shuttle,
            revision: 1,
            legs,
            path_broken: false,
            target_headway_seconds: None,
            service_metrics: None,
        }
    }

    #[test]
    fn standard_debit_can_cross_below_zero_but_creative_does_not_pay() {
        let mut state = crate::state::create_initial_snapshot();
        state.transit.routes.clear();
        state.transit.metro_lines.clear();
        state.budget = 399;
        state.day = 1;

        state
            .transit
            .routes
            .push(test_bus_route(vec![connected_leg()], 1));

        apply_day_boundary_charge(&mut state, 0);
        assert_eq!(state.budget, -1);

        state.budget = 399;
        state.rules.economy_preset = EconomyPreset::Creative;
        apply_day_boundary_charge(&mut state, 0);
        assert_eq!(state.budget, 399);
    }

    #[test]
    fn city_cost_sums_bus_and_metro_and_excludes_zero_fleet_lines() {
        let mut state = crate::state::create_initial_snapshot();
        state.transit.routes.clear();
        state.transit.metro_lines.clear();

        state
            .transit
            .routes
            .push(test_bus_route(vec![connected_leg()], 1));
        let mut zero_fleet = test_bus_route(vec![connected_leg()], 0);
        zero_fleet.id = "route-zero-fleet".to_string();
        state.transit.routes.push(zero_fleet);
        state
            .transit
            .metro_lines
            .push(test_metro_line(vec![connected_leg()], 1));

        assert_eq!(city_daily_operating_cost(&state), 2_900);
    }
}

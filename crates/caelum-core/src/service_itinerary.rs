use crate::model::RouteLegPath;
use crate::model::{RouteLegKind, ServiceDirection, ServicePattern};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceLegSpec {
    pub from_waypoint_id: String,
    pub to_waypoint_id: String,
    pub direction: ServiceDirection,
    pub kind: RouteLegKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceVisit {
    pub waypoint_id: String,
    pub direction: ServiceDirection,
    pub arriving_itinerary_index: Option<usize>,
    pub departing_itinerary_index: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RideEdge {
    pub board_waypoint_id: String,
    pub alight_waypoint_id: String,
    pub service_direction: ServiceDirection,
    pub board_itinerary_index: usize,
    pub alight_itinerary_index: usize,
    pub itinerary_leg_indexes: Vec<usize>,
}

impl RideEdge {
    fn from_visits(
        board: &ServiceVisit,
        alight: &ServiceVisit,
        legs: &[RouteLegPath],
    ) -> Option<Self> {
        // Invariant: every `ServiceVisit` produced by `service_visits` has an
        // arriving service leg (the cyclic itinerary guarantees a predecessor
        // service leg for every departure). Returning `None` instead of
        // `expect`-ing keeps a malformed (non-cyclic) itinerary from panicking
        // under the Tauri Mutex during a tick; `enumerate_ride_edges` drops the
        // degenerate edge so the rider simply cannot board that leg.
        let alight_itinerary_index = alight.arriving_itinerary_index?;
        let mut itinerary_leg_indexes = Vec::new();
        let mut index = board.departing_itinerary_index;
        loop {
            itinerary_leg_indexes.push(index);
            if index == alight_itinerary_index {
                break;
            }
            index = (index + 1) % legs.len();
        }
        Some(Self {
            board_waypoint_id: board.waypoint_id.clone(),
            alight_waypoint_id: alight.waypoint_id.clone(),
            service_direction: board.direction,
            board_itinerary_index: board.departing_itinerary_index,
            alight_itinerary_index,
            itinerary_leg_indexes,
        })
    }
}

impl ServiceLegSpec {
    pub fn key(&self) -> (&str, &str, ServiceDirection, RouteLegKind) {
        (
            &self.from_waypoint_id,
            &self.to_waypoint_id,
            self.direction,
            self.kind,
        )
    }
}

pub fn build_service_itinerary(
    pattern: ServicePattern,
    waypoint_ids: &[String],
) -> Vec<ServiceLegSpec> {
    if waypoint_ids.len() < 2 {
        return Vec::new();
    }
    match pattern {
        ServicePattern::Loop => loop_specs(waypoint_ids),
        ServicePattern::Shuttle => shuttle_specs(waypoint_ids),
    }
}

pub fn service_visits(waypoint_ids: &[String], legs: &[RouteLegPath]) -> Vec<ServiceVisit> {
    legs.iter()
        .enumerate()
        .filter(|(_, leg)| {
            leg.kind == RouteLegKind::Service
                && waypoint_ids
                    .iter()
                    .any(|waypoint_id| waypoint_id == &leg.from_waypoint_id)
        })
        .map(|(index, leg)| ServiceVisit {
            waypoint_id: leg.from_waypoint_id.clone(),
            direction: leg.direction,
            arriving_itinerary_index: previous_service_leg_index(legs, index),
            departing_itinerary_index: index,
        })
        .collect()
}

pub fn enumerate_ride_edges(visits: &[ServiceVisit], legs: &[RouteLegPath]) -> Vec<RideEdge> {
    if legs.is_empty() {
        return Vec::new();
    }
    visits
        .iter()
        .enumerate()
        .flat_map(|(board_order, board)| {
            downstream_visits_before_repeat(visits, board_order)
                .filter_map(move |alight| RideEdge::from_visits(board, alight, legs))
        })
        .collect()
}

fn previous_service_leg_index(legs: &[RouteLegPath], index: usize) -> Option<usize> {
    (1..=legs.len())
        .map(|offset| (index + legs.len() - offset) % legs.len())
        .find(|candidate| legs[*candidate].kind == RouteLegKind::Service)
}

fn downstream_visits_before_repeat(
    visits: &[ServiceVisit],
    board_order: usize,
) -> impl Iterator<Item = &ServiceVisit> {
    (1..visits.len()).map(move |offset| &visits[(board_order + offset) % visits.len()])
}

fn loop_specs(ids: &[String]) -> Vec<ServiceLegSpec> {
    (0..ids.len())
        .map(|index| ServiceLegSpec {
            from_waypoint_id: ids[index].clone(),
            to_waypoint_id: ids[(index + 1) % ids.len()].clone(),
            direction: ServiceDirection::Loop,
            kind: RouteLegKind::Service,
        })
        .collect()
}

fn shuttle_specs(ids: &[String]) -> Vec<ServiceLegSpec> {
    let mut result = Vec::with_capacity(ids.len().saturating_mul(2));
    for pair in ids.windows(2) {
        result.push(service_spec(&pair[0], &pair[1], ServiceDirection::Outbound));
    }
    // `build_service_itinerary` returns an empty vec for `< 2` waypoints, so
    // `ids.last()` is always `Some` here. Guard defensively so a future caller
    // that bypasses that check returns an empty itinerary instead of panicking
    // under the Tauri Mutex.
    let Some(terminal) = ids.last() else {
        return result;
    };
    result.push(reversal_spec(terminal, ServiceDirection::Return));
    for pair in ids.windows(2).rev() {
        result.push(service_spec(&pair[1], &pair[0], ServiceDirection::Return));
    }
    result.push(reversal_spec(&ids[0], ServiceDirection::Outbound));
    result
}

fn service_spec(from: &str, to: &str, direction: ServiceDirection) -> ServiceLegSpec {
    ServiceLegSpec {
        from_waypoint_id: from.to_string(),
        to_waypoint_id: to.to_string(),
        direction,
        kind: RouteLegKind::Service,
    }
}

fn reversal_spec(terminal: &str, direction: ServiceDirection) -> ServiceLegSpec {
    ServiceLegSpec {
        from_waypoint_id: terminal.to_string(),
        to_waypoint_id: terminal.to_string(),
        direction,
        kind: RouteLegKind::TerminalReversal,
    }
}

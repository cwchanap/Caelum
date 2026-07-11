use crate::model::{RouteLegKind, ServiceDirection, ServicePattern, TransitMode};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceLegSpec {
    pub from_waypoint_id: String,
    pub to_waypoint_id: String,
    pub direction: ServiceDirection,
    pub kind: RouteLegKind,
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
    mode: TransitMode,
    pattern: ServicePattern,
    waypoint_ids: &[String],
) -> Vec<ServiceLegSpec> {
    if waypoint_ids.len() < 2 {
        return Vec::new();
    }
    match pattern {
        ServicePattern::Loop => loop_specs(waypoint_ids),
        ServicePattern::Shuttle => shuttle_specs(mode, waypoint_ids),
    }
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

fn shuttle_specs(_mode: TransitMode, ids: &[String]) -> Vec<ServiceLegSpec> {
    let mut result = Vec::with_capacity(ids.len().saturating_mul(2));
    for pair in ids.windows(2) {
        result.push(service_spec(&pair[0], &pair[1], ServiceDirection::Outbound));
    }
    result.push(reversal_spec(
        ids.last().expect("validated itinerary has a terminal"),
        ServiceDirection::Return,
    ));
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

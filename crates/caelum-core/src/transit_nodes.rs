use crate::model::{BusStopKind, GameSnapshot, Point, TransitMode, TransitNodeStatus};
use crate::rejection::{GameplayRejection, GameplayResult, RejectionCode, RejectionContext};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogicalNodeKind {
    BusStop,
    BusTerminal,
    MetroStation,
}

pub fn is_present_node(status: TransitNodeStatus) -> bool {
    status == TransitNodeStatus::Present
}

pub fn validate_present_compatible_node(
    snapshot: &GameSnapshot,
    mode: TransitMode,
    node_id: &str,
    route_id: Option<&str>,
) -> GameplayResult<()> {
    let compatible_status = match mode {
        TransitMode::Bus => snapshot
            .transit
            .stops
            .iter()
            .find(|stop| stop.id == node_id)
            .map(|stop| stop.status),
        TransitMode::Metro => snapshot
            .transit
            .stations
            .iter()
            .find(|station| station.id == node_id)
            .map(|station| station.status),
        TransitMode::Walk => None,
    };
    if compatible_status.is_some_and(is_present_node) {
        return Ok(());
    }

    let other_mode_exists = match mode {
        TransitMode::Bus => snapshot
            .transit
            .stations
            .iter()
            .any(|station| station.id == node_id),
        TransitMode::Metro => snapshot.transit.stops.iter().any(|stop| stop.id == node_id),
        TransitMode::Walk => true,
    };
    Err(GameplayRejection {
        code: if compatible_status.is_some() {
            RejectionCode::MissingRouteNode
        } else if other_mode_exists {
            RejectionCode::IncompatibleRouteNode
        } else {
            RejectionCode::MissingRouteNode
        },
        context: RejectionContext {
            route_id: route_id.map(str::to_string),
            node_id: Some(node_id.to_string()),
            ..RejectionContext::default()
        },
    })
}

pub fn canonical_node_anchor(snapshot: &GameSnapshot, clicked: Point) -> Option<Point> {
    snapshot
        .buildings
        .iter()
        .find(|building| building.occupied_tiles.contains(&clicked))
        .map(|building| building.origin)
        .or(Some(clicked))
}

pub fn remove_or_tombstone_node(state: &GameSnapshot, node_id: &str) -> GameSnapshot {
    let mut next = state.clone();
    if node_reference_count(state, node_id) == 0 {
        next.transit.stops.retain(|stop| stop.id != node_id);
        next.transit
            .stations
            .retain(|station| station.id != node_id);
    } else {
        if let Some(stop) = next
            .transit
            .stops
            .iter_mut()
            .find(|stop| stop.id == node_id)
        {
            stop.status = TransitNodeStatus::Missing;
        }
        if let Some(station) = next
            .transit
            .stations
            .iter_mut()
            .find(|station| station.id == node_id)
        {
            station.status = TransitNodeStatus::Missing;
        }
    }
    next
}

pub fn restore_or_create_node(
    state: &GameSnapshot,
    kind: LogicalNodeKind,
    anchor: Point,
    allocate: impl FnOnce(&GameSnapshot) -> GameplayResult<GameSnapshot>,
) -> GameplayResult<GameSnapshot> {
    let matches = matching_tombstone_ids(state, kind, anchor);
    match matches.as_slice() {
        [] => allocate(state),
        [id] => {
            let mut next = state.clone();
            if let Some(stop) = next.transit.stops.iter_mut().find(|stop| stop.id == **id) {
                stop.status = TransitNodeStatus::Present;
            }
            if let Some(station) = next
                .transit
                .stations
                .iter_mut()
                .find(|station| station.id == **id)
            {
                station.status = TransitNodeStatus::Present;
            }
            Ok(next)
        }
        _ => Err(GameplayRejection::at(
            RejectionCode::AmbiguousTransitNode,
            anchor,
        )),
    }
}

pub fn garbage_collect_missing_nodes(state: &GameSnapshot) -> GameSnapshot {
    let mut next = state.clone();
    next.transit.stops.retain(|stop| {
        stop.status != TransitNodeStatus::Missing || node_reference_count(state, &stop.id) > 0
    });
    next.transit.stations.retain(|station| {
        station.status != TransitNodeStatus::Missing || node_reference_count(state, &station.id) > 0
    });
    next
}

pub fn logical_kind_for_stop(kind: BusStopKind) -> LogicalNodeKind {
    match kind {
        BusStopKind::BusStop => LogicalNodeKind::BusStop,
        BusStopKind::BusTerminal => LogicalNodeKind::BusTerminal,
    }
}

pub fn matching_present_node_id(
    state: &GameSnapshot,
    kind: LogicalNodeKind,
    anchor: Point,
) -> Option<String> {
    match kind {
        LogicalNodeKind::BusStop | LogicalNodeKind::BusTerminal => state
            .transit
            .stops
            .iter()
            .find(|stop| {
                stop.status == TransitNodeStatus::Present
                    && stop.position == anchor
                    && logical_kind_for_stop(stop.kind) == kind
            })
            .map(|stop| stop.id.clone()),
        LogicalNodeKind::MetroStation => state
            .transit
            .stations
            .iter()
            .find(|station| {
                station.status == TransitNodeStatus::Present && station.position == anchor
            })
            .map(|station| station.id.clone()),
    }
}

fn matching_tombstone_ids(
    state: &GameSnapshot,
    kind: LogicalNodeKind,
    anchor: Point,
) -> Vec<String> {
    match kind {
        LogicalNodeKind::BusStop | LogicalNodeKind::BusTerminal => state
            .transit
            .stops
            .iter()
            .filter(|stop| {
                stop.status == TransitNodeStatus::Missing
                    && stop.position == anchor
                    && logical_kind_for_stop(stop.kind) == kind
            })
            .map(|stop| stop.id.clone())
            .collect(),
        LogicalNodeKind::MetroStation => state
            .transit
            .stations
            .iter()
            .filter(|station| {
                station.status == TransitNodeStatus::Missing && station.position == anchor
            })
            .map(|station| station.id.clone())
            .collect(),
    }
}

fn node_reference_count(state: &GameSnapshot, node_id: &str) -> usize {
    state
        .transit
        .routes
        .iter()
        .map(|route| {
            route
                .stop_ids
                .iter()
                .filter(|id| id.as_str() == node_id)
                .count()
        })
        .sum::<usize>()
        + state
            .transit
            .metro_lines
            .iter()
            .map(|line| {
                line.station_ids
                    .iter()
                    .filter(|id| id.as_str() == node_id)
                    .count()
            })
            .sum::<usize>()
}

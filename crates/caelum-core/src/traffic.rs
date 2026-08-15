use std::collections::{BTreeMap, BTreeSet};

use crate::commute::WALK_SECONDS_PER_TILE;
use crate::model::{GameSnapshot, Point, RoadPathStep, TransitPath, TripStatus};
use crate::road_topology::RoadTopology;
use crate::stop_access::derive_stop_access_for_footprint;

pub type RoadFlow = BTreeMap<Point, u16>;

pub const CAR_ACCESS_SECONDS: f64 = 120.0;
pub const ROAD_FLOW_CAPACITY: u16 = 4;
pub const MAX_CONGESTION_MULTIPLIER: f64 = 3.0;

#[derive(Clone, Debug, PartialEq)]
pub struct PrivateCarCandidate {
    pub path: TransitPath,
    pub estimated_seconds: f64,
}

pub fn congestion_multiplier(flow: u16) -> f64 {
    (f64::from(flow) / f64::from(ROAD_FLOW_CAPACITY)).clamp(1.0, MAX_CONGESTION_MULTIPLIER)
}

pub fn derive_road_flow(state: &GameSnapshot) -> RoadFlow {
    let mut flow = RoadFlow::new();
    for trip in &state.active_trips {
        if trip.status != TripStatus::Driving {
            continue;
        }
        let Some(private_car_trip) = trip.private_car_trip.as_ref() else {
            continue;
        };
        add_car_path_to_flow(&mut flow, &private_car_trip.path);
    }
    flow
}

pub fn add_car_path_to_flow(flow: &mut RoadFlow, path: &TransitPath) {
    for point in road_path_points(path) {
        let count = flow.entry(point).or_insert(0u16);
        *count = (*count).saturating_add(1);
    }
}

fn road_path_points(path: &TransitPath) -> BTreeSet<Point> {
    match path {
        TransitPath::Road { steps, .. } => steps.iter().map(|step| step.position).collect(),
        TransitPath::Track { .. } => BTreeSet::new(),
    }
}

pub fn private_car_candidate(
    state: &GameSnapshot,
    road_topology: &RoadTopology,
    flow: &RoadFlow,
    origin: Point,
    destination: Point,
) -> Option<PrivateCarCandidate> {
    let origin_building = state
        .buildings
        .iter()
        .find(|building| building.occupied_tiles.contains(&origin))?;
    let destination_building = state
        .buildings
        .iter()
        .find(|building| building.occupied_tiles.contains(&destination))?;
    let origin_access =
        derive_stop_access_for_footprint(&state.map, &origin_building.occupied_tiles)?;
    let destination_access =
        derive_stop_access_for_footprint(&state.map, &destination_building.occupied_tiles)?;
    let path = road_topology
        .find_path_between_access_tiles(
            &state.map,
            origin_access.road_point,
            destination_access.road_point,
            origin_access.preferred_heading,
            destination_access.preferred_heading,
        )
        .ok()?;
    let TransitPath::Road { steps, .. } = &path else {
        return None;
    };
    if steps.is_empty() {
        return None;
    }

    let road_seconds = steps
        .iter()
        .map(|step| {
            let flow_with_candidate = flow
                .get(&step.position)
                .copied()
                .unwrap_or(0)
                .saturating_add(1);
            step.travel_seconds * congestion_multiplier(flow_with_candidate)
        })
        .sum::<f64>();
    let estimated_seconds = f64::from(manhattan_distance(&origin, &origin_access.road_point))
        * WALK_SECONDS_PER_TILE
        + CAR_ACCESS_SECONDS
        + road_seconds
        + f64::from(manhattan_distance(
            &destination_access.road_point,
            &destination,
        )) * WALK_SECONDS_PER_TILE;

    Some(PrivateCarCandidate {
        path,
        estimated_seconds,
    })
}

pub fn effective_road_step_seconds(flow: &RoadFlow, step: &RoadPathStep) -> f64 {
    step.travel_seconds * congestion_multiplier(flow.get(&step.position).copied().unwrap_or(0))
}

pub fn effective_road_path_seconds(flow: &RoadFlow, path: &TransitPath) -> f64 {
    match path {
        // An empty road path is a synthetic terminal/reversal path: it keeps
        // its stored total duration instead of collapsing to a free 0.0.
        TransitPath::Road {
            steps,
            total_travel_seconds,
        } => {
            if steps.is_empty() {
                *total_travel_seconds
            } else {
                steps
                    .iter()
                    .map(|step| effective_road_step_seconds(flow, step))
                    .sum()
            }
        }
        TransitPath::Track {
            total_travel_seconds,
            ..
        } => *total_travel_seconds,
    }
}

fn manhattan_distance(from: &Point, to: &Point) -> i32 {
    (from.x - to.x).abs() + (from.y - to.y).abs()
}

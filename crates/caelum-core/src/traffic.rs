use std::collections::{BTreeMap, BTreeSet};

use crate::model::{GameSnapshot, Point, RoadPathStep, TransitPath, TripStatus};
use crate::road_topology::RoadTopology;
use crate::stop_access::derive_stop_access_for_footprint;

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

pub fn active_car_flow(state: &GameSnapshot) -> BTreeMap<Point, u16> {
    let mut flow: BTreeMap<Point, u16> = BTreeMap::new();
    for trip in &state.active_trips {
        if trip.status != TripStatus::Driving {
            continue;
        }
        let Some(private_car_trip) = trip.private_car_trip.as_ref() else {
            continue;
        };
        let TransitPath::Road { steps, .. } = &private_car_trip.path else {
            continue;
        };

        let unique_points: BTreeSet<_> = steps.iter().map(|step| step.position).collect();
        for point in unique_points {
            let count = flow.entry(point).or_insert(0u16);
            *count = (*count).saturating_add(1);
        }
    }
    flow
}

pub fn private_car_candidate(
    state: &GameSnapshot,
    road_topology: &RoadTopology,
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

    let flow = active_car_flow(state);
    let estimated_seconds = steps
        .iter()
        .map(|step| {
            let flow_with_candidate = flow
                .get(&step.position)
                .copied()
                .unwrap_or(0)
                .saturating_add(1);
            step.travel_seconds * congestion_multiplier(flow_with_candidate)
        })
        .sum();

    Some(PrivateCarCandidate {
        path,
        estimated_seconds,
    })
}

pub fn road_flow_at(state: &GameSnapshot, point: Point) -> u16 {
    active_car_flow(state).get(&point).copied().unwrap_or(0)
}

pub fn effective_road_step_seconds(state: &GameSnapshot, step: &RoadPathStep) -> f64 {
    step.travel_seconds * congestion_multiplier(road_flow_at(state, step.position))
}

pub fn effective_road_path_seconds(state: &GameSnapshot, path: &TransitPath) -> f64 {
    match path {
        TransitPath::Road { steps, .. } => steps
            .iter()
            .map(|step| effective_road_step_seconds(state, step))
            .sum(),
        TransitPath::Track {
            total_travel_seconds,
            ..
        } => *total_travel_seconds,
    }
}

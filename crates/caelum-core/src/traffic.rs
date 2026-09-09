use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::commute::WALK_SECONDS_PER_TILE;
use crate::model::{
    GameSnapshot, Heading, Point, RoadPathStep, StopRoadAccess, TransitPath, TripStatus,
};
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

/// Cached (origin access, destination access) Dijkstra key: the road points
/// and preferred headings fully identify one private-car road search.
type CarPathKey = (Point, Option<Heading>, Point, Option<Heading>);

/// Batch-oriented private-car planner: hoists per-building road-access
/// derivation and access-pair Dijkstra out of the per-candidate path, while
/// exact-tile walks and current-flow scoring stay per-call.
pub(crate) struct PrivateCarPlanner {
    pub(crate) access_by_tile: HashMap<Point, Option<StopRoadAccess>>,
    pub(crate) prepared_paths: HashMap<CarPathKey, Option<TransitPath>>,
}

impl PrivateCarPlanner {
    pub(crate) fn new(state: &GameSnapshot) -> Self {
        let mut access_by_tile: HashMap<Point, Option<StopRoadAccess>> = HashMap::new();
        for building in &state.buildings {
            let access = derive_stop_access_for_footprint(&state.map, &building.occupied_tiles);
            for tile in &building.occupied_tiles {
                // First building wins so a malformed overlap keeps the same
                // access the sequential `buildings.iter().find` lookup chose.
                access_by_tile.entry(*tile).or_insert(access);
            }
        }
        Self {
            access_by_tile,
            prepared_paths: HashMap::new(),
        }
    }

    pub(crate) fn candidate(
        &mut self,
        state: &GameSnapshot,
        road_topology: &RoadTopology,
        flow: &RoadFlow,
        origin: Point,
        destination: Point,
    ) -> Option<PrivateCarCandidate> {
        let origin_access = self.access_by_tile.get(&origin).copied()??;
        let destination_access = self.access_by_tile.get(&destination).copied()??;
        let path = self
            .prepared_paths
            .entry((
                origin_access.road_point,
                origin_access.preferred_heading,
                destination_access.road_point,
                destination_access.preferred_heading,
            ))
            .or_insert_with(|| {
                road_topology
                    .find_path_between_access_tiles(
                        &state.map,
                        origin_access.road_point,
                        destination_access.road_point,
                        origin_access.preferred_heading,
                        destination_access.preferred_heading,
                    )
                    .ok()
            })
            .clone()?;
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
}

pub fn private_car_candidate(
    state: &GameSnapshot,
    road_topology: &RoadTopology,
    flow: &RoadFlow,
    origin: Point,
    destination: Point,
) -> Option<PrivateCarCandidate> {
    PrivateCarPlanner::new(state).candidate(state, road_topology, flow, origin, destination)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intent::RoadPreset;
    use crate::model::PlacedBuilding;
    use crate::road::{apply_road_mutation, RoadMutation};
    use crate::road_topology::RoadTopology;
    use crate::state::create_initial_snapshot;

    fn building(id: &str, tiles: &[Point]) -> PlacedBuilding {
        PlacedBuilding {
            id: id.to_string(),
            building_type: "smallHouse".to_string(),
            origin: tiles[0],
            rotation: 0,
            occupied_tiles: tiles.to_vec(),
            placed_at: 0.0,
            transit_node_id: None,
        }
    }

    /// Blank-grid snapshot with a two-way road at y=5 and buildings on y=4:
    /// "home" occupies (1,4)-(2,4), "work" (7,4)-(8,4), "annex" (11,4)-(12,4).
    fn road_y5_fixture() -> GameSnapshot {
        let snapshot = create_initial_snapshot();
        let mut state = apply_road_mutation(
            &snapshot,
            &RoadMutation::LayRoadLine {
                points: (1..=12).map(|x| Point { x, y: 5 }).collect(),
                preset: RoadPreset::TwoWay,
            },
        )
        .expect("fixture road should apply")
        .snapshot;
        state.buildings = vec![
            building("home", &[Point { x: 1, y: 4 }, Point { x: 2, y: 4 }]),
            building("work", &[Point { x: 7, y: 4 }, Point { x: 8, y: 4 }]),
            building("annex", &[Point { x: 11, y: 4 }, Point { x: 12, y: 4 }]),
        ];
        state
    }

    fn fixture_topology(state: &GameSnapshot) -> RoadTopology {
        RoadTopology::compile(&state.map).expect("fixture topology compiles")
    }

    #[test]
    fn first_exact_od_prepares_one_road_path() {
        let state = road_y5_fixture();
        let topology = fixture_topology(&state);
        let mut planner = PrivateCarPlanner::new(&state);

        let candidate = planner
            .candidate(
                &state,
                &topology,
                &RoadFlow::new(),
                Point { x: 1, y: 4 },
                Point { x: 7, y: 4 },
            )
            .expect("exact OD inside road-adjacent buildings has a candidate");

        assert_eq!(planner.prepared_paths.len(), 1);
        assert!(!candidate.path.road_steps().is_empty());
    }

    #[test]
    fn second_exact_od_sharing_the_access_pair_reuses_the_prepared_path() {
        let state = road_y5_fixture();
        let topology = fixture_topology(&state);
        let mut planner = PrivateCarPlanner::new(&state);

        let first = planner
            .candidate(
                &state,
                &topology,
                &RoadFlow::new(),
                Point { x: 1, y: 4 },
                Point { x: 7, y: 4 },
            )
            .expect("first OD has a candidate");
        let second = planner
            .candidate(
                &state,
                &topology,
                &RoadFlow::new(),
                Point { x: 2, y: 4 },
                Point { x: 7, y: 4 },
            )
            .expect("second OD in the same buildings has a candidate");

        assert_eq!(planner.prepared_paths.len(), 1);
        assert_eq!(second.path, first.path);
    }

    #[test]
    fn exact_tile_walk_distances_change_eta_with_the_same_prepared_path() {
        let state = road_y5_fixture();
        let topology = fixture_topology(&state);
        let mut planner = PrivateCarPlanner::new(&state);

        let near = planner
            .candidate(
                &state,
                &topology,
                &RoadFlow::new(),
                Point { x: 1, y: 4 },
                Point { x: 7, y: 4 },
            )
            .expect("near-origin OD has a candidate");
        let far = planner
            .candidate(
                &state,
                &topology,
                &RoadFlow::new(),
                Point { x: 2, y: 4 },
                Point { x: 7, y: 4 },
            )
            .expect("far-origin OD has a candidate");

        assert_eq!(far.path, near.path);
        let walk_delta = far.estimated_seconds - near.estimated_seconds;
        assert!((walk_delta - WALK_SECONDS_PER_TILE).abs() < 1e-9);
    }

    #[test]
    fn repeated_flow_scoring_raises_eta_without_another_dijkstra() {
        let state = road_y5_fixture();
        let topology = fixture_topology(&state);
        let mut planner = PrivateCarPlanner::new(&state);
        let origin = Point { x: 1, y: 4 };
        let destination = Point { x: 8, y: 4 };

        let free = planner
            .candidate(&state, &topology, &RoadFlow::new(), origin, destination)
            .expect("free-flow candidate exists");

        let mut flow = RoadFlow::new();
        for step in free.path.road_steps() {
            flow.insert(step.position, 12);
        }
        let congested = planner
            .candidate(&state, &topology, &flow, origin, destination)
            .expect("congested candidate exists");

        assert!(congested.estimated_seconds > free.estimated_seconds);
        assert_eq!(congested.path, free.path);
        assert_eq!(planner.prepared_paths.len(), 1);
    }

    #[test]
    fn another_access_pair_prepares_a_second_entry() {
        let state = road_y5_fixture();
        let topology = fixture_topology(&state);
        let mut planner = PrivateCarPlanner::new(&state);

        planner
            .candidate(
                &state,
                &topology,
                &RoadFlow::new(),
                Point { x: 1, y: 4 },
                Point { x: 7, y: 4 },
            )
            .expect("home → work has a candidate");
        assert_eq!(planner.prepared_paths.len(), 1);

        planner
            .candidate(
                &state,
                &topology,
                &RoadFlow::new(),
                Point { x: 1, y: 4 },
                Point { x: 11, y: 4 },
            )
            .expect("home → annex has a candidate");

        assert_eq!(planner.prepared_paths.len(), 2);
    }

    #[test]
    fn overlapping_buildings_keep_first_building_access_lookup() {
        let mut state = road_y5_fixture();
        state.buildings = vec![
            building("front", &[Point { x: 3, y: 4 }, Point { x: 4, y: 4 }]),
            building("rear", &[Point { x: 4, y: 4 }, Point { x: 5, y: 4 }]),
            building("work", &[Point { x: 7, y: 4 }, Point { x: 8, y: 4 }]),
        ];
        let topology = fixture_topology(&state);
        let mut planner = PrivateCarPlanner::new(&state);

        let front_access = derive_stop_access_for_footprint(
            &state.map,
            &[Point { x: 3, y: 4 }, Point { x: 4, y: 4 }],
        )
        .expect("front building has roadside access");
        let rear_access = derive_stop_access_for_footprint(
            &state.map,
            &[Point { x: 4, y: 4 }, Point { x: 5, y: 4 }],
        )
        .expect("rear building has roadside access");
        assert_ne!(front_access, rear_access);

        let shared = Point { x: 4, y: 4 };
        assert_eq!(
            planner.access_by_tile.get(&shared).copied().flatten(),
            Some(front_access)
        );

        let work = Point { x: 7, y: 4 };
        let work_access = derive_stop_access_for_footprint(
            &state.map,
            &[Point { x: 7, y: 4 }, Point { x: 8, y: 4 }],
        )
        .expect("work building has roadside access");
        let candidate = planner
            .candidate(&state, &topology, &RoadFlow::new(), shared, work)
            .expect("overlapping tile still routes from the first building");
        let road_seconds: f64 = candidate
            .path
            .road_steps()
            .iter()
            .map(|step| step.travel_seconds)
            .sum();
        let expected = f64::from(manhattan_distance(&shared, &front_access.road_point))
            * WALK_SECONDS_PER_TILE
            + CAR_ACCESS_SECONDS
            + road_seconds
            + f64::from(manhattan_distance(&work_access.road_point, &work)) * WALK_SECONDS_PER_TILE;
        assert_eq!(candidate.estimated_seconds, expected);
    }

    #[test]
    fn no_road_access_returns_none() {
        let mut state = road_y5_fixture();
        state.buildings = vec![
            building("orphan", &[Point { x: 6, y: 10 }]),
            building("work", &[Point { x: 7, y: 4 }]),
        ];
        let topology = fixture_topology(&state);
        let mut planner = PrivateCarPlanner::new(&state);

        assert!(planner
            .candidate(
                &state,
                &topology,
                &RoadFlow::new(),
                Point { x: 6, y: 10 },
                Point { x: 7, y: 4 },
            )
            .is_none());
        assert!(planner
            .candidate(
                &state,
                &topology,
                &RoadFlow::new(),
                Point { x: 0, y: 0 },
                Point { x: 7, y: 4 },
            )
            .is_none());
    }
}

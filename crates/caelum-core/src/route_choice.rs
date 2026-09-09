//! Same-time demand batch route choice.
//!
//! One [`DemandBatchPlanner`] serves one spawn batch: batch-invariant transit
//! shapes and car access lookups are hoisted out of the per-demand path, while
//! [`DemandBatchPlanner::choose`] preserves the exact sequential-congestion
//! semantics of per-demand one-shot planning — it scores against the caller's
//! current [`traffic::RoadFlow`] without mutating it. After the caller
//! registers a chosen car into the flow it must call
//! [`DemandBatchPlanner::note_road_flow_changed`] so the next `choose`
//! re-scores Bus ride durations against the changed flow.

use crate::model::{GameSnapshot, Point, PrivateCarTrip, RoutePlan};
use crate::road_topology::RoadTopology;
use crate::{router, traffic};

/// Final structural counts of one finished demand batch. Evidence tooling for
/// the release scale harness — not part of the gameplay contract.
#[doc(hidden)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RouteChoiceBatchStats {
    pub transit_service_count: usize,
    pub transit_shape_count: usize,
    pub transit_flow_refreshes: usize,
    pub car_prepared_access_paths: usize,
}

/// One demand's mode decision. `Unserved` means neither mode could serve the
/// OD; spawn leaves the fresh trip Idle + planless and lets `tick_trip` own
/// the eventual Unserved marking.
pub(crate) enum RouteChoice {
    PrivateCar(PrivateCarTrip),
    NonCar(RoutePlan),
    Unserved,
}

/// Batch-owned planner for one same-time spawn batch.
pub(crate) struct DemandBatchPlanner {
    non_car: router::RoutePlanner,
    private_car: traffic::PrivateCarPlanner,
    flow_generation: u64,
}

impl DemandBatchPlanner {
    pub(crate) fn new(state: &GameSnapshot) -> Self {
        Self {
            non_car: router::RoutePlanner::new(state),
            private_car: traffic::PrivateCarPlanner::new(state),
            flow_generation: 0,
        }
    }

    /// Score one demand's mode against the current `road_flow` without
    /// mutating it: the non-car plan reuses cached ride durations while
    /// `flow_generation` is unchanged, the car candidate is scored live, and
    /// strict `<` keeps equal-ETA ties with the non-car plan.
    pub(crate) fn choose(
        &mut self,
        state: &GameSnapshot,
        road_topology: &RoadTopology,
        road_flow: &traffic::RoadFlow,
        origin: Point,
        destination: Point,
    ) -> RouteChoice {
        let non_car_plan =
            self.non_car
                .find_route_plan(road_flow, self.flow_generation, origin, destination);
        let car = self
            .private_car
            .candidate(state, road_topology, road_flow, origin, destination);
        match private_car_trip_if_faster(non_car_plan.as_ref(), car, state.time) {
            Some(trip) => RouteChoice::PrivateCar(trip),
            None => match non_car_plan {
                Some(plan) => RouteChoice::NonCar(plan),
                None => RouteChoice::Unserved,
            },
        }
    }

    /// The caller registered a chosen car path into the scored flow; bump the
    /// local generation so the next `choose` refreshes Bus ride durations.
    pub(crate) fn note_road_flow_changed(&mut self) {
        self.flow_generation = self.flow_generation.saturating_add(1);
    }

    /// Final structural counts of the finished batch: transit service/shape
    /// cardinality and flow refreshes from the router, prepared car access
    /// paths from the traffic planner.
    pub(crate) fn stats(&self) -> RouteChoiceBatchStats {
        RouteChoiceBatchStats {
            transit_service_count: self.non_car.service_count(),
            transit_shape_count: self.non_car.shape_count(),
            transit_flow_refreshes: self.non_car.flow_refresh_count(),
            car_prepared_access_paths: self.private_car.prepared_access_path_count(),
        }
    }
}

fn private_car_trip_if_faster(
    non_car_plan: Option<&RoutePlan>,
    car: Option<traffic::PrivateCarCandidate>,
    current_time: f64,
) -> Option<PrivateCarTrip> {
    let car = car.filter(|car| {
        non_car_plan.is_none_or(|plan| car.estimated_seconds < plan.estimated_seconds)
    })?;
    Some(PrivateCarTrip {
        path: car.path,
        arrival_time: current_time + car.estimated_seconds,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::GameEngine;
    use crate::intent::GameIntent;
    use crate::model::{PlacedBuilding, ServicePattern, TransitMode, TransitPath};
    use crate::road_topology::RoadTopology;
    use crate::SandboxCreationRequest;

    fn commute_building(id: &str, point: Point) -> PlacedBuilding {
        PlacedBuilding {
            id: id.to_string(),
            building_type: "smallHouse".to_string(),
            origin: point,
            rotation: 0,
            occupied_tiles: vec![point],
            placed_at: 0.0,
            transit_node_id: None,
        }
    }

    /// Direct Bus/car corridor: two-way road at y=5, home/work buildings on
    /// y=4, and a 2-stop Loop bus route whose ride shares that road.
    fn batch_fixture() -> (GameSnapshot, RoadTopology) {
        let mut engine = GameEngine::from_sandbox_request(SandboxCreationRequest {
            template_id: "blankGrid".to_string(),
            economy_preset: "standard".to_string(),
            starting_capital: Some(120_000.0),
            demand_multiplier: Some(1.0),
        })
        .expect("blank-grid fixture should construct");
        for x in 1..=13 {
            let result = engine.dispatch(GameIntent::LayRoad {
                point: (x, 5).into(),
            });
            assert!(result.applied, "fixture road should apply: {result:?}");
        }
        for point in [Point { x: 3, y: 4 }, Point { x: 11, y: 4 }] {
            let result = engine.dispatch(GameIntent::AddBusStop { point });
            assert!(result.applied, "fixture stop should apply: {result:?}");
        }
        let created = engine.dispatch(GameIntent::CreateRoute {
            mode: TransitMode::Bus,
            pattern: ServicePattern::Loop,
            waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
        });
        assert!(created.applied, "fixture route should apply: {created:?}");
        let assigned = engine.dispatch(GameIntent::AssignVehicle {
            mode: "bus".to_string(),
            line_id: "route-001".to_string(),
        });
        assert!(
            assigned.applied,
            "fixture vehicle should apply: {assigned:?}"
        );
        let mut state = engine.snapshot();
        state.buildings = vec![
            commute_building("home", Point { x: 1, y: 4 }),
            commute_building("work", Point { x: 13, y: 4 }),
        ];
        let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
        (state, topology)
    }

    #[test]
    fn equal_private_car_eta_keeps_the_non_car_plan() {
        let non_car_plan = RoutePlan {
            legs: Vec::new(),
            estimated_seconds: 10.0,
        };
        let car = crate::traffic::PrivateCarCandidate {
            path: TransitPath::Road {
                steps: Vec::new(),
                total_travel_seconds: 10.0,
            },
            estimated_seconds: 10.0,
        };

        assert!(private_car_trip_if_faster(Some(&non_car_plan), Some(car), 100.0).is_none());
    }

    #[test]
    fn strict_car_choice_switches_when_non_car_eta_becomes_slower() {
        let free_flow_non_car_plan = RoutePlan {
            legs: Vec::new(),
            estimated_seconds: 100.0,
        };
        let congested_non_car_plan = RoutePlan {
            legs: Vec::new(),
            estimated_seconds: 110.0,
        };
        let car = crate::traffic::PrivateCarCandidate {
            path: TransitPath::Road {
                steps: Vec::new(),
                total_travel_seconds: 0.0,
            },
            estimated_seconds: 105.0,
        };

        assert!(private_car_trip_if_faster(
            Some(&free_flow_non_car_plan),
            Some(car.clone()),
            100.0
        )
        .is_none());
        assert!(
            private_car_trip_if_faster(Some(&congested_non_car_plan), Some(car), 100.0).is_some()
        );
    }

    #[test]
    fn choose_does_not_mutate_road_flow() {
        let (state, topology) = batch_fixture();
        let mut planner = DemandBatchPlanner::new(&state);
        let flow = traffic::RoadFlow::new();
        let before = flow.clone();

        let choice = planner.choose(
            &state,
            &topology,
            &flow,
            Point { x: 1, y: 4 },
            Point { x: 13, y: 4 },
        );

        assert!(
            matches!(choice, RouteChoice::PrivateCar(_)),
            "fixture OD is car-winning at free flow"
        );
        assert_eq!(
            flow, before,
            "choose() must score without mutating the flow"
        );
    }

    #[test]
    fn same_flow_generation_reuses_cached_ride_durations_across_chooses() {
        let (state, topology) = batch_fixture();
        let mut planner = DemandBatchPlanner::new(&state);
        let flow = traffic::RoadFlow::new();
        let origin = Point { x: 4, y: 4 };
        let destination = Point { x: 12, y: 4 };

        planner.choose(&state, &topology, &flow, origin, destination);
        assert_eq!(planner.non_car.flow_refresh_count(), 1);

        planner.choose(&state, &topology, &flow, origin, destination);
        assert_eq!(
            planner.non_car.flow_refresh_count(),
            1,
            "unchanged flow generation must reuse cached ride durations"
        );
    }

    #[test]
    fn note_road_flow_changed_refreshes_bus_duration_on_next_choose() {
        let (state, topology) = batch_fixture();
        let mut planner = DemandBatchPlanner::new(&state);
        let light_flow = traffic::RoadFlow::new();
        let origin = Point { x: 4, y: 4 };
        let destination = Point { x: 12, y: 4 };

        let light = planner.choose(&state, &topology, &light_flow, origin, destination);
        let RouteChoice::NonCar(light_plan) = light else {
            panic!("light-flow fixture plan should stay non-car");
        };

        // Congest the shared bus/car road tiles so Bus ride durations must be
        // re-scored against the changed flow.
        let mut congested_flow = traffic::RoadFlow::new();
        for x in 3..=11 {
            congested_flow.insert(Point { x, y: 5 }, 12);
        }
        planner.note_road_flow_changed();
        let congested = planner.choose(&state, &topology, &congested_flow, origin, destination);
        let RouteChoice::NonCar(congested_plan) = congested else {
            panic!("congested fixture plan should stay non-car");
        };

        assert_eq!(
            planner.non_car.flow_refresh_count(),
            2,
            "note_road_flow_changed must force exactly one refresh"
        );
        assert!(
            congested_plan.estimated_seconds > light_plan.estimated_seconds,
            "refreshed scoring must move the Bus ETA against the changed flow"
        );
    }
}

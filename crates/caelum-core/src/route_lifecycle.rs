use std::cmp::Ordering;
use std::collections::HashMap;
use std::f64::consts::TAU;

use crate::engine::RoutingContext;
use crate::model::{
    GameSnapshot, Heading, PathGeometry, Platform, Point, RouteLegPath, RouteLegStatus,
    TransitMode, TransitPath, TransitPathStepRef, TripPosition, Vehicle,
};
use crate::network::resolve_route_legs;
use crate::transit::park_vehicles_and_invalidate_trips;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PathProjection {
    pub path_step_index: usize,
    pub step_progress: f64,
    pub distance_squared: f64,
}

pub fn recompute_affected_routes(
    previous: &GameSnapshot,
    mut candidate: GameSnapshot,
    context: RoutingContext<'_>,
) -> GameSnapshot {
    recompute_bus_routes(previous, &mut candidate, context);
    recompute_metro_lines(previous, &mut candidate, context);
    candidate
}

fn recompute_bus_routes(
    previous: &GameSnapshot,
    candidate: &mut GameSnapshot,
    context: RoutingContext<'_>,
) {
    let position_by_id: HashMap<String, Point> = candidate
        .transit
        .stops
        .iter()
        .map(|stop| (stop.id.clone(), stop.position))
        .collect();

    for route_index in 0..candidate.transit.routes.len() {
        let route = candidate.transit.routes[route_index].clone();
        let previous_route = previous
            .transit
            .routes
            .iter()
            .find(|previous_route| previous_route.id == route.id);
        let resolved = resolve_route_legs(
            candidate,
            context,
            TransitMode::Bus,
            &route.stop_ids,
            route.pattern,
        );
        let legs = merge_resolved_legs(previous_route.map(|route| route.legs.as_slice()), resolved);
        let path_broken = legs
            .iter()
            .any(|leg| leg.status != RouteLegStatus::Connected);

        if let Some(previous_route) = previous_route {
            if !path_broken {
                project_line_vehicles(candidate, &route.id, &previous_route.legs, &legs);
            }
            if route_structure_changed(
                previous_route.stop_ids.as_slice(),
                route.stop_ids.as_slice(),
                previous_route.pattern,
                route.pattern,
                &previous_route.legs,
                &legs,
                platform_assignments(&previous.transit.stops, &route.id),
                platform_assignments(&candidate.transit.stops, &route.id),
            ) {
                candidate.transit.routes[route_index].revision =
                    previous_route.revision.saturating_add(1);
            }
        }

        if path_broken && !route.path_broken {
            park_vehicles_and_invalidate_trips(candidate, &route.id, &legs, &position_by_id);
        }
        candidate.transit.routes[route_index].legs = legs;
        candidate.transit.routes[route_index].path_broken = path_broken;
    }
}

fn recompute_metro_lines(
    previous: &GameSnapshot,
    candidate: &mut GameSnapshot,
    context: RoutingContext<'_>,
) {
    let position_by_id: HashMap<String, Point> = candidate
        .transit
        .stations
        .iter()
        .map(|station| (station.id.clone(), station.position))
        .collect();

    for line_index in 0..candidate.transit.metro_lines.len() {
        let line = candidate.transit.metro_lines[line_index].clone();
        let previous_line = previous
            .transit
            .metro_lines
            .iter()
            .find(|previous_line| previous_line.id == line.id);
        let resolved = resolve_route_legs(
            candidate,
            context,
            TransitMode::Metro,
            &line.station_ids,
            line.pattern,
        );
        let legs = merge_resolved_legs(previous_line.map(|line| line.legs.as_slice()), resolved);
        let path_broken = legs
            .iter()
            .any(|leg| leg.status != RouteLegStatus::Connected);

        if let Some(previous_line) = previous_line {
            if !path_broken {
                project_line_vehicles(candidate, &line.id, &previous_line.legs, &legs);
            }
            if route_structure_changed(
                previous_line.station_ids.as_slice(),
                line.station_ids.as_slice(),
                previous_line.pattern,
                line.pattern,
                &previous_line.legs,
                &legs,
                platform_assignments(&previous.transit.stations, &line.id),
                platform_assignments(&candidate.transit.stations, &line.id),
            ) {
                candidate.transit.metro_lines[line_index].revision =
                    previous_line.revision.saturating_add(1);
            }
        }

        if path_broken && !line.path_broken {
            park_vehicles_and_invalidate_trips(candidate, &line.id, &legs, &position_by_id);
        }
        candidate.transit.metro_lines[line_index].legs = legs;
        candidate.transit.metro_lines[line_index].path_broken = path_broken;
    }
}

trait PlatformNode {
    fn id(&self) -> &str;
    fn platforms(&self) -> &[Platform];
}

impl PlatformNode for crate::model::Stop {
    fn id(&self) -> &str {
        &self.id
    }

    fn platforms(&self) -> &[Platform] {
        &self.platforms
    }
}

impl PlatformNode for crate::model::Station {
    fn id(&self) -> &str {
        &self.id
    }

    fn platforms(&self) -> &[Platform] {
        &self.platforms
    }
}

fn platform_assignments<T: PlatformNode>(nodes: &[T], line_id: &str) -> Vec<(String, String)> {
    nodes
        .iter()
        .flat_map(|node| {
            node.platforms()
                .iter()
                .filter(|platform| platform.route_ids.iter().any(|id| id == line_id))
                .map(|platform| (node.id().to_string(), platform.id.clone()))
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn route_structure_changed<T: PartialEq>(
    previous_waypoint_ids: &[String],
    candidate_waypoint_ids: &[String],
    previous_pattern: T,
    candidate_pattern: T,
    previous_legs: &[RouteLegPath],
    candidate_legs: &[RouteLegPath],
    previous_platforms: Vec<(String, String)>,
    candidate_platforms: Vec<(String, String)>,
) -> bool {
    previous_waypoint_ids != candidate_waypoint_ids
        || previous_pattern != candidate_pattern
        || previous_legs != candidate_legs
        || previous_platforms != candidate_platforms
}

fn merge_resolved_legs(
    previous: Option<&[RouteLegPath]>,
    resolved: Vec<RouteLegPath>,
) -> Vec<RouteLegPath> {
    resolved
        .into_iter()
        .map(|leg| {
            let old = previous
                .and_then(|old_legs| old_legs.iter().find(|old_leg| old_leg.key() == leg.key()));
            merge_resolved_leg(old, leg)
        })
        .collect()
}

fn merge_resolved_leg(old: Option<&RouteLegPath>, mut resolved: RouteLegPath) -> RouteLegPath {
    match resolved.status {
        RouteLegStatus::Connected => {
            resolved.last_valid_path = resolved.current_path.clone();
        }
        RouteLegStatus::NetworkDisconnected | RouteLegStatus::MissingNode => {
            resolved.current_path = None;
            resolved.last_valid_path = old.and_then(|leg| leg.last_valid_path.clone());
        }
    }
    resolved
}

fn project_line_vehicles(
    candidate: &mut GameSnapshot,
    line_id: &str,
    previous_legs: &[RouteLegPath],
    candidate_legs: &[RouteLegPath],
) {
    if previous_legs.is_empty() || candidate_legs.is_empty() {
        return;
    }

    for vehicle in &mut candidate.transit.vehicles {
        if vehicle.line_id != line_id {
            continue;
        }
        let previous_index = vehicle.itinerary_index % previous_legs.len();
        let candidate_index = vehicle.itinerary_index % candidate_legs.len();
        let previous_leg = &previous_legs[previous_index];
        let candidate_leg = &candidate_legs[candidate_index];
        if previous_leg.key() != candidate_leg.key() {
            continue;
        }
        let (Some(previous_path), Some(candidate_path)) = (
            previous_leg.current_path.as_ref(),
            candidate_leg.current_path.as_ref(),
        ) else {
            continue;
        };
        if previous_path == candidate_path || candidate_path.step_count() == 0 {
            continue;
        }
        let Some((world, heading)) = vehicle_world_sample(previous_path, vehicle) else {
            continue;
        };
        let projection = project_position_onto_path(candidate_path, world, heading);
        vehicle.path_step_index = projection.path_step_index;
        vehicle.step_progress = projection.step_progress;
    }
}

fn vehicle_world_sample(path: &TransitPath, vehicle: &Vehicle) -> Option<(TripPosition, Heading)> {
    let step = path.step(vehicle.path_step_index)?;
    let progress = vehicle.step_progress.clamp(0.0, 1.0);
    let (world, tangent) = point_and_tangent_at(step_geometry(&step), progress);
    let heading = heading_from_tangent(&tangent).unwrap_or_else(|| step_heading(&step, progress));
    Some((world, heading))
}

fn step_geometry<'a>(step: &'a TransitPathStepRef<'a>) -> &'a PathGeometry {
    match step {
        TransitPathStepRef::Road(step) => &step.geometry,
        TransitPathStepRef::Track(step) => &step.geometry,
    }
}

fn step_heading(step: &TransitPathStepRef<'_>, progress: f64) -> Heading {
    match step {
        TransitPathStepRef::Road(step) if progress < 0.5 => step.entering_heading,
        TransitPathStepRef::Road(step) => step.leaving_heading,
        TransitPathStepRef::Track(step) => step.heading,
    }
}

fn heading_from_tangent(tangent: &TripPosition) -> Option<Heading> {
    if tangent.x.abs() <= f64::EPSILON && tangent.y.abs() <= f64::EPSILON {
        return None;
    }
    if tangent.x.abs() >= tangent.y.abs() {
        Some(if tangent.x >= 0.0 {
            Heading::East
        } else {
            Heading::West
        })
    } else {
        Some(if tangent.y >= 0.0 {
            Heading::South
        } else {
            Heading::North
        })
    }
}

pub fn project_position_onto_path(
    path: &TransitPath,
    world: TripPosition,
    preferred_heading: Heading,
) -> PathProjection {
    let compatible: Vec<_> = path
        .step_refs()
        .into_iter()
        .enumerate()
        .filter(|(_, step)| step.accepts_heading(preferred_heading))
        .collect();
    let candidates = if compatible.is_empty() {
        path.step_refs().into_iter().enumerate().collect()
    } else {
        compatible
    };
    candidates
        .into_iter()
        .map(|(index, step)| project_onto_step(index, &step, &world))
        .min_by(compare_projection)
        .expect("connected path has at least one step")
}

fn project_onto_step(
    path_step_index: usize,
    step: &TransitPathStepRef<'_>,
    world: &TripPosition,
) -> PathProjection {
    match step_geometry(step) {
        PathGeometry::Line { from, to } => {
            let delta_x = to.x - from.x;
            let delta_y = to.y - from.y;
            let length_squared = delta_x * delta_x + delta_y * delta_y;
            let step_progress = if length_squared <= f64::EPSILON {
                0.0
            } else {
                (((world.x - from.x) * delta_x + (world.y - from.y) * delta_y) / length_squared)
                    .clamp(0.0, 1.0)
            };
            projection_at(path_step_index, step_geometry(step), step_progress, world)
        }
        PathGeometry::Arc {
            center,
            start_radians,
            sweep_radians,
            ..
        } => {
            let mut candidates = vec![0.0, 1.0];
            if sweep_radians.abs() > f64::EPSILON {
                let world_radians = (world.y - center.y).atan2(world.x - center.x);
                let turns_from_start = (start_radians - world_radians) / TAU;
                let turn = if *sweep_radians > 0.0 {
                    turns_from_start.ceil()
                } else {
                    turns_from_start.floor()
                };
                let unwrapped_world_radians = world_radians + turn * TAU;
                let step_progress = (unwrapped_world_radians - start_radians) / sweep_radians;
                if (0.0..=1.0).contains(&step_progress) {
                    candidates.push(step_progress);
                }
            }
            candidates
                .into_iter()
                .map(|step_progress| {
                    projection_at(path_step_index, step_geometry(step), step_progress, world)
                })
                .min_by(compare_projection)
                .expect("arc endpoints always provide projection candidates")
        }
        PathGeometry::QuadraticBezier { .. } => {
            project_onto_quadratic(path_step_index, step_geometry(step), world)
        }
    }
}

fn project_onto_quadratic(
    path_step_index: usize,
    geometry: &PathGeometry,
    world: &TripPosition,
) -> PathProjection {
    const SAMPLE_COUNT: usize = 64;
    const REFINEMENT_ITERATIONS: usize = 8;
    let denominator = (SAMPLE_COUNT - 1) as f64;
    let best_sample = (0..SAMPLE_COUNT)
        .map(|sample_index| {
            projection_at(
                path_step_index,
                geometry,
                sample_index as f64 / denominator,
                world,
            )
        })
        .min_by(compare_projection)
        .expect("quadratic sampling always has candidates");
    let sample_index = (best_sample.step_progress * denominator).round() as usize;
    let mut lower = sample_index.saturating_sub(1) as f64 / denominator;
    let mut upper = (sample_index + 1).min(SAMPLE_COUNT - 1) as f64 / denominator;

    for _ in 0..REFINEMENT_ITERATIONS {
        let first = lower + (upper - lower) / 3.0;
        let second = upper - (upper - lower) / 3.0;
        let first_projection = projection_at(path_step_index, geometry, first, world);
        let second_projection = projection_at(path_step_index, geometry, second, world);
        if compare_projection(&first_projection, &second_projection) != Ordering::Greater {
            upper = second;
        } else {
            lower = first;
        }
    }

    let refined = projection_at(path_step_index, geometry, (lower + upper) / 2.0, world);
    [best_sample, refined]
        .into_iter()
        .min_by(compare_projection)
        .expect("sample and refinement always provide candidates")
}

fn projection_at(
    path_step_index: usize,
    geometry: &PathGeometry,
    step_progress: f64,
    world: &TripPosition,
) -> PathProjection {
    let (point, _) = point_and_tangent_at(geometry, step_progress);
    let delta_x = point.x - world.x;
    let delta_y = point.y - world.y;
    PathProjection {
        path_step_index,
        step_progress,
        distance_squared: delta_x * delta_x + delta_y * delta_y,
    }
}

fn point_and_tangent_at(
    geometry: &PathGeometry,
    step_progress: f64,
) -> (TripPosition, TripPosition) {
    match geometry {
        PathGeometry::Line { from, to } => (
            TripPosition {
                x: from.x + (to.x - from.x) * step_progress,
                y: from.y + (to.y - from.y) * step_progress,
            },
            TripPosition {
                x: to.x - from.x,
                y: to.y - from.y,
            },
        ),
        PathGeometry::QuadraticBezier { from, control, to } => {
            let inverse = 1.0 - step_progress;
            (
                TripPosition {
                    x: inverse * inverse * from.x
                        + 2.0 * inverse * step_progress * control.x
                        + step_progress * step_progress * to.x,
                    y: inverse * inverse * from.y
                        + 2.0 * inverse * step_progress * control.y
                        + step_progress * step_progress * to.y,
                },
                TripPosition {
                    x: 2.0 * (inverse * (control.x - from.x) + step_progress * (to.x - control.x)),
                    y: 2.0 * (inverse * (control.y - from.y) + step_progress * (to.y - control.y)),
                },
            )
        }
        PathGeometry::Arc {
            center,
            radius,
            start_radians,
            sweep_radians,
        } => {
            let radians = start_radians + sweep_radians * step_progress;
            (
                TripPosition {
                    x: center.x + radius * radians.cos(),
                    y: center.y + radius * radians.sin(),
                },
                TripPosition {
                    x: -radius * sweep_radians * radians.sin(),
                    y: radius * sweep_radians * radians.cos(),
                },
            )
        }
    }
}

fn compare_projection(left: &PathProjection, right: &PathProjection) -> Ordering {
    left.distance_squared
        .total_cmp(&right.distance_squared)
        .then_with(|| left.path_step_index.cmp(&right.path_step_index))
        .then_with(|| left.step_progress.total_cmp(&right.step_progress))
}

pub fn structurally_changed_route_ids(
    previous: &GameSnapshot,
    candidate: &GameSnapshot,
) -> Vec<String> {
    let mut affected = Vec::new();

    for route in &previous.transit.routes {
        if candidate
            .transit
            .routes
            .iter()
            .find(|candidate| candidate.id == route.id)
            != Some(route)
        {
            affected.push(route.id.clone());
        }
    }
    for route in &candidate.transit.routes {
        if !previous
            .transit
            .routes
            .iter()
            .any(|previous| previous.id == route.id)
        {
            affected.push(route.id.clone());
        }
    }

    for line in &previous.transit.metro_lines {
        if candidate
            .transit
            .metro_lines
            .iter()
            .find(|candidate| candidate.id == line.id)
            != Some(line)
        {
            affected.push(line.id.clone());
        }
    }
    for line in &candidate.transit.metro_lines {
        if !previous
            .transit
            .metro_lines
            .iter()
            .any(|previous| previous.id == line.id)
        {
            affected.push(line.id.clone());
        }
    }

    affected.sort();
    affected.dedup();
    affected
}

//! Service-driven city growth. In a Sandbox, zoned land near running transit
//! develops buildings on its own every [`GROWTH_INTERVAL_SECONDS`].
//!
//! Each served node (a present stop, terminal, or station on a line that is
//! operational and has a vehicle) develops at most one building per pass whose
//! footprint touches the node's coverage square. A house grows while total job
//! capacity covers total housing capacity; otherwise a workplace grows. Growth
//! is the world building, not the player spending, so placement is free.

use std::collections::HashSet;

use bevy_ecs::prelude::World;

use crate::building_catalog::building_definition;
use crate::buildings;
use crate::clock::GAME_DAY_SECONDS;
use crate::model::{GameMode, GameSnapshot, Point};
use crate::population;
use crate::router;
use crate::transit::stop_coverage_radius;
use crate::transit_nodes::is_present_node;
use crate::trips::EPSILON;

/// Six game hours: the city grows at 00:00, 06:00, 12:00 and 18:00.
pub const GROWTH_INTERVAL_SECONDS: f64 = GAME_DAY_SECONDS / 4.0;

/// Metro stations cover the same square the Coverage overlay draws.
const METRO_STATION_COVERAGE_RADIUS: i32 = 4;

/// Zone and the building it grows, for homes and for workplaces.
const HOMES: &[(&str, &str)] = &[("residential", "smallHouse")];
const WORKPLACES: &[(&str, &str)] = &[
    ("commercial", "supermarket"),
    ("office", "officeTower"),
    ("industrial", "factory"),
];

/// Growth passes run at whole multiples of the interval. The epsilon keeps a
/// substep that ends a rounding error short of the boundary on its far side,
/// so coarse and fine ticks credit the same pass.
fn growth_index(time: f64) -> f64 {
    ((time + EPSILON) / GROWTH_INTERVAL_SECONDS).floor()
}

/// The next growth time strictly after `time`; a tick boundary.
pub(crate) fn next_growth_time(time: f64) -> f64 {
    (growth_index(time) + 1.0) * GROWTH_INTERVAL_SECONDS
}

/// The growth time a substep from `previous` to `now` crossed, if any.
pub(crate) fn crossed_growth_time(previous: f64, now: f64) -> Option<f64> {
    let index = growth_index(now);
    (index > growth_index(previous)).then_some(index * GROWTH_INTERVAL_SECONDS)
}

struct ServedNode {
    position: Point,
    radius: i32,
}

/// Candidate site ordering: nearest to the node, rotation 0 first, then
/// top-to-bottom, left-to-right, then zone order.
#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct Site {
    distance: i32,
    rotation: u16,
    y: i32,
    x: i32,
    kind: usize,
}

/// Run one growth pass at `at_time` and reconcile the ECS population with the
/// grown buildings. Returns whether population state changed.
pub(crate) fn grow_city(state: &mut GameSnapshot, world: &mut World, at_time: f64) -> bool {
    if state.rules.game_mode != GameMode::Sandbox {
        return false;
    }
    let nodes = served_nodes(state);
    if nodes.is_empty() {
        return false;
    }

    let before = state.clone();
    let (mut homes, mut jobs) = capacities(state);
    let mut occupied = occupied_tiles(state);
    let mut grew = false;
    for node in &nodes {
        let kinds = if jobs >= homes { HOMES } else { WORKPLACES };
        let mut sites = candidate_sites(state, &occupied, node, kinds);
        sites.sort();
        for site in sites {
            let building_type = kinds[site.kind].1;
            let origin = Point {
                x: site.x,
                y: site.y,
            };
            let Ok(mut next) =
                buildings::place_building_core(state, building_type, &origin, site.rotation)
            else {
                continue;
            };
            let Some(building) = next.buildings.last_mut() else {
                continue;
            };
            building.placed_at = at_time;
            occupied.extend(building.occupied_tiles.iter().copied());
            if let Some(definition) = building_definition(building_type) {
                homes += u32::from(definition.resident_capacity);
                jobs += u32::from(definition.job_capacity);
            }
            *state = next;
            grew = true;
            break;
        }
    }

    grew && population::reconcile_buildings(world, &before, state).changed
}

/// Present nodes that passengers can plan on, stops before stations, each in
/// build order.
fn served_nodes(state: &GameSnapshot) -> Vec<ServedNode> {
    let services = router::active_services(state);
    let served: HashSet<&str> = services
        .iter()
        .flat_map(router::TransitService::node_ids)
        .collect();

    let stops = state
        .transit
        .stops
        .iter()
        .filter(|stop| is_present_node(stop.status) && served.contains(stop.id.as_str()))
        .map(|stop| ServedNode {
            position: stop.position,
            radius: i32::from(stop_coverage_radius(stop.kind)),
        });
    let stations = state
        .transit
        .stations
        .iter()
        .filter(|station| is_present_node(station.status) && served.contains(station.id.as_str()))
        .map(|station| ServedNode {
            position: station.position,
            radius: METRO_STATION_COVERAGE_RADIUS,
        });
    stops.chain(stations).collect()
}

fn capacities(state: &GameSnapshot) -> (u32, u32) {
    state
        .buildings
        .iter()
        .filter_map(|building| building_definition(&building.building_type))
        .fold((0, 0), |(homes, jobs), definition| {
            (
                homes + u32::from(definition.resident_capacity),
                jobs + u32::from(definition.job_capacity),
            )
        })
}

fn occupied_tiles(state: &GameSnapshot) -> HashSet<Point> {
    let buildings = state
        .buildings
        .iter()
        .flat_map(|building| building.occupied_tiles.iter().copied());
    let stops = state
        .transit
        .stops
        .iter()
        .filter(|stop| is_present_node(stop.status))
        .map(|stop| stop.position);
    let stations = state
        .transit
        .stations
        .iter()
        .filter(|station| is_present_node(station.status))
        .map(|station| station.position);
    buildings.chain(stops).chain(stations).collect()
}

/// Footprints touching the node's coverage square on empty land zoned for the
/// building. A cheap pre-filter: `place_building_core` stays the authority.
fn candidate_sites(
    state: &GameSnapshot,
    occupied: &HashSet<Point>,
    node: &ServedNode,
    kinds: &[(&str, &str)],
) -> Vec<Site> {
    let mut sites = Vec::new();
    for (kind, (area, building_type)) in kinds.iter().enumerate() {
        let Some(definition) = building_definition(building_type) else {
            continue;
        };
        for rotation in [0, 90] {
            let (width, height) = if rotation == 90 {
                (definition.height, definition.width)
            } else {
                (definition.width, definition.height)
            };
            let Point { x: nx, y: ny } = node.position;
            for y in (ny - node.radius - (height - 1))..=(ny + node.radius) {
                for x in (nx - node.radius - (width - 1))..=(nx + node.radius) {
                    let dx = (x - nx).max(nx - (x + width - 1)).max(0);
                    let dy = (y - ny).max(ny - (y + height - 1)).max(0);
                    let distance = dx.max(dy);
                    if distance > node.radius {
                        continue;
                    }
                    let fits = (y..y + height).all(|ty| {
                        (x..x + width).all(|tx| {
                            let point = Point { x: tx, y: ty };
                            !occupied.contains(&point)
                                && state.map.tile(point).is_some_and(|tile| {
                                    tile.kind == "empty"
                                        && !tile.has_track
                                        && tile.road_structure_id.is_none()
                                        && tile.area.as_deref() == Some(*area)
                                })
                        })
                    });
                    if fits {
                        sites.push(Site {
                            distance,
                            rotation,
                            y,
                            x,
                            kind,
                        });
                    }
                }
            }
        }
    }
    sites
}

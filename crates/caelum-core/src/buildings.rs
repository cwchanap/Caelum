use crate::building_catalog::{building_definition, BuildingDefinition};
use crate::cost_policy::{CostPolicy, CostedMutation};
use crate::ids::next_entity_id;
use crate::model::{
    BusStopKind, GameSnapshot, PlacedBuilding, Point, Station, Stop, TransitNodeStatus,
    WorkerProfile,
};
use crate::platforms::{bus_platforms, metro_platforms};
use crate::rejection::{GameplayRejection, GameplayResult, RejectionCode, RejectionContext};
use crate::stop_access::derive_stop_access_for_footprint;
use crate::transit_nodes::{
    is_present_node, matching_present_node_id, restore_or_create_node, LogicalNodeKind,
};

fn placement_rejection(
    code: RejectionCode,
    point: Point,
    footprint: &[Point],
) -> GameplayRejection {
    GameplayRejection {
        code,
        context: RejectionContext {
            point: Some(point),
            footprint: footprint.to_vec(),
            ..RejectionContext::default()
        },
    }
}

// Compute the occupied tiles for a building of `definition` placed at `origin`
// with `rotation`. Returns `None` when the footprint cannot be constructed
// safely: non-positive dimensions or `origin + extent` overflow. `PlaceBuilding`
// intents are deserialized from the host/JS boundary, so `origin` can carry
// i32::MAX; without checked arithmetic `origin.x + width` would panic in debug
// and wrap into an empty/off-map footprint in release. Callers must reject
// `None` before any map validation runs.
pub fn footprint(
    definition: &BuildingDefinition,
    origin: &Point,
    rotation: u16,
) -> Option<Vec<Point>> {
    let (width, height) = if matches!(rotation, 90 | 270) {
        (definition.height, definition.width)
    } else {
        (definition.width, definition.height)
    };

    if width <= 0 || height <= 0 {
        return None;
    }

    let end_x = origin.x.checked_add(width)?;
    let end_y = origin.y.checked_add(height)?;

    let mut points = Vec::new();
    for y in origin.y..end_y {
        for x in origin.x..end_x {
            points.push(Point { x, y });
        }
    }

    Some(points)
}

pub fn workplace_points(state: &GameSnapshot) -> Vec<Point> {
    state
        .buildings
        .iter()
        .filter(|building| {
            building_definition(&building.building_type)
                .is_some_and(|definition| definition.job_capacity > 0)
        })
        .flat_map(|building| building.occupied_tiles.iter().copied())
        .collect()
}

pub fn can_place_building(
    state: &GameSnapshot,
    building_type: &str,
    origin: &Point,
    rotation: u16,
) -> GameplayResult<Vec<Point>> {
    let definition = building_definition(building_type)
        .ok_or_else(|| GameplayRejection::at(RejectionCode::InvalidBuildingPlacement, *origin))?;

    if !matches!(rotation, 0 | 90 | 180 | 270) {
        return Err(GameplayRejection::at(
            RejectionCode::InvalidBuildingPlacement,
            *origin,
        ));
    }

    let occupied_tiles = footprint(definition, origin, rotation)
        .ok_or_else(|| GameplayRejection::at(RejectionCode::InvalidBuildingPlacement, *origin))?;

    for point in &occupied_tiles {
        let Some(tile) = state
            .map
            .tiles
            .iter()
            .find(|tile| tile.x == point.x && tile.y == point.y)
        else {
            return Err(placement_rejection(
                RejectionCode::OutOfBounds,
                *point,
                &occupied_tiles,
            ));
        };

        if tile.road_structure_id.is_some() {
            return Err(placement_rejection(
                RejectionCode::BlockedFootprint,
                *point,
                &occupied_tiles,
            ));
        }

        if building_type == "metroStation" {
            if !matches!(tile.kind.as_str(), "empty" | "road") {
                return Err(placement_rejection(
                    RejectionCode::BlockedFootprint,
                    *point,
                    &occupied_tiles,
                ));
            }
            if !tile.has_track {
                return Err(placement_rejection(
                    RejectionCode::TrackRequired,
                    *point,
                    &occupied_tiles,
                ));
            }
        } else {
            if tile.kind != "empty" {
                return Err(placement_rejection(
                    RejectionCode::BlockedFootprint,
                    *point,
                    &occupied_tiles,
                ));
            }
            if tile.has_track {
                return Err(placement_rejection(
                    RejectionCode::BlockedFootprint,
                    *point,
                    &occupied_tiles,
                ));
            }
        }
        if let Some(allowed_area) = definition.allowed_area {
            if tile.area.as_deref() != Some(allowed_area) {
                return Err(placement_rejection(
                    RejectionCode::InvalidBuildingPlacement,
                    *point,
                    &occupied_tiles,
                ));
            }
        }
        if state
            .buildings
            .iter()
            .any(|building| building.occupied_tiles.iter().any(|tile| tile == point))
        {
            return Err(placement_rejection(
                RejectionCode::BlockedFootprint,
                *point,
                &occupied_tiles,
            ));
        }
        if state
            .transit
            .stops
            .iter()
            .any(|stop| is_present_node(stop.status) && stop.position == *point)
        {
            return Err(placement_rejection(
                RejectionCode::BlockedFootprint,
                *point,
                &occupied_tiles,
            ));
        }
        if state
            .transit
            .stations
            .iter()
            .any(|station| is_present_node(station.status) && station.position == *point)
        {
            return Err(placement_rejection(
                RejectionCode::BlockedFootprint,
                *point,
                &occupied_tiles,
            ));
        }
    }

    if building_type == "busTerminal"
        && derive_stop_access_for_footprint(&state.map, &occupied_tiles).is_none()
    {
        return Err(placement_rejection(
            RejectionCode::NoRoadAccess,
            *origin,
            &occupied_tiles,
        ));
    }

    Ok(occupied_tiles)
}

pub fn place_building(
    state: &GameSnapshot,
    building_type: &str,
    origin: &Point,
    rotation: u16,
) -> GameplayResult<GameSnapshot> {
    place_building_costed(state, building_type, origin, rotation).map(CostedMutation::into_snapshot)
}

pub(crate) fn place_building_costed(
    state: &GameSnapshot,
    building_type: &str,
    origin: &Point,
    rotation: u16,
) -> GameplayResult<CostedMutation> {
    let definition = building_definition(building_type)
        .ok_or_else(|| GameplayRejection::at(RejectionCode::InvalidBuildingPlacement, *origin))?;
    let authorized = CostPolicy::from_snapshot(state)
        .quote(definition.cost, state.budget)
        .authorize()?;
    let mut next = place_building_core(state, building_type, origin, rotation)?;
    authorized.apply_to(&mut next.budget)?;
    Ok(CostedMutation::new(next))
}

pub fn place_building_core(
    state: &GameSnapshot,
    building_type: &str,
    origin: &Point,
    rotation: u16,
) -> GameplayResult<GameSnapshot> {
    let definition = building_definition(building_type)
        .ok_or_else(|| GameplayRejection::at(RejectionCode::InvalidBuildingPlacement, *origin))?;

    let occupied_tiles = can_place_building(state, building_type, origin, rotation)?;
    let mut next = state.clone();
    let building_id = next_entity_id(
        "building",
        next.buildings.iter().map(|building| building.id.clone()),
    );

    let mut transit_node_id = None;

    if matches!(definition.effect, "busStop" | "busTerminal") {
        let kind = if definition.effect == "busTerminal" {
            BusStopKind::BusTerminal
        } else {
            BusStopKind::BusStop
        };
        let logical_kind = if kind == BusStopKind::BusTerminal {
            LogicalNodeKind::BusTerminal
        } else {
            LogicalNodeKind::BusStop
        };
        let stop_id = next_entity_id(
            "stop",
            next.transit.stops.iter().map(|stop| stop.id.clone()),
        );
        let road_access = if kind == BusStopKind::BusTerminal {
            derive_stop_access_for_footprint(&next.map, &occupied_tiles)
        } else {
            None
        };
        next = restore_or_create_node(&next, logical_kind, *origin, |state| {
            let mut allocated = state.clone();
            allocated.transit.stops.push(Stop {
                id: stop_id.clone(),
                kind,
                status: TransitNodeStatus::Present,
                position: *origin,
                platforms: bus_platforms(&stop_id, kind),
                road_access,
            });
            Ok(allocated)
        })?;
        if let Some(access) = road_access {
            let stop_id = matching_present_node_id(&next, logical_kind, *origin);
            if let Some(stop) =
                stop_id.and_then(|id| next.transit.stops.iter_mut().find(|stop| stop.id == id))
            {
                stop.road_access = Some(access);
            }
        }
        transit_node_id = matching_present_node_id(&next, logical_kind, *origin);
    }

    if definition.effect == "metroStation" {
        let station_id = next_entity_id(
            "station",
            next.transit
                .stations
                .iter()
                .map(|station| station.id.clone()),
        );
        next = restore_or_create_node(&next, LogicalNodeKind::MetroStation, *origin, |state| {
            let mut allocated = state.clone();
            allocated.transit.stations.push(Station {
                id: station_id.clone(),
                status: TransitNodeStatus::Present,
                position: *origin,
                platforms: metro_platforms(&station_id),
            });
            Ok(allocated)
        })?;
        transit_node_id = matching_present_node_id(&next, LogicalNodeKind::MetroStation, *origin);
    }

    next.buildings.push(PlacedBuilding {
        id: building_id,
        building_type: building_type.to_string(),
        origin: *origin,
        rotation,
        occupied_tiles: occupied_tiles.clone(),
        placed_at: state.time,
        transit_node_id,
    });

    if definition.resident_capacity > 0 || definition.job_capacity > 0 {
        assign_workplaces(&mut next);
    }

    Ok(next)
}

pub fn assign_workplaces(state: &mut GameSnapshot) {
    let mut workplaces: Vec<(String, Vec<Point>, usize)> = state
        .buildings
        .iter()
        .filter_map(|building| {
            let definition = building_definition(&building.building_type)?;
            (definition.job_capacity > 0).then(|| {
                (
                    building.id.clone(),
                    building.occupied_tiles.clone(),
                    usize::from(definition.job_capacity),
                )
            })
        })
        .collect();
    workplaces.sort_by(|left, right| left.0.cmp(&right.0));

    // First preserve existing assignments while each matching workplace has an
    // unused slot. Anything stale or over capacity is cleared before filling
    // the remaining slots, including when no workplaces exist at all.
    let mut used = vec![0usize; workplaces.len()];
    for sim in &mut state.sims {
        if sim.worker_profile != WorkerProfile::Worker {
            continue;
        }

        let Some(current) = sim.workplace else {
            continue;
        };
        let Some(workplace_index) = workplaces
            .iter()
            .position(|(_, occupied_tiles, _)| occupied_tiles.contains(&current))
        else {
            sim.workplace = None;
            continue;
        };
        if used[workplace_index] < workplaces[workplace_index].2 {
            used[workplace_index] += 1;
        } else {
            sim.workplace = None;
        }
    }

    // Fill open slots in the existing stable sim order. Workplaces are already
    // sorted by ID, and each slot maps deterministically onto its footprint.
    for sim in &mut state.sims {
        if sim.worker_profile != WorkerProfile::Worker || sim.workplace.is_some() {
            continue;
        }

        let Some(workplace_index) = workplaces
            .iter()
            .enumerate()
            .find(|(index, (_, occupied_tiles, capacity))| {
                used[*index] < *capacity && !occupied_tiles.is_empty()
            })
            .map(|(index, _)| index)
        else {
            continue;
        };

        let occupied_tiles = &workplaces[workplace_index].1;
        sim.workplace = Some(occupied_tiles[used[workplace_index] % occupied_tiles.len()]);
        used[workplace_index] += 1;
    }
}

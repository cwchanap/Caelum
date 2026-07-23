use crate::building_catalog::{building_definition, BuildingDefinition};
use crate::commute::{shift_template_for_id, worker_profile_for_id};
use crate::ids::next_entity_id;
use crate::model::{
    BusStopKind, GameSnapshot, PlacedBuilding, Point, Sim, Station, Stop, TransitNodeStatus,
    WorkerProfile,
};
use crate::platforms::{bus_platforms, metro_platforms};
use crate::rejection::{GameplayRejection, GameplayResult, RejectionCode, RejectionContext};
use crate::stop_access::{derive_stop_access_for_footprint, is_valid_access, stop_footprint};
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

pub fn destination_points(state: &GameSnapshot) -> Vec<Point> {
    state
        .buildings
        .iter()
        .filter(|building| {
            building_definition(&building.building_type)
                .is_some_and(|definition| definition.effect == "destination")
        })
        .flat_map(|building| building.occupied_tiles.iter().cloned())
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
    let definition = building_definition(building_type)
        .ok_or_else(|| GameplayRejection::at(RejectionCode::InvalidBuildingPlacement, *origin))?;
    if state.budget < definition.cost {
        return Err(GameplayRejection::budget(definition.cost, state.budget));
    }
    let mut next = place_building_core(state, building_type, origin, rotation)?;
    next.budget -= definition.cost;
    Ok(next)
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
    let mut road_access = None;

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
        road_access = if kind == BusStopKind::BusTerminal {
            Some(
                derive_stop_access_for_footprint(&next.map, &occupied_tiles).ok_or_else(|| {
                    placement_rejection(RejectionCode::NoRoadAccess, *origin, &occupied_tiles)
                })?,
            )
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
            if let Some(stop_id) = matching_present_node_id(&next, logical_kind, *origin) {
                if let Some(stop) = next
                    .transit
                    .stops
                    .iter_mut()
                    .find(|stop| stop.id == stop_id)
                {
                    stop.road_access = Some(access);
                }
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

    let transit_node_id_for_validation = transit_node_id.clone();
    next.buildings.push(PlacedBuilding {
        id: building_id,
        building_type: building_type.to_string(),
        origin: *origin,
        rotation,
        occupied_tiles: occupied_tiles.clone(),
        transit_node_id,
    });

    if let (Some(access), Some(transit_node_id)) = (road_access, transit_node_id_for_validation) {
        if let Some(stop) = next
            .transit
            .stops
            .iter()
            .find(|stop| stop.id == transit_node_id)
        {
            let footprint = stop_footprint(&next, stop);
            if !is_valid_access(&next.map, &footprint, access) {
                return Err(placement_rejection(
                    RejectionCode::NoRoadAccess,
                    *origin,
                    &occupied_tiles,
                ));
            }
        }
    }

    if definition.effect == "housing" {
        for index in 0..usize::from(definition.citizen_count) {
            let sim_id = next_entity_id("sim", next.sims.iter().map(|sim| sim.id.clone()));
            let home = occupied_tiles[index % occupied_tiles.len()];
            let worker_profile = worker_profile_for_id(&sim_id);
            next.sims.push(Sim {
                id: sim_id.clone(),
                home,
                position: home,
                worker_profile,
                shift_template: shift_template_for_id(&sim_id).map(str::to_string),
                workplace: None,
                commute_day: 0,
                outbound_resolved_today: false,
                outbound_arrived_today: false,
                return_resolved_today: false,
                returned_home_today: false,
            });
        }
    }

    if matches!(definition.effect, "housing" | "destination") {
        assign_workplaces(&mut next);
        // `assign_workplaces` may promote a home-fallback worker (workplace ==
        // home) to a real non-home workplace when this placement adds one. The
        // worker's stale dormant outbound trip still targets home, so retarget
        // it onto the new workplace — otherwise `is_home_fallback_trip` keeps
        // it dormant and its id blocks any fresh outbound spawn. Mirrors the TS
        // `retargetCitizens(..., isHomeFallbackCitizen)` flow invoked when a
        // destination is placed (src/simulation/buildings.ts).
        crate::trips::retarget_home_fallback_trips(&mut next);
    }

    Ok(next)
}

pub fn assign_workplaces(state: &mut GameSnapshot) {
    let destinations = destination_points(state);
    if destinations.is_empty() {
        return;
    }

    let mut destination_index = 0;
    for sim in &mut state.sims {
        if sim.worker_profile != WorkerProfile::Worker {
            continue;
        }
        // A workplace equal to home is the documented home-fallback (the only
        // destination at assignment time was the home tile — e.g. housing was
        // bulldozed and the footprint later rezoned as a destination). Revisit
        // it so a later non-home destination can promote the worker out of the
        // dormant fallback; otherwise the worker stays on a zero-distance home
        // workplace forever; its outbound trips are held dormant by
        // `is_home_fallback_trip` and it never commutes even after a real
        // destination is built. Mirrors the TS
        // `retargetCitizens(..., isHomeFallbackCitizen)` flow invoked when a
        // destination is placed (src/simulation/buildings.ts). The companion
        // `crate::trips::retarget_home_fallback_trips` rewrites the stale
        // dormant trip onto the promoted workplace.
        if sim
            .workplace
            .as_ref()
            .is_some_and(|workplace| *workplace != sim.home)
        {
            continue;
        }

        // Avoid assigning a workplace that equals the sim's home when any
        // alternative destination exists. A same-home workplace would produce a
        // zero-distance commute that completes instantly, inflating served
        // metrics (and survival wins) without any actual travel. This arises
        // after housing is bulldozed (sims retain `home` on the now-empty
        // tiles) and the same footprint is later rezoned as a destination,
        // breaking the "housing and destinations cannot overlap" assumption.
        // Mirrors the per-citizen filter in
        // `src/simulation/buildingSelectors.ts` `retargetCitizens`; if every
        // remaining destination equals home (degenerate: the only destination
        // IS home), fall through to the home destination rather than leaving
        // the sim unassigned.
        let eligible: Vec<&Point> = destinations
            .iter()
            .filter(|destination| *destination != &sim.home)
            .collect();
        let workplace = if eligible.is_empty() {
            &destinations[destination_index % destinations.len()]
        } else {
            eligible[destination_index % eligible.len()]
        };
        sim.workplace = Some(*workplace);
        destination_index += 1;
    }
}

use crate::building_catalog::{building_definition, BuildingDefinition};
use crate::commute::{shift_template_for_id, worker_profile_for_id};
use crate::ids::next_entity_id;
use crate::model::{GameSnapshot, PlacedBuilding, Point, Sim, Station, Stop, WorkerProfile};
use crate::platforms::{bus_platforms, metro_platforms};

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
) -> Result<Vec<Point>, String> {
    let definition = building_definition(building_type)
        .ok_or_else(|| format!("unknown building: {building_type}"))?;

    if !matches!(rotation, 0 | 90 | 180 | 270) {
        return Err("invalid rotation".to_string());
    }

    let occupied_tiles =
        footprint(definition, origin, rotation).ok_or_else(|| "invalid footprint".to_string())?;

    for point in &occupied_tiles {
        let Some(tile) = state
            .map
            .tiles
            .iter()
            .find(|tile| tile.x == point.x && tile.y == point.y)
        else {
            return Err("off map".to_string());
        };

        if building_type == "metroStation" {
            if !matches!(tile.kind.as_str(), "empty" | "road") {
                return Err("tile is not empty".to_string());
            }
            if !tile.has_track {
                return Err("track required".to_string());
            }
        } else {
            if tile.kind != "empty" {
                return Err("tile is not empty".to_string());
            }
            if tile.has_track {
                return Err("track occupied".to_string());
            }
        }
        if let Some(allowed_area) = definition.allowed_area {
            if tile.area.as_deref() != Some(allowed_area) {
                return Err("area mismatch".to_string());
            }
        }
        if state
            .buildings
            .iter()
            .any(|building| building.occupied_tiles.iter().any(|tile| tile == point))
        {
            return Err("building occupied".to_string());
        }
        if state
            .transit
            .stops
            .iter()
            .any(|stop| stop.position == *point)
        {
            return Err("stop occupied".to_string());
        }
        if state
            .transit
            .stations
            .iter()
            .any(|station| station.position == *point)
        {
            return Err("station occupied".to_string());
        }
    }

    Ok(occupied_tiles)
}

pub fn place_building(
    state: &GameSnapshot,
    building_type: &str,
    origin: &Point,
    rotation: u16,
) -> Result<GameSnapshot, String> {
    let definition = building_definition(building_type)
        .ok_or_else(|| format!("unknown building: {building_type}"))?;

    if state.budget < definition.cost {
        return Err("insufficient budget".to_string());
    }

    let occupied_tiles = can_place_building(state, building_type, origin, rotation)?;
    let mut next = state.clone();
    let building_id = next_entity_id(
        "building",
        next.buildings.iter().map(|building| building.id.clone()),
    );

    next.budget -= definition.cost;
    let mut transit_node_id = None;

    if matches!(definition.effect, "busStop" | "busTerminal") {
        let stop_id = next_entity_id(
            "stop",
            next.transit.stops.iter().map(|stop| stop.id.clone()),
        );
        next.transit.stops.push(Stop {
            id: stop_id.clone(),
            kind: definition.effect.to_string(),
            position: origin.clone(),
            platforms: bus_platforms(&stop_id, definition.effect),
        });
        transit_node_id = Some(stop_id);
    }

    if definition.effect == "metroStation" {
        let station_id = next_entity_id(
            "station",
            next.transit
                .stations
                .iter()
                .map(|station| station.id.clone()),
        );
        next.transit.stations.push(Station {
            id: station_id.clone(),
            position: origin.clone(),
            platforms: metro_platforms(&station_id),
        });
        transit_node_id = Some(station_id);
    }

    next.buildings.push(PlacedBuilding {
        id: building_id,
        building_type: building_type.to_string(),
        origin: origin.clone(),
        rotation,
        occupied_tiles: occupied_tiles.clone(),
        transit_node_id,
    });

    if definition.effect == "housing" {
        for index in 0..usize::from(definition.citizen_count) {
            let sim_id = next_entity_id("sim", next.sims.iter().map(|sim| sim.id.clone()));
            let home = occupied_tiles[index % occupied_tiles.len()].clone();
            let worker_profile = worker_profile_for_id(&sim_id);
            next.sims.push(Sim {
                id: sim_id.clone(),
                home: home.clone(),
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
        if sim.worker_profile != WorkerProfile::Worker || sim.workplace.is_some() {
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
        sim.workplace = Some(workplace.clone());
        destination_index += 1;
    }
}

use crate::building_catalog::{building_definition, BuildingDefinition};
use crate::commute::{shift_template_for_id, worker_profile_for_id};
use crate::ids::next_entity_id;
use crate::model::{GameSnapshot, PlacedBuilding, Point, Sim, Station, Stop};
use crate::platforms::{bus_platforms, metro_platforms};

pub fn footprint(definition: &BuildingDefinition, origin: &Point, rotation: u16) -> Vec<Point> {
    let (width, height) = if matches!(rotation, 90 | 270) {
        (definition.height, definition.width)
    } else {
        (definition.width, definition.height)
    };

    let mut points = Vec::new();
    for y in origin.y..origin.y + height {
        for x in origin.x..origin.x + width {
            points.push(Point { x, y });
        }
    }

    points
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

    let occupied_tiles = footprint(definition, origin, rotation);

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
            let worker_profile = worker_profile_for_id(&sim_id).to_string();
            next.sims.push(Sim {
                id: sim_id.clone(),
                home: home.clone(),
                position: home,
                worker_profile,
                shift_template: shift_template_for_id(&sim_id).map(str::to_string),
                workplace: None,
                commute_day: 0,
                outbound_arrived_today: false,
                returned_home_today: false,
            });
        }
    }

    assign_workplaces(&mut next);

    Ok(next)
}

pub fn assign_workplaces(state: &mut GameSnapshot) {
    let destinations = destination_points(state);
    if destinations.is_empty() {
        return;
    }

    let mut destination_index = 0;
    for sim in &mut state.sims {
        if sim.worker_profile != "worker" || sim.workplace.is_some() {
            continue;
        }

        sim.workplace = Some(destinations[destination_index % destinations.len()].clone());
        destination_index += 1;
    }
}

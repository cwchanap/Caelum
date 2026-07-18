use std::collections::{BTreeSet, HashSet, VecDeque};

use serde::{Deserialize, Serialize};

use crate::heading::{heading_between, offset, opposite};
use crate::intent::RoadPreset;
use crate::model::{
    GameMap, GameSnapshot, Heading, Point, RoadPort, RoadStructure, RoundaboutSize, Tile,
};
use crate::rejection::{GameplayRejection, GameplayResult, RejectionCode};
use crate::transit::ROAD_COST;
use crate::transit_nodes::is_present_node;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RoadMutation {
    LayRoad {
        point: Point,
    },
    LayRoadLine {
        points: Vec<Point>,
        preset: RoadPreset,
    },
    CycleRoadDirection {
        point: Point,
    },
    PlaceRoundabout {
        origin: Point,
        size: RoundaboutSize,
    },
    RemoveAtTile {
        point: Point,
    },
    RemoveAtTiles {
        points: Vec<Point>,
    },
}

pub struct RoadMutationResult {
    pub snapshot: GameSnapshot,
    pub changed_tiles: Vec<Point>,
    pub skipped_tiles: Vec<Point>,
    pub cost: i32,
}

pub fn apply_road_mutation(
    state: &GameSnapshot,
    mutation: &RoadMutation,
) -> GameplayResult<RoadMutationResult> {
    if let RoadMutation::PlaceRoundabout { origin, size } = mutation {
        return crate::roundabouts::place_roundabout(state, *origin, *size);
    }
    let mut candidate = state.clone();
    let mut changed_tiles = Vec::new();
    let mut skipped_tiles = Vec::new();
    let cost = apply_linear_tiles_in_order(
        state,
        &mut candidate,
        mutation,
        &mut changed_tiles,
        &mut skipped_tiles,
    )?;
    crate::roundabouts::sync_roundabout_ports(&mut candidate.map);
    refresh_automatic_junctions(&mut candidate.map)?;
    canonicalize_authored_roads(&mut candidate.map);
    Ok(RoadMutationResult {
        snapshot: candidate,
        changed_tiles,
        skipped_tiles,
        cost,
    })
}

fn apply_linear_tiles_in_order(
    original: &GameSnapshot,
    candidate: &mut GameSnapshot,
    mutation: &RoadMutation,
    changed_tiles: &mut Vec<Point>,
    skipped_tiles: &mut Vec<Point>,
) -> GameplayResult<i32> {
    match mutation {
        RoadMutation::LayRoad { point } => {
            lay_single_road(original, candidate, *point)?;
            changed_tiles.push(*point);
        }
        RoadMutation::LayRoadLine { points, preset } => {
            lay_road_line(
                original,
                candidate,
                points,
                *preset,
                changed_tiles,
                skipped_tiles,
            )?;
        }
        RoadMutation::CycleRoadDirection { point } => {
            cycle_road_direction(candidate, *point)?;
            changed_tiles.push(*point);
        }
        RoadMutation::PlaceRoundabout { .. } => {
            unreachable!("roundabout mutations are handled atomically")
        }
        RoadMutation::RemoveAtTile { point } => {
            remove_road(candidate, *point)?;
            changed_tiles.push(*point);
        }
        RoadMutation::RemoveAtTiles { points } => {
            if points.is_empty() {
                return Err(GameplayRejection::new(RejectionCode::BlockedTile));
            }
            for point in points {
                if remove_road(candidate, *point).is_ok() {
                    changed_tiles.push(*point);
                } else {
                    skipped_tiles.push(*point);
                }
            }
            if changed_tiles.is_empty() {
                return Err(GameplayRejection::at(RejectionCode::BlockedTile, points[0]));
            }
        }
    }

    Ok(original.budget.saturating_sub(candidate.budget))
}

fn lay_single_road(
    original: &GameSnapshot,
    candidate: &mut GameSnapshot,
    point: Point,
) -> GameplayResult<()> {
    if original.budget < ROAD_COST {
        return Err(GameplayRejection::budget(ROAD_COST, original.budget));
    }
    if !is_valid_road_placement(original, point) {
        let code = if original.map.tile(point).is_none() {
            RejectionCode::OutOfBounds
        } else {
            RejectionCode::BlockedTile
        };
        return Err(GameplayRejection::at(code, point));
    }

    candidate.budget -= ROAD_COST;
    let tile = candidate.map.tile_mut(point).expect("validated map point");
    initialize_road_tile(tile, None);
    connect_neighbor_endpoints(&mut candidate.map, point);
    Ok(())
}

fn lay_road_line(
    original: &GameSnapshot,
    candidate: &mut GameSnapshot,
    points: &[Point],
    preset: RoadPreset,
    changed_tiles: &mut Vec<Point>,
    skipped_tiles: &mut Vec<Point>,
) -> GameplayResult<()> {
    if points.is_empty() {
        return Err(GameplayRejection::new(RejectionCode::InvalidRoadStroke));
    }
    // Direction helpers subtract consecutive stroke coordinates. Host-sent
    // points near i32 extremes can overflow before per-tile map validation.
    if stroke_direction_overflows(points) {
        return Err(GameplayRejection::at(
            RejectionCode::InvalidRoadStroke,
            points[0],
        ));
    }

    let forward = line_direction(points);
    let dual_direction = canonical_line_direction(points);
    let direction = match preset {
        RoadPreset::TwoWay => None,
        RoadPreset::OneWay => forward,
        RoadPreset::DualBidirectional => dual_direction,
    };
    let forward_points = author_lane_tiles(candidate, original, points, direction, false);
    connect_authored_sequence(&mut candidate.map, &forward_points);
    for point in &forward_points {
        connect_neighbor_endpoints(&mut candidate.map, *point);
    }
    record_line_results(
        original,
        candidate,
        points,
        &forward_points,
        changed_tiles,
        skipped_tiles,
    );

    if preset == RoadPreset::DualBidirectional {
        if let Some(canonical) = dual_direction {
            // Reverse-lane offsets can overflow i32 even when consecutive stroke
            // subtraction is fine (e.g. South reverse +1 on x=i32::MAX).
            if reverse_lane_offset_overflows(points, canonical) {
                return Err(GameplayRejection::at(
                    RejectionCode::InvalidRoadStroke,
                    points[0],
                ));
            }
            let reverse_points = reverse_lane_points(points, canonical);
            let authored = author_lane_tiles(
                candidate,
                original,
                &reverse_points,
                Some(opposite(canonical)),
                true,
            );
            connect_authored_sequence(&mut candidate.map, &authored);
            for point in &authored {
                connect_neighbor_endpoints(&mut candidate.map, *point);
            }
            record_line_results(
                original,
                candidate,
                &reverse_points,
                &authored,
                changed_tiles,
                skipped_tiles,
            );
        }
    }

    deduplicate_points(changed_tiles);
    deduplicate_points(skipped_tiles);
    skipped_tiles.retain(|point| !changed_tiles.contains(point));
    if changed_tiles.is_empty() {
        return Err(GameplayRejection::at(
            RejectionCode::InvalidRoadStroke,
            points[0],
        ));
    }
    Ok(())
}

fn author_lane_tiles(
    candidate: &mut GameSnapshot,
    original: &GameSnapshot,
    points: &[Point],
    direction: Option<Heading>,
    reverse_lane: bool,
) -> Vec<Point> {
    let mut authored = Vec::new();
    for point in points {
        let Some(existing) = candidate.map.tile(*point).cloned() else {
            continue;
        };
        if crate::roundabouts::is_roundabout_owned(&candidate.map, *point) {
            continue;
        }
        if existing.kind == "road" {
            if reverse_lane && !can_overlay_reverse_lane(&existing, direction) {
                continue;
            }
            let tile = candidate.map.tile_mut(*point).expect("tile was found");
            merge_lane_direction(tile, direction);
            authored.push(*point);
            continue;
        }
        if candidate.budget < ROAD_COST || !is_valid_road_placement(original, *point) {
            continue;
        }
        candidate.budget -= ROAD_COST;
        initialize_road_tile(
            candidate.map.tile_mut(*point).expect("validated map point"),
            direction,
        );
        authored.push(*point);
    }
    authored
}

fn can_overlay_reverse_lane(tile: &Tile, direction: Option<Heading>) -> bool {
    let Some(direction) = direction else {
        return false;
    };
    tile.road_structure_id.is_some()
        || tile
            .road_connections
            .iter()
            .any(|connection| !same_axis(*connection, direction))
}

fn initialize_road_tile(tile: &mut Tile, direction: Option<Heading>) {
    tile.kind = "road".to_string();
    tile.one_way = direction;
    tile.road_connections.clear();
    tile.road_structure_id = None;
}

fn merge_lane_direction(tile: &mut Tile, direction: Option<Heading>) {
    if tile.road_structure_id.is_some() {
        tile.one_way = None;
        return;
    }
    let intersects_existing_axis = direction.is_some_and(|direction| {
        tile.road_connections
            .iter()
            .any(|connection| !same_axis(*connection, direction))
    });
    tile.one_way = if intersects_existing_axis {
        None
    } else {
        direction
    };
}

fn record_line_results(
    original: &GameSnapshot,
    candidate: &GameSnapshot,
    requested: &[Point],
    authored: &[Point],
    changed_tiles: &mut Vec<Point>,
    skipped_tiles: &mut Vec<Point>,
) {
    for point in requested {
        let changed =
            authored.contains(point) && original.map.tile(*point) != candidate.map.tile(*point);
        if changed {
            changed_tiles.push(*point);
        } else {
            skipped_tiles.push(*point);
        }
    }
}

fn connect_authored_sequence(map: &mut GameMap, points: &[Point]) {
    for pair in points.windows(2) {
        if let Some(heading) = heading_between(pair[0], pair[1]) {
            connect(map, pair[0], heading);
        }
    }
}

fn connect_neighbor_endpoints(map: &mut GameMap, point: Point) {
    for heading in [Heading::North, Heading::East, Heading::South, Heading::West] {
        let neighbor_point = offset(point, heading);
        let Some(neighbor) = map.tile(neighbor_point) else {
            continue;
        };
        if neighbor.kind != "road" {
            continue;
        }
        if crate::roundabouts::is_roundabout_owned(map, neighbor_point) {
            // Approach roads laid after placement attach through a valid port
            // slot; structure ownership stays on the footprint tile.
            crate::roundabouts::attach_approach_to_roundabout(map, point, heading);
            continue;
        }
        if neighbor.road_structure_id.is_some() {
            // Automatic junctions are rebuilt from reciprocal edges; allow the
            // new arm to connect even when the junction tile already has degree ≥2.
            connect(map, point, heading);
            continue;
        }
        if neighbor.road_connections.len() >= 2 {
            continue;
        }
        connect(map, point, heading);
    }
}

fn connect(map: &mut GameMap, point: Point, heading: Heading) {
    let neighbor_point = offset(point, heading);
    if !matches!(map.tile(point), Some(tile) if tile.kind == "road")
        || !matches!(map.tile(neighbor_point), Some(tile) if tile.kind == "road")
        || crate::roundabouts::is_roundabout_owned(map, point)
        || crate::roundabouts::is_roundabout_owned(map, neighbor_point)
    {
        return;
    }
    if let Some(tile) = map.tile(point) {
        if tile.road_connections.contains(&heading) {
            return;
        }
    }
    if let Some(tile) = map.tile_mut(point) {
        tile.road_connections.push(heading);
    }
    if let Some(neighbor) = map.tile_mut(neighbor_point) {
        let reciprocal = opposite(heading);
        if !neighbor.road_connections.contains(&reciprocal) {
            neighbor.road_connections.push(reciprocal);
        }
    }
}

fn cycle_road_direction(candidate: &mut GameSnapshot, point: Point) -> GameplayResult<()> {
    let Some(tile) = candidate.map.tile(point) else {
        return Err(GameplayRejection::at(RejectionCode::OutOfBounds, point));
    };
    if tile.kind != "road" {
        return Err(GameplayRejection::at(RejectionCode::RoadRequired, point));
    }
    if tile.road_structure_id.is_some() {
        return Err(GameplayRejection::at(
            RejectionCode::InvalidDirectionChange,
            point,
        ));
    }
    let next = match tile.one_way {
        None => Some(Heading::North),
        Some(Heading::North) => Some(Heading::East),
        Some(Heading::East) => Some(Heading::South),
        Some(Heading::South) => Some(Heading::West),
        Some(Heading::West) => None,
    };
    candidate
        .map
        .tile_mut(point)
        .expect("tile was found")
        .one_way = next;
    Ok(())
}

fn remove_road(candidate: &mut GameSnapshot, point: Point) -> GameplayResult<()> {
    let Some(tile) = candidate.map.tile(point) else {
        return Err(GameplayRejection::at(RejectionCode::OutOfBounds, point));
    };
    if tile.kind != "road" {
        return Err(GameplayRejection::at(RejectionCode::BlockedTile, point));
    }
    if crate::roundabouts::is_roundabout_owned(&candidate.map, point) {
        return Err(GameplayRejection::at(RejectionCode::BlockedTile, point));
    }
    let connections = tile.road_connections.clone();
    for heading in connections {
        if let Some(neighbor) = candidate.map.tile_mut(offset(point, heading)) {
            neighbor
                .road_connections
                .retain(|edge| *edge != opposite(heading));
        }
    }
    let tile = candidate.map.tile_mut(point).expect("tile was found");
    tile.kind = "empty".to_string();
    tile.one_way = None;
    tile.road_connections.clear();
    tile.road_structure_id = None;
    Ok(())
}

pub fn author_scenario_road_line(map: &mut GameMap, points: &[Point], preset: RoadPreset) {
    if points.is_empty() {
        return;
    }
    let direction = match preset {
        RoadPreset::TwoWay => None,
        RoadPreset::OneWay => line_direction(points),
        RoadPreset::DualBidirectional => canonical_line_direction(points),
    };
    for point in points {
        if let Some(tile) = map.tile_mut(*point) {
            if tile.kind == "road" {
                merge_lane_direction(tile, direction);
            } else {
                initialize_road_tile(tile, direction);
            }
        }
    }
    connect_authored_sequence(map, points);

    if preset == RoadPreset::DualBidirectional {
        if let Some(direction) = direction {
            let reverse_points = reverse_lane_points(points, direction);
            for point in &reverse_points {
                if let Some(tile) = map.tile_mut(*point) {
                    if tile.kind == "road" {
                        if can_overlay_reverse_lane(tile, Some(opposite(direction))) {
                            merge_lane_direction(tile, Some(opposite(direction)));
                        }
                    } else {
                        initialize_road_tile(tile, Some(opposite(direction)));
                    }
                }
            }
            connect_authored_sequence(map, &reverse_points);
        }
    }
    canonicalize_authored_roads(map);
}

pub fn refresh_all_automatic_junctions(map: &mut GameMap) -> GameplayResult<()> {
    refresh_automatic_junctions(map)
}

/// Recompute every automatic junction on the map.
///
/// This performs a whole-map scan (not a localized rebuild): junctions can
/// span multiple tiles and merge/split as adjacent roads change, so the
/// affected region is not bounded by the edited tiles. `GameMap::tile` is an
/// O(N) linear scan, so this is ~O(N²) in the tile count — acceptable at the
/// current 28x18 scenario size; revisit if the map grows.
fn refresh_automatic_junctions(map: &mut GameMap) -> GameplayResult<()> {
    canonicalize_authored_roads(map);

    let automatic_ids: HashSet<String> = map
        .road_structures
        .iter()
        .filter(|structure| structure.is_automatic_junction())
        .map(|structure| structure.id().to_string())
        .collect();
    let former_automatic_footprint: Vec<Point> = map
        .road_structures
        .iter()
        .filter(|structure| structure.is_automatic_junction())
        .flat_map(|structure| structure.footprint().iter().copied())
        .collect();
    for tile in &mut map.tiles {
        if tile
            .road_structure_id
            .as_ref()
            .is_some_and(|id| automatic_ids.contains(id))
        {
            tile.road_structure_id = None;
        }
    }
    map.road_structures
        .retain(|structure| !structure.is_automatic_junction());

    // Loop invariant: each iteration either discovers junction structures
    // and breaks, or disconnects a set of `prune_edges` (internal edges of a
    // candidate footprint that lack both horizontal and vertical boundary
    // ports) and continues. Disconnecting an edge removes it from both the
    // tile and its reciprocal neighbor, strictly shrinking the candidate set
    // (a tile with a pruned edge can no longer satisfy `has_axis` for both
    // axes, or its reciprocal neighbor can't). The candidate set is finite
    // (bounded by the map), so the loop terminates in at most as many
    // iterations as there are road tiles. The cap below catches a regression
    // that could hang a dispatch: debug_assert in dev, release degrades by
    // stopping the loop (same pattern as trips::tick substep cap).
    let mut iteration = 0usize;
    let max_iterations = map.tiles.len().saturating_add(1);
    loop {
        if iteration >= max_iterations {
            // Release degradation: leave the map without further automatic
            // junctions rather than hang every road dispatch. Former automatic
            // junctions were already cleared above; restore directions below.
            debug_assert!(false, "refresh_automatic_junctions exceeded iteration cap");
            break;
        }
        iteration += 1;
        let candidates: BTreeSet<Point> = map
            .tiles
            .iter()
            .filter(|tile| {
                tile.kind == "road"
                    && tile.road_structure_id.is_none()
                    && has_axis(&tile.road_connections, true)
                    && has_axis(&tile.road_connections, false)
            })
            .map(|tile| Point {
                x: tile.x,
                y: tile.y,
            })
            .collect();

        let mut visited = HashSet::new();
        let mut structures = Vec::new();
        let mut prune_edges = Vec::new();
        for start in &candidates {
            if visited.contains(start) {
                continue;
            }
            let mut queue = VecDeque::from([*start]);
            let mut footprint = Vec::new();
            while let Some(point) = queue.pop_front() {
                if !visited.insert(point) {
                    continue;
                }
                footprint.push(point);
                let Some(tile) = map.tile(point) else {
                    continue;
                };
                for heading in &tile.road_connections {
                    let neighbor = offset(point, *heading);
                    if candidates.contains(&neighbor)
                        && reciprocal_connection(map, point, *heading)
                        && !visited.contains(&neighbor)
                    {
                        queue.push_back(neighbor);
                    }
                }
            }
            footprint.sort_by_key(|point| (point.y, point.x));
            let footprint_set: HashSet<_> = footprint.iter().copied().collect();
            let mut port_keys = Vec::new();
            for point in &footprint {
                let tile = map.tile(*point).expect("junction tile exists");
                for heading in &tile.road_connections {
                    if !footprint_set.contains(&offset(*point, *heading))
                        && reciprocal_connection(map, *point, *heading)
                    {
                        port_keys.push((*point, *heading));
                    }
                }
            }
            port_keys.sort();
            port_keys.dedup();
            let has_horizontal_ports = port_keys
                .iter()
                .any(|(_, edge)| matches!(edge, Heading::East | Heading::West));
            let has_vertical_ports = port_keys
                .iter()
                .any(|(_, edge)| matches!(edge, Heading::North | Heading::South));
            if !has_horizontal_ports || !has_vertical_ports {
                for point in &footprint {
                    let tile = map.tile(*point).expect("junction tile exists");
                    for heading in &tile.road_connections {
                        let horizontal = matches!(heading, Heading::East | Heading::West);
                        if footprint_set.contains(&offset(*point, *heading))
                            && ((horizontal && !has_horizontal_ports)
                                || (!horizontal && !has_vertical_ports))
                        {
                            prune_edges.push((*point, *heading));
                        }
                    }
                }
                continue;
            }
            if port_keys.len() < 3 {
                continue;
            }
            let id = junction_id(&footprint, &port_keys);
            let ports = port_keys
                .iter()
                .map(|(point, edge)| RoadPort {
                    id: format!(
                        "{id}-port-{}-{}-{}",
                        point.x,
                        point.y,
                        crate::heading::heading_key(*edge)
                    ),
                    point: *point,
                    edge: *edge,
                    direction: None,
                })
                .collect();
            structures.push(RoadStructure::AutomaticJunction {
                id,
                footprint,
                ports,
            });
        }

        if !prune_edges.is_empty() {
            for (point, heading) in prune_edges {
                disconnect(map, point, heading);
            }
            canonicalize_authored_roads(map);
            continue;
        }

        for structure in &structures {
            for point in structure.footprint() {
                let tile = map.tile_mut(*point).expect("junction tile exists");
                tile.road_structure_id = Some(structure.id().to_string());
                tile.one_way = None;
            }
        }
        map.road_structures.extend(structures);
        break;
    }

    map.road_structures
        .sort_by(|left, right| left.id().cmp(right.id()));
    restore_unowned_lane_directions(map, &former_automatic_footprint);
    Ok(())
}

fn disconnect(map: &mut GameMap, point: Point, heading: Heading) {
    if let Some(tile) = map.tile_mut(point) {
        tile.road_connections.retain(|edge| *edge != heading);
    }
    if let Some(neighbor) = map.tile_mut(offset(point, heading)) {
        neighbor
            .road_connections
            .retain(|edge| *edge != opposite(heading));
    }
}

fn restore_unowned_lane_directions(map: &mut GameMap, former_footprint: &[Point]) {
    for point in former_footprint.iter().copied() {
        let Some(tile) = map.tile(point) else {
            continue;
        };
        if tile.kind != "road"
            || tile.road_structure_id.is_some()
            || tile.one_way.is_some()
            || tile.road_connections.is_empty()
            || !(has_axis(&tile.road_connections, true) ^ has_axis(&tile.road_connections, false))
        {
            continue;
        }
        let mut inferred = BTreeSet::new();
        for heading in &tile.road_connections {
            if let Some(direction) = find_lane_direction(map, point, *heading) {
                inferred.insert(direction);
            }
        }
        if inferred.len() == 1 {
            map.tile_mut(point).expect("tile was found").one_way = inferred.first().copied();
        }
    }
}

fn find_lane_direction(map: &GameMap, start: Point, initial: Heading) -> Option<Heading> {
    let horizontal = matches!(initial, Heading::East | Heading::West);
    let mut previous = start;
    let mut current = offset(start, initial);
    let mut visited = HashSet::from([start]);
    while visited.insert(current) {
        let tile = map.tile(current)?;
        if let Some(direction) = tile.one_way {
            if same_axis(direction, initial) {
                return Some(direction);
            }
        }
        let next = tile.road_connections.iter().copied().find(|heading| {
            matches!(*heading, Heading::East | Heading::West) == horizontal
                && offset(current, *heading) != previous
        });
        let Some(next) = next else {
            break;
        };
        previous = current;
        current = offset(current, next);
    }
    None
}

fn canonicalize_authored_roads(map: &mut GameMap) {
    for tile in &mut map.tiles {
        if tile.kind != "road" {
            tile.one_way = None;
            tile.road_connections.clear();
        } else {
            tile.road_connections
                .sort_by_key(|heading| road_connection_rank(*heading));
            tile.road_connections.dedup();
        }
    }
    let connections: Vec<_> = map
        .tiles
        .iter()
        .map(|tile| {
            (
                Point {
                    x: tile.x,
                    y: tile.y,
                },
                tile.road_connections.clone(),
            )
        })
        .collect();
    for (point, headings) in connections {
        let valid: Vec<_> = headings
            .into_iter()
            .filter(|heading| reciprocal_connection(map, point, *heading))
            .collect();
        if let Some(tile) = map.tile_mut(point) {
            tile.road_connections = valid;
        }
    }
}

fn reciprocal_connection(map: &GameMap, point: Point, heading: Heading) -> bool {
    map.tile(offset(point, heading)).is_some_and(|neighbor| {
        neighbor.kind == "road" && neighbor.road_connections.contains(&opposite(heading))
    })
}

fn junction_id(footprint: &[Point], port_keys: &[(Point, Heading)]) -> String {
    let mut sorted_footprint = footprint.to_vec();
    sorted_footprint.sort();
    let footprint = sorted_footprint
        .iter()
        .map(|point| format!("{},{}", point.x, point.y))
        .collect::<Vec<_>>()
        .join(";");
    let ports = port_keys
        .iter()
        .map(|(point, heading)| {
            format!(
                "{},{}:{}",
                point.x,
                point.y,
                crate::heading::heading_key(*heading)
            )
        })
        .collect::<Vec<_>>()
        .join(";");
    format!("junction-{footprint}-{ports}")
}

fn road_connection_rank(heading: Heading) -> u8 {
    match heading {
        Heading::North => 0,
        Heading::East => 1,
        Heading::South => 2,
        Heading::West => 3,
    }
}

fn line_direction(points: &[Point]) -> Option<Heading> {
    if points.len() < 2 {
        return None;
    }
    heading_between(points[0], points[1])
}

fn stroke_direction_overflows(points: &[Point]) -> bool {
    points.windows(2).any(|pair| {
        pair[1].x.checked_sub(pair[0].x).is_none() || pair[1].y.checked_sub(pair[0].y).is_none()
    })
}

fn reverse_lane_offset_overflows(points: &[Point], direction: Heading) -> bool {
    let (offset_x, offset_y) = match direction {
        Heading::North => (-1, 0),
        Heading::East => (0, -1),
        Heading::South => (1, 0),
        Heading::West => (0, 1),
    };
    points.iter().any(|point| {
        point.x.checked_add(offset_x).is_none() || point.y.checked_add(offset_y).is_none()
    })
}

fn canonical_line_direction(points: &[Point]) -> Option<Heading> {
    if points.len() < 2 {
        return None;
    }
    let dx = points[1].x.checked_sub(points[0].x)?;
    let dy = points[1].y.checked_sub(points[0].y)?;
    if dx != 0 {
        Some(Heading::East)
    } else if dy != 0 {
        Some(Heading::South)
    } else {
        None
    }
}

fn same_axis(left: Heading, right: Heading) -> bool {
    matches!(left, Heading::North | Heading::South)
        == matches!(right, Heading::North | Heading::South)
}

fn has_axis(connections: &[Heading], horizontal: bool) -> bool {
    connections
        .iter()
        .any(|heading| horizontal == matches!(heading, Heading::East | Heading::West))
}

fn reverse_lane_points(points: &[Point], direction: Heading) -> Vec<Point> {
    let (offset_x, offset_y) = match direction {
        Heading::North => (-1, 0),
        Heading::East => (0, -1),
        Heading::South => (1, 0),
        Heading::West => (0, 1),
    };
    // Callers validate reverse_lane_offset_overflows first; checked_add is a
    // defensive belt so host-sent extremes never panic in debug builds.
    points
        .iter()
        .filter_map(|point| {
            Some(Point {
                x: point.x.checked_add(offset_x)?,
                y: point.y.checked_add(offset_y)?,
            })
        })
        .collect()
}

fn is_valid_road_placement(state: &GameSnapshot, point: Point) -> bool {
    state.map.tile(point).is_some_and(|tile| {
        tile.kind == "empty"
            && tile.road_structure_id.is_none()
            && !state
                .buildings
                .iter()
                .any(|building| building.occupied_tiles.contains(&point))
            && !state
                .transit
                .stops
                .iter()
                .any(|stop| is_present_node(stop.status) && stop.position == point)
            && !state
                .transit
                .stations
                .iter()
                .any(|station| is_present_node(station.status) && station.position == point)
    })
}

fn deduplicate_points(points: &mut Vec<Point>) {
    let mut seen = HashSet::new();
    points.retain(|point| seen.insert(*point));
}

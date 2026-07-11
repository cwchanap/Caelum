use std::collections::{HashMap, VecDeque};

use crate::model::{GameMap, Point, Tile, TransitMode};

pub fn find_tile_path(
    map: &GameMap,
    from: &Point,
    to: &Point,
    mode: TransitMode,
) -> Option<Vec<Point>> {
    let tile_by_key: HashMap<(i32, i32), &Tile> = map
        .tiles
        .iter()
        .map(|tile| ((tile.x, tile.y), tile))
        .collect();
    let from_key = (from.x, from.y);
    let to_key = (to.x, to.y);

    if !tile_by_key.contains_key(&from_key) || !tile_by_key.contains_key(&to_key) {
        return None;
    }
    if from_key == to_key {
        return Some(vec![*from]);
    }

    let mut parents: HashMap<(i32, i32), Option<(i32, i32)>> = HashMap::from([(from_key, None)]);
    let mut queue = VecDeque::from([from_key]);

    while let Some(current_key) = queue.pop_front() {
        let current_tile = tile_by_key.get(&current_key).copied();

        for (dx, dy) in [(0, -1), (1, 0), (0, 1), (-1, 0)] {
            let next_key = (current_key.0 + dx, current_key.1 + dy);
            if parents.contains_key(&next_key) {
                continue;
            }

            let Some(next_tile) = tile_by_key.get(&next_key).copied() else {
                continue;
            };

            let is_final_hop_to_off_network_stop =
                next_key == to_key && !is_traversable(next_tile, mode);
            if !is_final_hop_to_off_network_stop
                && mode == TransitMode::Bus
                && current_tile.is_some_and(|tile| tile.kind == "road" && tile.one_way.is_some())
            {
                let allowed = road_direction_offset(
                    current_tile
                        .and_then(|tile| tile.one_way.as_deref())
                        .expect("checked one-way presence"),
                );
                if (dx, dy) != allowed {
                    continue;
                }
            }

            if next_key != to_key && !is_traversable(next_tile, mode) {
                continue;
            }

            parents.insert(next_key, Some(current_key));

            if next_key == to_key {
                let path = build_path(&parents, next_key);
                if path.len() == 2 {
                    let from_tile = tile_by_key
                        .get(&from_key)
                        .copied()
                        .expect("from tile exists");
                    if !is_traversable(from_tile, mode) && !is_traversable(next_tile, mode) {
                        parents.remove(&next_key);
                        continue;
                    }
                }
                return Some(path);
            }

            queue.push_back(next_key);
        }
    }

    None
}

pub fn compute_route_segments(
    map: &GameMap,
    anchors: &[Point],
    mode: TransitMode,
) -> Vec<Vec<Point>> {
    if anchors.len() < 2 {
        return Vec::new();
    }

    anchors
        .iter()
        .enumerate()
        .map(|(index, from)| {
            let to = &anchors[(index + 1) % anchors.len()];
            find_tile_path(map, from, to, mode).unwrap_or_default()
        })
        .collect()
}

pub fn has_broken_segment(segments: &[Vec<Point>]) -> bool {
    segments.iter().any(Vec::is_empty)
}

fn build_path(parents: &HashMap<(i32, i32), Option<(i32, i32)>>, to_key: (i32, i32)) -> Vec<Point> {
    let mut path = Vec::new();
    let mut cursor = Some(to_key);
    while let Some(key) = cursor {
        path.push(Point { x: key.0, y: key.1 });
        cursor = parents.get(&key).copied().flatten();
    }
    path.reverse();
    path
}

fn is_traversable(tile: &Tile, mode: TransitMode) -> bool {
    match mode {
        TransitMode::Bus => tile.kind == "road",
        TransitMode::Metro => tile.has_track,
        TransitMode::Walk => false,
    }
}

fn road_direction_offset(direction: &str) -> (i32, i32) {
    match direction {
        "north" => (0, -1),
        "east" => (1, 0),
        "south" => (0, 1),
        "west" => (-1, 0),
        _ => (0, 0),
    }
}

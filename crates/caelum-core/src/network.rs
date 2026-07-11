use std::collections::{HashMap, VecDeque};

use crate::model::{
    GameMap, Heading, PathGeometry, Point, Tile, TrackPathStep, TransitMode, TransitPath,
};
use crate::road_topology::RoadTopology;
use crate::transit::METRO_TILES_PER_SECOND;

pub fn find_track_path(map: &GameMap, from: &Point, to: &Point) -> Option<TransitPath> {
    let points = deterministic_track_bfs(map, from, to)?;
    Some(track_path_from_points(points, METRO_TILES_PER_SECOND))
}

pub fn compute_route_segments(
    map: &GameMap,
    anchors: &[Point],
    mode: TransitMode,
) -> Vec<Vec<Point>> {
    if anchors.len() < 2 {
        return Vec::new();
    }
    let road_topology = (mode == TransitMode::Bus)
        .then(|| RoadTopology::compile(map).ok())
        .flatten();

    anchors
        .iter()
        .enumerate()
        .map(|(index, from)| {
            let to = &anchors[(index + 1) % anchors.len()];
            let path = match mode {
                TransitMode::Bus => road_topology
                    .as_ref()
                    .and_then(|topology| topology.find_path(map, from, to)),
                TransitMode::Metro => find_track_path(map, from, to),
                TransitMode::Walk => None,
            };
            path.map(|path| transit_path_points(&path, *to))
                .unwrap_or_default()
        })
        .collect()
}

pub fn has_broken_segment(segments: &[Vec<Point>]) -> bool {
    segments.iter().any(Vec::is_empty)
}

fn deterministic_track_bfs(map: &GameMap, from: &Point, to: &Point) -> Option<Vec<Point>> {
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
        for (dx, dy) in [(0, -1), (1, 0), (0, 1), (-1, 0)] {
            let next_key = (current_key.0 + dx, current_key.1 + dy);
            if parents.contains_key(&next_key) {
                continue;
            }
            let Some(next_tile) = tile_by_key.get(&next_key).copied() else {
                continue;
            };
            if next_key != to_key && !next_tile.has_track {
                continue;
            }

            parents.insert(next_key, Some(current_key));
            if next_key == to_key {
                let path = build_track_points(&parents, next_key);
                if path.len() == 2 {
                    let from_tile = tile_by_key.get(&from_key).copied()?;
                    if !from_tile.has_track && !next_tile.has_track {
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

fn build_track_points(
    parents: &HashMap<(i32, i32), Option<(i32, i32)>>,
    to_key: (i32, i32),
) -> Vec<Point> {
    let mut path = Vec::new();
    let mut cursor = Some(to_key);
    while let Some(key) = cursor {
        path.push(Point { x: key.0, y: key.1 });
        cursor = parents.get(&key).copied().flatten();
    }
    path.reverse();
    path
}

fn track_path_from_points(points: Vec<Point>, tiles_per_second: f64) -> TransitPath {
    let travel_seconds = 1.0 / tiles_per_second;
    let steps: Vec<_> = points
        .windows(2)
        .filter_map(|pair| {
            let heading = heading_between(pair[0], pair[1])?;
            Some(TrackPathStep {
                position: pair[0],
                heading,
                geometry: PathGeometry::Line {
                    from: pair[0].into(),
                    to: pair[1].into(),
                },
                travel_seconds,
            })
        })
        .collect();
    TransitPath::Track {
        total_travel_seconds: steps.len() as f64 * travel_seconds,
        steps,
    }
}

fn transit_path_points(path: &TransitPath, destination: Point) -> Vec<Point> {
    let mut points: Vec<_> = match path {
        TransitPath::Road { steps, .. } => steps.iter().map(|step| step.position).collect(),
        TransitPath::Track { steps, .. } => steps.iter().map(|step| step.position).collect(),
    };
    points.push(destination);
    points.dedup();
    points
}

fn heading_between(from: Point, to: Point) -> Option<Heading> {
    match (to.x - from.x, to.y - from.y) {
        (0, -1) => Some(Heading::North),
        (1, 0) => Some(Heading::East),
        (0, 1) => Some(Heading::South),
        (-1, 0) => Some(Heading::West),
        _ => None,
    }
}

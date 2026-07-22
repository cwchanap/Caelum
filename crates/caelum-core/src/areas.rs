use crate::model::{GameSnapshot, Point};
use crate::rejection::{GameplayRejection, GameplayResult, RejectionCode};
use crate::transit_nodes::is_present_node;

pub const AREAS: &[&str] = &[
    "residential",
    "commercial",
    "industrial",
    "office",
    "civic",
    "park",
];

// Enumerate the points of the axis-aligned rectangle between `start` and `end`,
// clipped to the map bounds `[0, map_width) x [0, map_height)`. Clipping is
// mandatory because `PaintAreaRectangle` intents are deserialized from the
// host/JS boundary: an unclamped i32 range (e.g. i32::MIN..i32::MAX) would
// allocate billions of off-map coordinates before `is_area_paintable` skips
// them, hanging or OOMing the engine. Returns an empty vec when the rectangle
// does not intersect the map.
pub fn rectangle_points(start: &Point, end: &Point, map_width: u8, map_height: u8) -> Vec<Point> {
    let width = i32::from(map_width);
    let height = i32::from(map_height);

    let raw_min_x = start.x.min(end.x);
    let raw_max_x = start.x.max(end.x);
    let raw_min_y = start.y.min(end.y);
    let raw_max_y = start.y.max(end.y);

    let min_x = raw_min_x.max(0);
    let max_x = raw_max_x.min(width - 1);
    let min_y = raw_min_y.max(0);
    let max_y = raw_max_y.min(height - 1);

    let mut points = Vec::new();
    if min_x > max_x || min_y > max_y {
        return points;
    }
    for y in min_y..=max_y {
        for x in min_x..=max_x {
            points.push(Point { x, y });
        }
    }

    points
}

pub fn is_area_paintable(state: &GameSnapshot, point: &Point) -> bool {
    let Some(tile) = state
        .map
        .tiles
        .iter()
        .find(|tile| tile.x == point.x && tile.y == point.y)
    else {
        return false;
    };

    tile.kind == "empty"
        && !tile.has_track
        && tile.road_structure_id.is_none()
        && !state
            .buildings
            .iter()
            .any(|building| building.occupied_tiles.iter().any(|tile| tile == point))
        // Missing-node tombstones are non-physical: their anchors are free for
        // zoning (and other placement paths) until the node is rebuilt.
        && !state.transit.stops.iter().any(|stop| {
            is_present_node(stop.status) && stop.position == *point
        })
        && !state.transit.stations.iter().any(|station| {
            is_present_node(station.status) && station.position == *point
        })
}

pub fn paint_area_rectangle(
    state: &GameSnapshot,
    area: &str,
    start: &Point,
    end: &Point,
) -> GameplayResult<GameSnapshot> {
    if !AREAS.contains(&area) {
        return Err(GameplayRejection::at(RejectionCode::BlockedTile, *start));
    }

    let mut next = state.clone();
    let mut changed = false;
    let points = rectangle_points(start, end, state.map.width, state.map.height);
    if points.is_empty() {
        return Err(GameplayRejection::at(RejectionCode::OutOfBounds, *start));
    }

    for point in points {
        if !is_area_paintable(state, &point) {
            continue;
        }

        if let Some(tile) = next
            .map
            .tiles
            .iter_mut()
            .find(|tile| tile.x == point.x && tile.y == point.y)
        {
            if tile.area.as_deref() != Some(area) {
                tile.area = Some(area.to_string());
                changed = true;
            }
        }
    }

    if changed {
        Ok(next)
    } else {
        Err(GameplayRejection::at(RejectionCode::BlockedTile, *start))
    }
}

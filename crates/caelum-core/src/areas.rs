use crate::model::{GameSnapshot, Point};

pub const AREAS: &[&str] = &[
    "residential",
    "commercial",
    "industrial",
    "office",
    "civic",
    "park",
];

pub fn rectangle_points(start: &Point, end: &Point) -> Vec<Point> {
    let min_x = start.x.min(end.x);
    let max_x = start.x.max(end.x);
    let min_y = start.y.min(end.y);
    let max_y = start.y.max(end.y);

    let mut points = Vec::new();
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
        && !state
            .buildings
            .iter()
            .any(|building| building.occupied_tiles.iter().any(|tile| tile == point))
        && !state
            .transit
            .stops
            .iter()
            .any(|stop| stop.position == *point)
        && !state
            .transit
            .stations
            .iter()
            .any(|station| station.position == *point)
}

pub fn paint_area_rectangle(
    state: &GameSnapshot,
    area: &str,
    start: &Point,
    end: &Point,
) -> Option<GameSnapshot> {
    if !AREAS.contains(&area) {
        return None;
    }

    let mut next = state.clone();
    let mut changed = false;

    for point in rectangle_points(start, end) {
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

    changed.then_some(next)
}

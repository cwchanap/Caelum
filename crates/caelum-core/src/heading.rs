use crate::model::{Heading, Point};

/// Returns the cardinal heading opposite to `heading`.
pub fn opposite(heading: Heading) -> Heading {
    match heading {
        Heading::North => Heading::South,
        Heading::East => Heading::West,
        Heading::South => Heading::North,
        Heading::West => Heading::East,
    }
}

/// Returns the `(dx, dy)` offset for a single step in `heading`'s direction.
pub fn offset_components(heading: Heading) -> (i32, i32) {
    match heading {
        Heading::North => (0, -1),
        Heading::East => (1, 0),
        Heading::South => (0, 1),
        Heading::West => (-1, 0),
    }
}

/// Returns the tile one step from `point` in `heading`'s direction.
pub fn offset(point: Point, heading: Heading) -> Point {
    let (dx, dy) = offset_components(heading);
    Point {
        x: point.x + dx,
        y: point.y + dy,
    }
}

/// All four cardinal headings in canonical (N, E, S, W) order.
pub fn canonical_headings() -> [Heading; 4] {
    [Heading::North, Heading::East, Heading::South, Heading::West]
}

/// Stable rank (0–3) for a heading, used for deterministic tie-breaking in
/// pathfinding and transition ordering. North < East < South < West.
pub fn heading_rank(heading: Heading) -> u8 {
    match heading {
        Heading::North => 0,
        Heading::East => 1,
        Heading::South => 2,
        Heading::West => 3,
    }
}

/// Stable string key for a heading, used in `stable_key` generation so
/// transition identity is deterministic across runs.
pub fn heading_key(heading: Heading) -> &'static str {
    match heading {
        Heading::North => "north",
        Heading::East => "east",
        Heading::South => "south",
        Heading::West => "west",
    }
}

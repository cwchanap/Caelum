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

use crate::ids::tile_id;
use crate::model::{GameMap, Tile};

pub const MAP_WIDTH: u8 = 28;
pub const MAP_HEIGHT: u8 = 18;

fn starter_road_direction(x: i32, y: i32) -> Option<String> {
    let horizontal = y == 8 || y == 9;
    let vertical = x == 14 || x == 15;

    if horizontal && vertical {
        None
    } else if y == 8 {
        Some("west".to_string())
    } else if y == 9 {
        Some("east".to_string())
    } else if x == 14 {
        Some("south".to_string())
    } else if x == 15 {
        Some("north".to_string())
    } else {
        None
    }
}

fn is_starter_road(x: i32, y: i32) -> bool {
    y == 8 || y == 9 || x == 14 || x == 15
}

pub fn create_growing_suburb_map() -> GameMap {
    let mut tiles = Vec::new();

    for y in 0..i32::from(MAP_HEIGHT) {
        for x in 0..i32::from(MAP_WIDTH) {
            tiles.push(Tile {
                id: tile_id(x, y),
                x,
                y,
                kind: if is_starter_road(x, y) {
                    "road"
                } else {
                    "empty"
                }
                .to_string(),
                area: None,
                has_track: false,
                one_way: starter_road_direction(x, y),
            });
        }
    }

    GameMap {
        width: MAP_WIDTH,
        height: MAP_HEIGHT,
        tiles,
    }
}

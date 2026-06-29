use crate::ids::tile_id;
use crate::model::{GameMap, ObjectiveThresholds, ScenarioConfig, Tile};
use crate::objectives::{
    MAX_AVERAGE_WAIT_SECONDS, MAX_LATE_RATIO, MAX_UNSERVED_RATIO, ROLLING_WINDOW_SECONDS,
    SURVIVAL_TIME_SECONDS,
};

pub const MAP_WIDTH: u8 = 28;
pub const MAP_HEIGHT: u8 = 18;

pub const SCENARIO_NAME: &str = "Growing Suburb";

/// The scenario identity + objective thresholds the engine enforces, sourced
/// from the `objectives` constants so the shell cannot drift from the values
/// `evaluate_objectives` actually applies (the previous TS shim hard-coded
/// `rollingWindowSeconds = 600` while the core evaluates at `300`).
pub fn growing_suburb_scenario() -> ScenarioConfig {
    ScenarioConfig {
        name: SCENARIO_NAME.to_string(),
        objectives: ObjectiveThresholds {
            max_late_ratio: MAX_LATE_RATIO,
            max_unserved_ratio: MAX_UNSERVED_RATIO,
            max_average_wait: MAX_AVERAGE_WAIT_SECONDS,
            rolling_window_seconds: ROLLING_WINDOW_SECONDS,
            survival_time: SURVIVAL_TIME_SECONDS,
        },
    }
}

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

use crate::model::{
    EconomyPreset, GameMode, GameRules, GrowthAction, GrowthWave, MaxAverageWaitSeconds,
    MaxLateRatio, MaxUnservedRatio, ObjectiveThresholds, Point, RollingWindowSeconds,
    SandboxSettings, ScenarioConfig, SurvivalTimeSeconds,
};
use crate::objectives::{
    MAX_AVERAGE_WAIT_SECONDS, MAX_LATE_RATIO, MAX_UNSERVED_RATIO, ROLLING_WINDOW_SECONDS,
    SURVIVAL_TIME_SECONDS,
};
use crate::sandbox::{canonical_default_settings, MAP_HEIGHT, MAP_WIDTH};

pub const SCENARIO_NAME: &str = "Growing Suburb";

/// One seed housing unit is authored per this many grid cells (tunable). For the
/// shipped 28×18 map this yields `504 / 100 = 5` `smallHouse` units.
pub const GRID_CELLS_PER_HOUSING_UNIT: i32 = 100;

const SEED_ANCHOR_X: i32 = 2;
const SEED_ANCHOR_Y: i32 = 3;
const SEED_UNITS_PER_ROW: i32 = 6;

pub fn growing_suburb_objectives() -> ObjectiveThresholds {
    ObjectiveThresholds {
        max_late_ratio: MaxLateRatio::new(MAX_LATE_RATIO)
            .expect("MAX_LATE_RATIO is a valid MaxLateRatio"),
        max_unserved_ratio: MaxUnservedRatio::new(MAX_UNSERVED_RATIO)
            .expect("MAX_UNSERVED_RATIO is a valid MaxUnservedRatio"),
        max_average_wait: MaxAverageWaitSeconds::new(MAX_AVERAGE_WAIT_SECONDS)
            .expect("MAX_AVERAGE_WAIT_SECONDS is a valid MaxAverageWaitSeconds"),
        rolling_window_seconds: RollingWindowSeconds::new(ROLLING_WINDOW_SECONDS)
            .expect("ROLLING_WINDOW_SECONDS is a valid RollingWindowSeconds"),
        survival_time: SurvivalTimeSeconds::new(SURVIVAL_TIME_SECONDS)
            .expect("SURVIVAL_TIME_SECONDS is a valid SurvivalTimeSeconds"),
    }
}

pub fn growing_suburb_scenario() -> ScenarioConfig {
    ScenarioConfig {
        name: SCENARIO_NAME.to_string(),
        objectives: None,
        growth_waves: Vec::new(),
    }
}

/// Shared default sandbox settings for the current campaign and initial snapshot.
pub fn growing_suburb_sandbox_settings() -> SandboxSettings {
    canonical_default_settings()
}

pub fn growing_suburb_campaign(
    objectives: ObjectiveThresholds,
    growth_waves: Vec<GrowthWave>,
) -> (GameRules, ScenarioConfig) {
    (
        GameRules {
            game_mode: GameMode::Campaign,
            economy_preset: EconomyPreset::Standard,
            sandbox: growing_suburb_sandbox_settings(),
        },
        ScenarioConfig {
            name: SCENARIO_NAME.to_string(),
            objectives: Some(objectives),
            growth_waves,
        },
    )
}

/// Grid-derived seed wave: authors `max(1, grid / GRID_CELLS_PER_HOUSING_UNIT)`
/// `smallHouse` units packed row-major from a fixed anchor west of the arterial
/// cross, zoning their bounding rectangle residential first (zone precedes build).
///
/// Pure and deterministic. NOTE: not wired into `growing_suburb_scenario()` — see
/// the comment there. Validated by unit tests; ready to wire in a follow-up.
pub fn growing_suburb_growth_waves() -> Vec<GrowthWave> {
    // `smallHouse` footprint (see building_catalog): 2 wide, 1 tall.
    const UNIT_WIDTH: i32 = 2;
    const UNIT_HEIGHT: i32 = 1;

    let grid = i32::from(MAP_WIDTH) * i32::from(MAP_HEIGHT);
    let n_units = (grid / GRID_CELLS_PER_HOUSING_UNIT).max(1);

    let origins: Vec<Point> = (0..n_units)
        .map(|k| Point {
            x: SEED_ANCHOR_X + (k % SEED_UNITS_PER_ROW) * UNIT_WIDTH,
            y: SEED_ANCHOR_Y + (k / SEED_UNITS_PER_ROW) * UNIT_HEIGHT,
        })
        .collect();

    // Guard every unit footprint against the map bounds and the arterial
    // cross (x in {14,15}, y in {8,9}) so future tuning of the anchor, row
    // width, unit size, or grid ratio cannot produce invalid placements.
    let map_w = i32::from(MAP_WIDTH);
    let map_h = i32::from(MAP_HEIGHT);
    for origin in &origins {
        let x0 = origin.x;
        let x1 = origin.x + UNIT_WIDTH - 1;
        let y0 = origin.y;
        let y1 = origin.y + UNIT_HEIGHT - 1;
        assert!(
            x0 >= 0 && x1 < map_w && y0 >= 0 && y1 < map_h,
            "seed unit origin {origin:?} footprint exceeds map bounds ({MAP_WIDTH}x{MAP_HEIGHT})",
        );
        let overlaps_horizontal_road = y0 <= 9 && y1 >= 8;
        let overlaps_vertical_road = x0 <= 15 && x1 >= 14;
        assert!(
            !overlaps_horizontal_road && !overlaps_vertical_road,
            "seed unit origin {origin:?} footprint overlaps the arterial cross",
        );
    }

    let max_x = origins
        .iter()
        .map(|p| p.x + UNIT_WIDTH - 1)
        .max()
        .unwrap_or(SEED_ANCHOR_X);
    let max_y = origins
        .iter()
        .map(|p| p.y + UNIT_HEIGHT - 1)
        .max()
        .unwrap_or(SEED_ANCHOR_Y);

    let mut actions = Vec::with_capacity(origins.len() + 1);
    actions.push(GrowthAction::PaintAreaRectangle {
        area: "residential".to_string(),
        start: Point {
            x: SEED_ANCHOR_X,
            y: SEED_ANCHOR_Y,
        },
        end: Point { x: max_x, y: max_y },
    });
    for origin in origins {
        actions.push(GrowthAction::PlaceBuilding {
            building_type: "smallHouse".to_string(),
            origin,
            rotation: 0,
        });
    }

    vec![GrowthWave {
        id: "wave-seed-residential".to_string(),
        trigger_time: 0.0,
        message: "First residents arrive — build destinations so they can commute.".to_string(),
        applied: false,
        actions,
    }]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::GrowthAction;

    #[test]
    fn seed_wave_unit_count_scales_with_grid() {
        let grid = i32::from(MAP_WIDTH) * i32::from(MAP_HEIGHT);
        let expected = (grid / GRID_CELLS_PER_HOUSING_UNIT).max(1);
        assert_eq!(expected, 5, "28*18/100 == 5 units on the shipped map");

        let waves = growing_suburb_growth_waves();
        assert_eq!(waves.len(), 1);
        let placements = waves[0]
            .actions
            .iter()
            .filter(|action| matches!(action, GrowthAction::PlaceBuilding { .. }))
            .count();
        assert_eq!(placements as i32, expected);
    }

    #[test]
    fn seed_wave_is_well_formed_and_clear_of_the_arterial() {
        let waves = growing_suburb_growth_waves();
        let wave = &waves[0];
        assert_eq!(wave.id, "wave-seed-residential");
        assert_eq!(wave.trigger_time, 0.0);
        assert!(!wave.applied);

        match &wave.actions[0] {
            GrowthAction::PaintAreaRectangle { area, .. } => assert_eq!(area, "residential"),
            other => panic!("first action must be the zoning paint, got {other:?}"),
        }
        for action in &wave.actions[1..] {
            let GrowthAction::PlaceBuilding {
                building_type,
                origin,
                ..
            } = action
            else {
                panic!("expected a building placement, got {action:?}");
            };
            assert_eq!(building_type, "smallHouse");
            // On-map and west/north of the arterial cross (x in {14,15}, y in {8,9}).
            assert!(origin.x >= 0 && origin.x + 1 < 14, "footprint west of x=14");
            assert!(origin.y >= 0 && origin.y < i32::from(MAP_HEIGHT));
            assert_ne!(origin.y, 8);
            assert_ne!(origin.y, 9);
        }
    }

    #[test]
    fn shipped_scenario_ships_no_waves() {
        assert!(growing_suburb_scenario().growth_waves.is_empty());
    }
}

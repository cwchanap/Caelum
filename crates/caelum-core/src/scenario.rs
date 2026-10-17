use crate::model::{
    EconomyPreset, GameMode, GameRules, MaxAverageWaitSeconds, MaxLateRatio, MaxUnservedRatio,
    ObjectiveThresholds, RollingWindowSeconds, ScenarioConfig, SurvivalTimeSeconds,
};
use crate::objectives::{
    MAX_AVERAGE_WAIT_SECONDS, MAX_LATE_RATIO, MAX_UNSERVED_RATIO, ROLLING_WINDOW_SECONDS,
    SURVIVAL_TIME_SECONDS,
};
use crate::sandbox::canonical_default_settings;

pub const SCENARIO_NAME: &str = "Growing Suburb";

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
    }
}

pub fn growing_suburb_campaign(objectives: ObjectiveThresholds) -> (GameRules, ScenarioConfig) {
    (
        GameRules {
            game_mode: GameMode::Campaign,
            economy_preset: EconomyPreset::Standard,
            sandbox: canonical_default_settings(),
        },
        ScenarioConfig {
            name: SCENARIO_NAME.to_string(),
            objectives: Some(objectives),
        },
    )
}

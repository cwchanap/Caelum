use crate::clock::{clock_minutes, day_index};
use crate::model::{
    EconomyPreset, GameMode, GameRules, GameSnapshot, Metrics, MetricsState, TransitNetwork,
    SNAPSHOT_SCHEMA_VERSION,
};
use crate::sandbox::{canonical_default_settings, DEFAULT_STARTING_CAPITAL};
use crate::scenario::{create_growing_suburb_map, growing_suburb_scenario};

pub fn create_initial_snapshot() -> GameSnapshot {
    GameSnapshot {
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        time: 0.0,
        day: day_index(0.0),
        clock_minutes: clock_minutes(0.0),
        speed: 1,
        paused: true,
        budget: DEFAULT_STARTING_CAPITAL,
        rules: GameRules {
            game_mode: GameMode::Sandbox,
            economy_preset: EconomyPreset::Standard,
            sandbox: canonical_default_settings(),
        },
        map: create_growing_suburb_map(),
        buildings: Vec::new(),
        transit: TransitNetwork {
            stops: Vec::new(),
            stations: Vec::new(),
            routes: Vec::new(),
            metro_lines: Vec::new(),
            vehicles: Vec::new(),
        },
        sims: Vec::new(),
        active_trips: Vec::new(),
        trip_sequence_day: day_index(0.0),
        next_trip_sequence: 1,
        metrics: Metrics {
            late_trips: 0,
            completed_trips: 0,
            unserved_trips: 0,
            total_wait_seconds: 0.0,
            waiting_trip_count: 0,
            average_wait_seconds: 0.0,
            trip_outcomes: Vec::new(),
            state: MetricsState::Running,
            loss_reason: None,
        },
        scenario: growing_suburb_scenario(),
    }
}

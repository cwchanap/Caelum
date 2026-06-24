use crate::clock::{clock_minutes, day_index};
use crate::model::{GameSnapshot, Metrics, TransitNetwork};
use crate::scenario::create_growing_suburb_map;

pub fn create_initial_snapshot() -> GameSnapshot {
    GameSnapshot {
        time: 0.0,
        day: day_index(0.0),
        clock_minutes: clock_minutes(0.0),
        speed: 1,
        paused: true,
        budget: 120_000,
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
        metrics: Metrics {
            late_trips: 0,
            completed_trips: 0,
            unserved_trips: 0,
            total_wait_seconds: 0.0,
            waiting_trip_count: 0,
            average_wait_seconds: 0.0,
            state: "running".to_string(),
            loss_reason: None,
        },
    }
}

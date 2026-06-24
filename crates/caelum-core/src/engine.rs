use crate::intent::{DispatchResult, GameIntent};
use crate::model::{GameMap, GameSnapshot, Metrics, TransitNetwork};

#[derive(Clone, Debug)]
pub struct GameEngine {
    snapshot: GameSnapshot,
}

impl Default for GameEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl GameEngine {
    pub fn new() -> Self {
        Self {
            snapshot: initial_snapshot(),
        }
    }

    pub fn snapshot(&self) -> GameSnapshot {
        self.snapshot.clone()
    }

    pub fn reset(&mut self) -> GameSnapshot {
        self.snapshot = initial_snapshot();
        self.snapshot()
    }

    pub fn tick(&mut self, _delta_seconds: f64) -> DispatchResult {
        DispatchResult {
            snapshot: self.snapshot(),
            applied: false,
            rejection: None,
        }
    }

    pub fn dispatch(&mut self, intent: GameIntent) -> DispatchResult {
        match intent {
            GameIntent::AssignVehicle { line_id, .. } => DispatchResult {
                snapshot: self.snapshot(),
                applied: false,
                rejection: Some(format!("line not found: {line_id}")),
            },
        }
    }
}

fn initial_snapshot() -> GameSnapshot {
    GameSnapshot {
        time: 0.0,
        day: 0,
        clock_minutes: 0,
        speed: 1,
        paused: true,
        budget: 120_000,
        map: GameMap {
            width: 28,
            height: 18,
            tiles: Vec::new(),
        },
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

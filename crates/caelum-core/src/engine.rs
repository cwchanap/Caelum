use crate::areas;
use crate::buildings;
use crate::intent::{DispatchResult, GameIntent};
use crate::model::GameSnapshot;
use crate::state::create_initial_snapshot;

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
            snapshot: create_initial_snapshot(),
        }
    }

    pub fn snapshot(&self) -> GameSnapshot {
        self.snapshot.clone()
    }

    pub fn reset(&mut self) -> GameSnapshot {
        self.snapshot = create_initial_snapshot();
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
            GameIntent::PaintAreaRectangle { area, start, end } => {
                match areas::paint_area_rectangle(&self.snapshot, &area, &start, &end) {
                    Some(next) => {
                        self.snapshot = next;
                        DispatchResult {
                            snapshot: self.snapshot(),
                            applied: true,
                            rejection: None,
                        }
                    }
                    None => DispatchResult {
                        snapshot: self.snapshot(),
                        applied: false,
                        rejection: Some("no paintable tiles".to_string()),
                    },
                }
            }
            GameIntent::PlaceBuilding {
                building_type,
                origin,
                rotation,
            } => match buildings::place_building(&self.snapshot, &building_type, &origin, rotation)
            {
                Ok(next) => {
                    self.snapshot = next;
                    DispatchResult {
                        snapshot: self.snapshot(),
                        applied: true,
                        rejection: None,
                    }
                }
                Err(rejection) => DispatchResult {
                    snapshot: self.snapshot(),
                    applied: false,
                    rejection: Some(rejection),
                },
            },
        }
    }
}

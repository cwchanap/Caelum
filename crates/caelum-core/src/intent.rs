use serde::{Deserialize, Serialize};

use crate::model::GameSnapshot;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GameIntent {
    AssignVehicle { mode: String, line_id: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchResult {
    pub snapshot: GameSnapshot,
    pub applied: bool,
    pub rejection: Option<String>,
}

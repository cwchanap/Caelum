use bevy_ecs::prelude::*;

use crate::model::Point;

#[derive(Component, Clone, Debug, PartialEq, Eq)]
pub(super) struct CitizenId(pub(super) String);

#[derive(Component, Clone, Debug, PartialEq)]
pub(super) struct HomeAssignment {
    pub(super) building_id: Option<String>,
    pub(super) point: Point,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct BuildingAssignment {
    pub(super) building_id: Option<String>,
    pub(super) point: Point,
}

#[derive(Component, Clone, Debug, PartialEq)]
pub(super) struct SettledPosition(pub(super) Point);

#[derive(Component, Clone, Debug, PartialEq)]
pub(super) enum Routine {
    Worker {
        shift_template: String,
        workplace: Option<BuildingAssignment>,
    },
    Student,
}

#[derive(Component, Clone, Debug, PartialEq)]
pub(super) struct LegacyDayState {
    pub(super) commute_day: u32,
    pub(super) outbound_resolved: bool,
    pub(super) outbound_arrived: bool,
    pub(super) return_resolved: bool,
    pub(super) returned_home: bool,
}

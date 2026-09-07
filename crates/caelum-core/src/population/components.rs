use bevy_ecs::prelude::*;

use crate::model::{Point, ScheduledActivity};

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

/// Durable next scheduled activity. The component is authoritative citizen
/// state; the exact-time scheduler bucket entry is only its wake-up. A citizen
/// with no component is travelling: an active trip owns them until its
/// resolution handler schedules the next activity.
#[derive(Component, Clone, Debug, PartialEq)]
pub(super) struct NextActivity(pub(super) ScheduledActivity);

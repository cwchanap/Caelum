use crate::building_catalog::building_definition;
use crate::buildings::assign_workplaces;
use crate::clock::{GAME_DAY_SECONDS, MINUTES_PER_DAY};
use crate::commute::{departure_minute_for_sim, shift_template_for_id, worker_profile_for_id};
use crate::ids::next_entity_id;
use crate::model::{GameMode, GameSnapshot, PlacedBuilding, Sim};

pub const MOVE_IN_INTERVAL_SECONDS: f64 = GAME_DAY_SECONDS / 24.0;

pub fn resident_occupancy(state: &GameSnapshot, building: &PlacedBuilding) -> usize {
    state
        .sims
        .iter()
        .filter(|sim| building.occupied_tiles.contains(&sim.home))
        .count()
}

pub fn apply_due_move_ins(state: &mut GameSnapshot) {
    if state.rules.game_mode != GameMode::Sandbox {
        return;
    }

    let mut housing_ids: Vec<String> = state
        .buildings
        .iter()
        .filter(|building| {
            building_definition(&building.building_type)
                .is_some_and(|definition| definition.resident_capacity > 0)
        })
        .map(|building| building.id.clone())
        .collect();
    housing_ids.sort();

    let mut added_resident = false;
    for building_id in housing_ids {
        let Some(building) = state
            .buildings
            .iter()
            .find(|building| building.id == building_id)
            .cloned()
        else {
            continue;
        };
        let Some(definition) = building_definition(&building.building_type) else {
            continue;
        };
        let Some(tile_count) =
            (!building.occupied_tiles.is_empty()).then_some(building.occupied_tiles.len())
        else {
            continue;
        };
        let capacity = usize::from(definition.resident_capacity);
        let mut occupancy = resident_occupancy(state, &building);

        while occupancy < capacity {
            let due = building.placed_at + occupancy as f64 * MOVE_IN_INTERVAL_SECONDS;
            if due > state.time {
                break;
            }

            let sim_id = next_entity_id("sim", state.sims.iter().map(|sim| sim.id.clone()));
            let home = building.occupied_tiles[occupancy % tile_count];
            let worker_profile = worker_profile_for_id(&sim_id);
            let shift_template = shift_template_for_id(&sim_id).map(str::to_string);
            let outbound_resolved_today = shift_template.as_deref().is_some_and(|template| {
                let departure = departure_minute_for_sim(&sim_id, template, "outbound");
                state.time > scheduled_time_seconds(state.day, departure)
            });

            state.sims.push(Sim {
                id: sim_id,
                home,
                position: home,
                worker_profile,
                shift_template,
                workplace: None,
                commute_day: state.day,
                outbound_resolved_today,
                outbound_arrived_today: false,
                return_resolved_today: false,
                returned_home_today: false,
            });
            occupancy += 1;
            added_resident = true;
        }
    }

    if added_resident {
        assign_workplaces(state);
    }
}

fn scheduled_time_seconds(day: u32, minute: u16) -> f64 {
    f64::from(day) * GAME_DAY_SECONDS
        + (f64::from(minute) / f64::from(MINUTES_PER_DAY)) * GAME_DAY_SECONDS
}

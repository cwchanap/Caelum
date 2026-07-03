use crate::areas;
use crate::buildings;
use crate::model::{GameSnapshot, GrowthAction};

/// Apply every growth wave whose `trigger_time` has arrived, in declared order,
/// by replaying its actions through the engine's own handlers. Placements are
/// budget-exempt (`place_building_core`): a wave is the world growing, not the
/// player spending. Idempotent via each wave's `applied` flag. A wave whose
/// action is invalid at fire time (e.g. an unzoned placement) skips that action
/// deterministically, exactly as a player's invalid click is a no-op.
pub fn apply_due_growth_waves(state: &mut GameSnapshot) {
    let due: Vec<usize> = state
        .scenario
        .growth_waves
        .iter()
        .enumerate()
        .filter(|(_, wave)| !wave.applied && wave.trigger_time <= state.time)
        .map(|(index, _)| index)
        .collect();
    if due.is_empty() {
        return;
    }

    for index in due {
        let actions = state.scenario.growth_waves[index].actions.clone();
        for action in actions {
            match action {
                GrowthAction::PaintAreaRectangle { area, start, end } => {
                    if let Some(next) = areas::paint_area_rectangle(state, &area, &start, &end) {
                        *state = next;
                    }
                }
                GrowthAction::PlaceBuilding {
                    building_type,
                    origin,
                    rotation,
                } => {
                    if let Ok(next) =
                        buildings::place_building_core(state, &building_type, &origin, rotation)
                    {
                        *state = next;
                    }
                }
            }
        }
        state.scenario.growth_waves[index].applied = true;
    }
}

#[cfg(test)]
mod tests {
    use crate::model::{GameSnapshot, GrowthAction, GrowthWave, Point};
    use crate::scenario::growing_suburb_growth_waves;
    use crate::state::create_initial_snapshot;
    use crate::trips;

    fn seeded() -> GameSnapshot {
        let mut state = create_initial_snapshot();
        state.paused = false;
        state.scenario.growth_waves = growing_suburb_growth_waves();
        state
    }

    #[test]
    fn seed_wave_zones_places_houses_and_spawns_sims() {
        let start = seeded();
        let budget_before = start.budget;
        let next = trips::tick_trips(&start, 1.0);

        assert_eq!(next.buildings.len(), 5, "5 smallHouse units placed");
        assert_eq!(next.sims.len(), 20, "5 units * 4 citizens");
        assert!(next.scenario.growth_waves[0].applied);
        assert_eq!(next.budget, budget_before, "budget-exempt world growth");
        assert_eq!(next.sims[0].id, "sim-001");
        assert_eq!(next.sims[19].id, "sim-020");

        let anchor = next
            .map
            .tiles
            .iter()
            .find(|tile| tile.x == 2 && tile.y == 3)
            .expect("anchor tile exists");
        assert_eq!(anchor.area.as_deref(), Some("residential"));
    }

    #[test]
    fn application_is_idempotent() {
        let once = trips::tick_trips(&seeded(), 1.0);
        let twice = trips::tick_trips(&once, 1.0);
        assert_eq!(twice.buildings.len(), once.buildings.len());
        assert_eq!(twice.sims.len(), once.sims.len());
    }

    #[test]
    fn empty_growth_waves_is_a_noop() {
        let mut start = create_initial_snapshot();
        start.paused = false;
        let next = trips::tick_trips(&start, 1.0);
        assert!(next.buildings.is_empty());
        assert!(next.sims.is_empty());
    }

    #[test]
    fn coarse_and_fine_ticks_produce_identical_growth() {
        let start = seeded();
        let coarse = trips::tick_trips(&start, 5.0);
        let mut fine = start.clone();
        for _ in 0..5 {
            fine = trips::tick_trips(&fine, 1.0);
        }
        assert_eq!(coarse.buildings, fine.buildings);
        assert_eq!(coarse.sims, fine.sims);
        assert_eq!(coarse.map, fine.map);
    }

    #[test]
    fn placement_without_zoning_is_skipped_but_wave_marked_applied() {
        let mut start = create_initial_snapshot();
        start.paused = false;
        start.scenario.growth_waves = vec![GrowthWave {
            id: "w".to_string(),
            trigger_time: 0.0,
            message: String::new(),
            applied: false,
            actions: vec![GrowthAction::PlaceBuilding {
                building_type: "smallHouse".to_string(),
                origin: Point { x: 2, y: 3 },
                rotation: 0,
            }],
        }];
        let next = trips::tick_trips(&start, 1.0);
        assert!(next.buildings.is_empty(), "unzoned placement skipped");
        assert!(next.scenario.growth_waves[0].applied);
    }
}

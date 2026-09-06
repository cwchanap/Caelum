use crate::areas;
use crate::buildings;
use crate::model::{GameMode, GameSnapshot, GrowthAction};

/// Apply every growth wave whose `trigger_time` has arrived, in declared order,
/// by replaying its actions through the engine's own handlers. Placements are
/// budget-exempt (`place_building_core`): a wave is the world growing, not the
/// player spending. Idempotent via each wave's `applied` flag. A wave whose
/// action is invalid at fire time (e.g. an unzoned placement) skips that action
/// deterministically, exactly as a player's invalid click is a no-op.
pub fn apply_due_growth_waves(state: &mut GameSnapshot) {
    if state.rules.game_mode != GameMode::Campaign {
        return;
    }

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
                    if let Ok(next) = areas::paint_area_rectangle(state, &area, &start, &end) {
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
    use crate::engine::GameEngine;
    use crate::intent::GameIntent;
    use crate::model::{GameSnapshot, GrowthAction, GrowthWave, Point};
    use crate::scenario::{
        growing_suburb_campaign, growing_suburb_growth_waves, growing_suburb_objectives,
    };
    use crate::state::create_initial_snapshot;

    fn campaign_with_waves(waves: Vec<GrowthWave>) -> GameSnapshot {
        let mut state = create_initial_snapshot();
        let (rules, scenario) = growing_suburb_campaign(growing_suburb_objectives(), waves);
        state.rules = rules;
        state.scenario = scenario;
        state.paused = false;
        state
    }

    /// Build a resumable engine from the prepared campaign/sandbox fixture.
    /// `from_snapshot` canonicalizes shell fields (paused, clock) and compiles
    /// the road topology, exactly as the persistence boundary would.
    fn running_engine(snapshot: GameSnapshot) -> GameEngine {
        let mut engine =
            GameEngine::from_snapshot(snapshot).expect("fixture must be persistence-valid");
        let resumed = engine.dispatch(GameIntent::SetPaused { paused: false });
        assert!(resumed.applied, "fixture must resume: {resumed:?}");
        assert!(resumed.rejection.is_none());
        engine
    }

    fn seeded() -> GameSnapshot {
        campaign_with_waves(growing_suburb_growth_waves())
    }

    #[test]
    fn sandbox_attached_growth_waves_remain_unapplied() {
        let mut start = create_initial_snapshot();
        start.paused = false;
        start.scenario.growth_waves = growing_suburb_growth_waves();

        let mut engine = running_engine(start);
        let result = engine.tick(1.0);
        assert!(result.rejection.is_none());
        let next = engine.snapshot();

        assert!(next.buildings.is_empty());
        assert!(next.sims.is_empty());
        assert!(!next.scenario.growth_waves[0].applied);
    }

    #[test]
    fn campaign_without_objectives_still_applies_growth() {
        let mut start = campaign_with_waves(growing_suburb_growth_waves());
        start.scenario.objectives = None;

        let mut engine = running_engine(start);
        let result = engine.tick(1.0);
        assert!(result.rejection.is_none());
        let next = engine.snapshot();

        assert_eq!(next.buildings.len(), 5);
        assert!(next.scenario.growth_waves[0].applied);
    }

    #[test]
    fn seed_wave_zones_places_houses_without_immediate_sims() {
        let start = seeded();
        let budget_before = start.budget;

        let mut engine = running_engine(start);
        let result = engine.tick(1.0);
        assert!(result.rejection.is_none());
        let next = engine.snapshot();

        assert_eq!(next.buildings.len(), 5, "5 smallHouse units placed");
        assert_eq!(
            next.sims.len(),
            0,
            "Campaign growth places housing without Sandbox move-ins"
        );
        assert!(next.scenario.growth_waves[0].applied);
        assert_eq!(next.budget, budget_before, "budget-exempt world growth");

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
        let mut engine = running_engine(seeded());
        let result = engine.tick(1.0);
        assert!(result.rejection.is_none());
        let once = engine.snapshot();
        engine.tick(1.0);
        let twice = engine.snapshot();
        assert_eq!(twice.buildings.len(), once.buildings.len());
        assert_eq!(twice.sims.len(), once.sims.len());
    }

    #[test]
    fn empty_growth_waves_is_a_noop() {
        let mut start = create_initial_snapshot();
        start.paused = false;

        let mut engine = running_engine(start);
        let result = engine.tick(1.0);
        assert!(result.rejection.is_none());
        let next = engine.snapshot();
        assert!(next.buildings.is_empty());
        assert!(next.sims.is_empty());
    }

    #[test]
    fn coarse_and_fine_ticks_produce_identical_growth() {
        let mut coarse = running_engine(seeded());
        coarse.tick(5.0);
        let coarse_snapshot = coarse.snapshot();

        let mut fine = running_engine(seeded());
        for _ in 0..5 {
            fine.tick(1.0);
        }
        let fine_snapshot = fine.snapshot();

        assert_eq!(coarse_snapshot.buildings, fine_snapshot.buildings);
        assert_eq!(coarse_snapshot.sims, fine_snapshot.sims);
        assert_eq!(coarse_snapshot.map, fine_snapshot.map);
    }

    #[test]
    fn placement_without_zoning_is_skipped_but_wave_marked_applied() {
        let start = campaign_with_waves(vec![GrowthWave {
            id: "w".to_string(),
            trigger_time: 0.0,
            message: String::new(),
            applied: false,
            actions: vec![GrowthAction::PlaceBuilding {
                building_type: "smallHouse".to_string(),
                origin: Point { x: 2, y: 3 },
                rotation: 0,
            }],
        }]);

        let mut engine = running_engine(start);
        let result = engine.tick(1.0);
        assert!(result.rejection.is_none());
        let next = engine.snapshot();
        assert!(next.buildings.is_empty(), "unzoned placement skipped");
        assert!(next.scenario.growth_waves[0].applied);
    }

    /// Multiple waves can fall due within a single tick — either at distinct
    /// trigger times or sharing the same trigger time. The cap math
    /// (`growth_waves.len()` term in `max_tick_substeps`) and the ordered-due
    /// collection in `apply_due_growth_waves` handle this, but it was previously
    /// unverified. This test fires three waves (two sharing t=50, one at t=150)
    /// in one 300s coarse tick and confirms all fire in declared order without
    /// the substep cap truncating the tick.
    #[test]
    fn multiple_waves_in_one_tick_all_fire_in_declared_order() {
        let start = campaign_with_waves(vec![
            GrowthWave {
                id: "wave-a".to_string(),
                trigger_time: 50.0,
                message: String::new(),
                applied: false,
                actions: vec![
                    GrowthAction::PaintAreaRectangle {
                        area: "residential".to_string(),
                        start: Point { x: 2, y: 3 },
                        end: Point { x: 3, y: 3 },
                    },
                    GrowthAction::PlaceBuilding {
                        building_type: "smallHouse".to_string(),
                        origin: Point { x: 2, y: 3 },
                        rotation: 0,
                    },
                ],
            },
            GrowthWave {
                id: "wave-b".to_string(),
                trigger_time: 50.0,
                message: String::new(),
                applied: false,
                actions: vec![
                    GrowthAction::PaintAreaRectangle {
                        area: "residential".to_string(),
                        start: Point { x: 6, y: 3 },
                        end: Point { x: 7, y: 3 },
                    },
                    GrowthAction::PlaceBuilding {
                        building_type: "smallHouse".to_string(),
                        origin: Point { x: 6, y: 3 },
                        rotation: 0,
                    },
                ],
            },
            GrowthWave {
                id: "wave-c".to_string(),
                trigger_time: 150.0,
                message: String::new(),
                applied: false,
                actions: vec![
                    GrowthAction::PaintAreaRectangle {
                        area: "residential".to_string(),
                        start: Point { x: 2, y: 11 },
                        end: Point { x: 3, y: 11 },
                    },
                    GrowthAction::PlaceBuilding {
                        building_type: "smallHouse".to_string(),
                        origin: Point { x: 2, y: 11 },
                        rotation: 0,
                    },
                ],
            },
        ]);

        let mut engine = running_engine(start);
        let result = engine.tick(300.0);
        assert!(result.rejection.is_none());
        let next = engine.snapshot();

        // All three waves fired.
        assert!(next.scenario.growth_waves[0].applied, "wave-a applied");
        assert!(next.scenario.growth_waves[1].applied, "wave-b applied");
        assert!(next.scenario.growth_waves[2].applied, "wave-c applied");

        // Three buildings placed; Campaign growth does not run Sandbox move-ins.
        assert_eq!(next.buildings.len(), 3, "3 smallHouse units placed");
        assert_eq!(next.sims.len(), 0, "Campaign growth has no immediate sims");

        // The tick was not truncated — reached the full 300s.
        assert_eq!(
            next.time, 300.0,
            "tick reached full duration without cap truncation"
        );
    }

    /// A wave whose `trigger_time` falls mid-tick (not at t=0) must fire at
    /// exactly that instant regardless of tick granularity. This exercises
    /// Decision B's boundary tracking in `next_boundary_after` — the substep
    /// machinery breaks at `trigger_time`, applies the wave, then continues —
    /// which none of the `trigger_time: 0.0` tests above cover.
    #[test]
    fn mid_tick_wave_fires_at_boundary_regardless_of_granularity() {
        // Reuse the seed wave's actions but defer the trigger to t=120 so the
        // wave fires inside a 300s coarse tick, not at its start.
        let mut seed_waves = growing_suburb_growth_waves();
        seed_waves[0].trigger_time = 120.0;

        let start = campaign_with_waves(seed_waves);

        // Coarse: one 300s tick spanning well past the 120s trigger.
        let mut coarse = running_engine(start.clone());
        coarse.tick(300.0);
        let coarse_snapshot = coarse.snapshot();

        // Fine: 300 × 1s ticks; the wave fires on the 120th tick.
        let mut fine = running_engine(start);
        for _ in 0..300 {
            fine.tick(1.0);
        }
        let fine_snapshot = fine.snapshot();

        assert!(
            coarse_snapshot.scenario.growth_waves[0].applied,
            "coarse tick applied the mid-tick wave"
        );
        assert!(
            fine_snapshot.scenario.growth_waves[0].applied,
            "fine ticks applied the mid-tick wave"
        );
        assert_eq!(
            coarse_snapshot.buildings, fine_snapshot.buildings,
            "buildings match"
        );
        assert_eq!(
            coarse_snapshot.sims, fine_snapshot.sims,
            "spawned sims match"
        );
        assert_eq!(coarse_snapshot.map, fine_snapshot.map, "map/zoning match");
        assert_eq!(
            coarse_snapshot.time, fine_snapshot.time,
            "both reach the same simulated time"
        );
    }
}

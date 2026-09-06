//! Stage-A release-scale structural and granularity gate for the live ECS
//! Worker population. Not part of the default debug test run — execute with:
//!
//! ```bash
//! cargo test --release -p caelum-core --test population_scale -- --ignored --nocapture
//! ```

use std::collections::HashSet;

use caelum_core::building_catalog::building_definition;
use caelum_core::commute::{shift_template_for_id, worker_profile_for_id};
use caelum_core::model::{GameSnapshot, Point, Sim, TripPurpose, WorkerProfile};
use caelum_core::{create_sandbox_snapshot, GameEngine, GameIntent, SandboxCreationRequest};

const TOTAL: usize = 200_000;
const DUE: usize = 1_000;

/// The tick window: standard/early/late/offPeak outbound departures on day 0
/// all land inside `[275, 725]` game seconds, so `[270, 730]` covers every
/// due wake and no day-1 wake (>= 1475).
const WINDOW_START: f64 = 270.0;
const WINDOW_END: f64 = 730.0;

/// One 200k-worker fixture. Profiles and shift templates are derived from the
/// sim ids exactly like the durable snapshot normalization, so the fixture
/// matches what `from_snapshot` canonically loads. With `all_future == false`,
/// the first `DUE` derived Workers carry `commute_day == 0` and become due
/// inside the window; every other citizen is future-scheduled on day 1.
fn scale_snapshot(all_future: bool) -> GameSnapshot {
    let mut snapshot = create_sandbox_snapshot(SandboxCreationRequest {
        template_id: "smallTown".to_string(),
        economy_preset: "standard".to_string(),
        starting_capital: Some(f64::from(caelum_core::DEFAULT_STARTING_CAPITAL)),
        demand_multiplier: Some(1.0),
    })
    .expect("small town template must remain valid");
    snapshot.day = 0;
    snapshot.time = 0.0;
    snapshot.paused = true;
    snapshot.speed = 1;

    let job_tile = snapshot
        .buildings
        .iter()
        .find(|building| {
            building_definition(&building.building_type)
                .is_some_and(|definition| definition.job_capacity > 0)
        })
        .map(|building| building.occupied_tiles[0])
        .expect("small town template must contain a job building");
    // Drop template housing so its deterministic move-ins cannot disturb the
    // quiet interval; the job building stays as the workers' destination.
    snapshot.buildings.retain(|building| {
        building_definition(&building.building_type)
            .is_some_and(|definition| definition.resident_capacity == 0)
    });

    let mut due_workers = 0usize;
    snapshot.sims = (1..=TOTAL)
        .map(|index| {
            let id = format!("sim-{index:06}");
            let worker_profile = worker_profile_for_id(&id);
            let shift_template = shift_template_for_id(&id);
            let due = !all_future && worker_profile == WorkerProfile::Worker && {
                due_workers += 1;
                due_workers <= DUE
            };
            let home = Point::from(((index % 8) as i32, ((index / 8) % 8) as i32));
            Sim {
                id,
                home,
                position: home,
                worker_profile,
                shift_template: shift_template.map(str::to_string),
                workplace: (worker_profile == WorkerProfile::Worker).then_some(job_tile),
                commute_day: if due { 0 } else { 1 },
                outbound_resolved_today: false,
                outbound_arrived_today: false,
                return_resolved_today: false,
                returned_home_today: false,
            }
        })
        .collect();
    snapshot
}

fn active_trip_identity(trip: &caelum_core::model::ActiveTrip) -> (String, String, TripPurpose) {
    (trip.id.clone(), trip.sim_id.clone(), trip.purpose)
}

fn running_engine(all_future: bool) -> GameEngine {
    let mut engine = GameEngine::from_snapshot(scale_snapshot(all_future)).expect("fixture loads");
    assert!(
        engine
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );
    engine
}

#[test]
#[ignore]
fn stage_a_two_hundred_thousand_worker_engine_structural_and_granularity() {
    let span = WINDOW_END - WINDOW_START;

    let mut coarse = running_engine(false);
    let mut fine = running_engine(false);

    // Advance both engines to the window start (all wakes are future there).
    let _ = coarse.tick(WINDOW_START);
    let _ = fine.tick(WINDOW_START);

    let _ = coarse.tick(span);
    // Equivalent fine ticks over the same interval.
    let fine_steps = 23;
    for _ in 0..fine_steps {
        let _ = fine.tick(span / f64::from(fine_steps));
    }

    let coarse_snapshot = coarse.snapshot();
    let fine_snapshot = fine.snapshot();

    assert_eq!(coarse_snapshot.sims.len(), 200_000);
    assert_eq!(fine_snapshot.sims.len(), 200_000);

    // Only the 1_000 due Workers produced demand: every produced trip is
    // either still active with a due-set sim id, or already terminal — and
    // their count is exactly DUE. The due set is the first DUE derived Worker
    // ordinals (every 10th id is a canonical NonWorker and is skipped).
    let mut due_ordinals = Vec::with_capacity(DUE);
    for index in 1..=TOTAL {
        if worker_profile_for_id(&format!("sim-{index:06}")) == WorkerProfile::Worker {
            due_ordinals.push(index);
            if due_ordinals.len() == DUE {
                break;
            }
        }
    }
    let due_ids: HashSet<String> = due_ordinals
        .iter()
        .map(|index| format!("sim-{index:06}"))
        .collect();
    assert!(coarse_snapshot.active_trips.len() <= DUE);
    for trip in &coarse_snapshot.active_trips {
        assert!(due_ids.contains(&trip.sim_id), "unexpected trip {trip:?}");
        assert_eq!(trip.purpose, TripPurpose::CommuteOutbound);
    }
    let resolved = coarse_snapshot.metrics.completed_trips + coarse_snapshot.metrics.unserved_trips;
    assert_eq!(
        (resolved as usize) + coarse_snapshot.active_trips.len(),
        DUE,
        "exactly the 1_000 due Workers produced demand/trips"
    );

    // Granularity equivalence at the same semantic level as the existing
    // partition-independence tests (tests/population.rs): identical citizen
    // state, identical trip identity, identical service metrics, and the same
    // final timestamp. Bit-identical full snapshots are not achievable across
    // different tick partitions — walk-leg positions feed back into substep
    // boundary times, so ulp-level float divergence is inherent to f64 time
    // accumulation — which is why no existing granularity test asserts it.
    assert_eq!(coarse_snapshot.sims, fine_snapshot.sims);
    assert_eq!(
        coarse_snapshot
            .active_trips
            .iter()
            .map(active_trip_identity)
            .collect::<Vec<_>>(),
        fine_snapshot
            .active_trips
            .iter()
            .map(active_trip_identity)
            .collect::<Vec<_>>()
    );
    assert_eq!(
        coarse_snapshot
            .metrics
            .trip_outcomes
            .iter()
            .map(|outcome| (outcome.outcome, outcome.wait_seconds))
            .collect::<Vec<_>>(),
        fine_snapshot
            .metrics
            .trip_outcomes
            .iter()
            .map(|outcome| (outcome.outcome, outcome.wait_seconds))
            .collect::<Vec<_>>()
    );
    let coarse_metrics = &coarse_snapshot.metrics;
    let fine_metrics = &fine_snapshot.metrics;
    assert_eq!(coarse_metrics.late_trips, fine_metrics.late_trips);
    assert_eq!(coarse_metrics.completed_trips, fine_metrics.completed_trips);
    assert_eq!(coarse_metrics.unserved_trips, fine_metrics.unserved_trips);
    assert_eq!(
        coarse_metrics.total_wait_seconds,
        fine_metrics.total_wait_seconds
    );
    assert_eq!(
        coarse_metrics.waiting_trip_count,
        fine_metrics.waiting_trip_count
    );
    assert!(
        (coarse_snapshot.time - fine_snapshot.time).abs() <= 1e-6,
        "coarse {} vs fine {}",
        coarse_snapshot.time,
        fine_snapshot.time
    );

    // Quiet interval: an engine whose 200k Workers are all future-scheduled
    // must pass the same interval with no trip or population mutation.
    let mut quiet = running_engine(true);
    let _ = quiet.tick(WINDOW_START);
    let before = quiet.snapshot();
    let result = quiet.tick(span);
    let after = quiet.snapshot();
    assert_eq!(after.active_trips, before.active_trips);
    assert!(after.active_trips.is_empty());
    assert_eq!(after.sims, before.sims);
    assert_eq!(after.metrics.completed_trips, 0);
    assert_eq!(after.metrics.unserved_trips, 0);
    assert!(
        after.time > before.time,
        "quiet tick still advances time: {:?}",
        result.update.frame.time
    );
}

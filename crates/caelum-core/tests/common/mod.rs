//! Shared fixtures for `caelum-core` integration tests.
//!
//! Each integration test file is compiled as its own crate, so shared helpers
//! live here and are pulled in via `mod common;` (with `#[path]` when the test
//! file is not directly under `tests/`).

use caelum_core::scenario::{growing_suburb_campaign, growing_suburb_objectives};
use caelum_core::state::create_initial_snapshot;
use caelum_core::GameSnapshot;

/// A campaign-mode `GameSnapshot` for the Growing Suburb scenario with the
/// default objective thresholds and no growth waves. Used by integration tests
/// that need to exercise the campaign objective/metrics path.
pub fn campaign_state() -> GameSnapshot {
    let mut state = create_initial_snapshot();
    let (rules, scenario) = growing_suburb_campaign(growing_suburb_objectives(), Vec::new());
    state.rules = rules;
    state.scenario = scenario;
    state
}

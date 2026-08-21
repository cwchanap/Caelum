# HPA-335 Phase 5 Closeout Design

**Linear:** HPA-335  
**Completed implementation slices:** HPA-643, HPA-645, HPA-646  
**Roadmap parent:** HPA-330  
**Future phase:** HPA-336

## Goal

Close Phase 5 from the behavior that is already merged instead of inventing another diagnostics or economy feature merely because the coordination parent is still open.

HPA-335 asked for the smallest complete operations/economy loop:

- one actionable operational diagnosis;
- one understandable operating-cost signal;
- Standard may become negative without ending the sandbox;
- Creative remains budget-neutral;
- no generic diagnostics, accounting, history, or undo platform unless later evidence justifies one.

Those product slices now exist on `main` through HPA-643, HPA-645, and HPA-646. The remaining work is evidence-driven closeout: verify the merged seams still satisfy the parent exit criteria together, record that evidence in Linear, and mark HPA-335 Done.

This closeout adds **no new gameplay behavior** by default.

## Verified baseline

### HPA-643: one actionable operations diagnosis

HPA-643 added exactly one passenger-facing route-health diagnosis to the existing Lines row:

- Rust-owned `waitingAtRiskCount` and `longestWaitSeconds`;
- only platform-servable waiters participate;
- the warning is shown only for a running service with at-risk riders;
- when the existing HPA-628 shortfall offer exists, the warning points to the existing `Add bus` / `Add train` action;
- no findings framework, history buffer, automatic optimization, or new gameplay command was introduced.

The current `crates/caelum-core/tests/service_control.rs::add_service_vehicle_fills_bus_shortfall_without_repositioning_existing_fleet` integration test already proves the important composition seam on one snapshot:

1. `waiting_at_risk_count == 1`;
2. `next_vehicle_cost == Some(BUS_COST)`;
3. the route has a real required-vs-assigned fleet shortfall;
4. `AddServiceVehicle` applies;
5. assigned fleet increases by one without moving existing vehicles;
6. budget is charged once;
7. the live top-up offer disappears after the requirement is satisfied.

That is enough for the HPA-335 action-response criterion. Adding a vehicle cannot make an already-waiting passenger's elapsed wait decrease instantaneously; the passenger metric can change only after simulation time advances and service reaches riders. Requiring a new browser or integration test that waits for `waitingAtRiskCount` itself to fall would conflate an immediate service-control response with a later passenger outcome and would recreate the transient-fixture complexity HPA-643 deliberately avoided.

For closeout, the immediate response is the authoritative service state: fleet changes and the recovery offer disappears. The health warning remains a current observation until simulation outcomes actually change it.

### HPA-645: one understandable operating-cost signal

HPA-645 added one concrete recurring-cost rule and one player-facing cost surface:

- Bus: `$400 / vehicle / game day`;
- Metro: `$2,500 / vehicle / game day`;
- deployed services publish actual `dailyOperatingCost`;
- zero-fleet targeted services publish `estimatedDailyOperatingCost`;
- Lines renders per-service actual/estimated cost;
- Topbar renders the current city-wide actual `Daily cost`;
- Standard deducts once at the existing midnight boundary and may go below zero;
- Creative publishes nominal values without deducting budget.

No ledger, proration, accounting period, recurring-cost framework, or finance dashboard was added.

The current service-control regression suite locks both the operational projection and the budget semantics, including `standard_daily_operating_cost_crosses_budget_below_zero_at_midnight`, `creative_keeps_budget_across_midnight`, actual-vs-estimated projection, paused-route behavior, and coarse-vs-split day-boundary determinism.

### HPA-646: minimal positive cash-flow recovery

HPA-646 followed the required HPA-645 risk with the smallest positive cash-flow rule:

- `$200` once per newly completed `Arrived`/`Late` journey whose terminal `RoutePlan` used Bus or Metro;
- transfers still earn once per journey, not once per boarding or line;
- Standard credits budget immediately at trip resolution with saturating addition;
- Creative remains budget-neutral;
- walking-only, private-car/planless, unserved, and non-terminal trips earn zero;
- a restored trip that was already terminal is not re-credited.

The existing Topbar budget readout makes the settlement player-visible without a new revenue field. HPA-646 intentionally remains a recovery path, not universal negative-budget protection: deleting the last fleet while negative or going negative before demand exists can still strand a city. Those are playtest-triggered follow-ups, not Phase 5 exit requirements.

`crates/caelum-core/src/transit_income.rs`, the focused `trips.rs` regressions, and the real bus lifecycle coverage in `crates/caelum-core/tests/trip_lifecycle.rs` already lock qualification, negative-budget recovery, one-shot settlement, real alight plan retention, and coarse-vs-split final budget equality.

## Approaches considered

### A. Close Phase 5 with focused re-verification — chosen

Re-run the existing authoritative tests and player-surface suites on current `main`, record the evidence in HPA-335, and mark the coordination parent Done.

Advantages:

- closes the roadmap based on shipped behavior rather than ticket count;
- adds no redundant production abstraction or test fixture;
- keeps HPA-335's evidence-triggered boundary intact;
- makes the next product decision explicit instead of silently starting campaign work.

### B. Add one large multi-day browser scenario — rejected

A new Playwright scenario that manufactures long waits, triggers a top-up, crosses midnight, and then generates a completed transit journey would duplicate deterministic Rust ownership across several unrelated timing seams. It would be slower and more fragile than the existing focused Rust, UI, and browser coverage, while proving no new player capability.

Use the current test pyramid for closeout. Add a new end-to-end scenario only when a real integration defect or missing player journey is observed.

### C. Add route-delete refunds or a profit dashboard before closeout — rejected

HPA-646 explicitly records the negative-budget route-deletion trap as a possible follow-up **if playtesting confirms it is common**. HPA-335 also treats history, extra diagnostics, additional recurring costs, and undo/redo as evidence-triggered candidates rather than required scope.

Adding any of them now would violate the parent design rule: every module or field must have a current player-facing need.

## HPA-335 exit-criteria mapping

| HPA-335 exit criterion | Current evidence | Closeout decision |
| --- | --- | --- |
| At least one operational view leads to a specific player action and responds after that action | HPA-643 Lines warning + existing `AddServiceVehicle`; service-control integration proves shortfall offer, mutation, increased fleet, and offer removal | Satisfied |
| Financial feedback changes a real service-planning choice | HPA-645 shows pre-deployment estimated cost and deployed daily burn per service, plus city-wide Daily cost | Satisfied |
| Standard may become negative without ending sandbox | HPA-645 midnight regression reaches `-1` while metrics remain Running | Satisfied |
| Creative remains budget-neutral | HPA-645 operating cost and HPA-646 income both preserve Creative budget | Satisfied |
| History/undo/additional metrics only if separately justified | None were added | Satisfied |
| Stored history remains bounded/deterministic where implemented | No Phase 5 history exists; timing and settlement have coarse-vs-split deterministic tests | Satisfied |
| Every field/module has a current player consumer; no generic framework | Route-health fields feed Lines; cost fields feed Lines/Topbar; income mutates existing budget; no generic diagnostics/economy framework | Satisfied |

## Closeout verification rule

The closeout execution does not add new tests first. It re-runs the tests that already own each contract plus the normal frontend/browser suites.

If all are green, HPA-335 is complete.

If verification exposes a real regression on current `main`, do **not** expand this closeout into a new subsystem. Keep HPA-335 open and route the concrete defect to one bounded bug/fix task. The closeout remains coordination work rather than becoming a catch-all implementation ticket.

## Linear closeout

After verification:

1. add one HPA-335 comment mapping the three merged children to the exit criteria and recording the final commands/results;
2. mark HPA-335 Done;
3. leave HPA-330 unchanged as the roadmap parent;
4. leave HPA-336 in Backlog.

Completing HPA-335 removes its dependency relationship from HPA-336, but it does **not** make HPA-336 actionable by itself. HPA-336 has independent activation gates, including real-player sandbox testing and an explicit product decision that campaign/authored challenges are now a priority. This closeout does not claim those gates are met.

The next product action after HPA-335 should therefore be playtesting / prioritization, not automatic campaign implementation.

## Repository impact

The planning PR contains only this design and its implementation plan.

The closeout execution itself is expected to require:

- no Rust production changes;
- no TypeScript/Svelte production changes;
- no schema/storage change;
- no new dependency;
- no new automated test unless verification finds a concrete missing regression;
- one Linear evidence comment and status transition.

This makes the planning PR the only repository PR associated with the HPA-335 closeout.

## Non-goals

- New diagnostics, route-health metrics, severity levels, alert infrastructure, or findings engine.
- New operating-cost categories, fares, route profitability, ledgers, accounting periods, taxes, loans, or bankruptcy rules.
- Route-delete vehicle refunds without playtest evidence.
- Stop/station or road diagnostics.
- Day-over-day history.
- Undo/redo or command history.
- A new all-in-one Phase 5 browser fixture.
- Campaign/scenario implementation or reactivation of dormant campaign architecture.
- Save migration, compatibility adapters, or security-hardening work.

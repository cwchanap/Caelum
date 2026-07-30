# HPA-338 Standard and Creative Cost Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every existing player purchase through one Rust-owned Standard/Creative cost policy so Creative keeps nominal prices but never fails or deducts solely for budget, while Standard behavior remains unchanged.

**Architecture:** Add a transient `cost_policy` module keyed from the active snapshot's `EconomyPreset`. Paid domain mutations return an internal snapshot-plus-nominal-cost result to the engine, while existing public snapshot-returning Rust helpers remain compatibility wrappers. The engine carries nominal cost explicitly into dispatch context; road and route previews call the same authoritative policy paths. TypeScript only shares one read-only building-hover affordability predicate, and WASM/Tauri remain pass-through hosts.

**Tech Stack:** Rust 2021, Serde, Tauri 2, wasm-bindgen/serde-wasm-bindgen, TypeScript, Bun, Vitest.

## Global Constraints

- Rust remains the only authority that authorizes a purchase or changes a budget.
- `CostPolicy` is derived from `snapshot.rules.economy_preset` for each operation; it is never serialized or cached by an engine or host.
- Standard preserves current prices, affordability checks, deduction amounts, rejection payloads, rejection precedence, and partial-stroke behavior.
- Creative bypasses only affordability and deduction. Nominal cost remains positive and every non-budget validation still runs.
- Atomic purchases remain all-or-nothing. Road and track strokes retain ordered partial application.
- Budget-first paths keep their current dual-failure precedence; geometry-first roundabout and route creation paths continue validating before affordability.
- `DispatchContext.cost` is the nominal successful purchase cost, not a budget delta. Free intents always report zero, including `SetBudget`.
- Existing public Rust helpers that currently return `GameplayResult<GameSnapshot>` remain available. Internal `*_costed` variants carry cost to `GameEngine` so a crate-private result type does not leak through the public API.
- `place_building_core()` remains cost-exempt for scenario/growth authoring.
- Existing price constants and building definitions remain where they are. Add drift guards; do not consolidate catalogs.
- Do not change schema version 4, snapshot fields, intent/response shapes, warning/rejection codes, host commands, or TypeScript backend wire types.
- Do not add host-side or TypeScript commit-policy branches.
- Preserve deterministic IDs, immutable snapshots, topology/snapshot atomicity, and existing Svelte 5 conventions.
- Run every shell command through `rtk`, as required by the repository instructions.

---

## File Map

- Add `crates/caelum-core/src/cost_policy.rs`: transient policy, quote, one-use authorized deduction, and internal costed mutation types.
- Modify `crates/caelum-core/src/lib.rs`: register the crate-private policy module.
- Modify `crates/caelum-core/src/engine.rs`: explicit nominal-cost context plumbing and cost-zero wrapping for free intents.
- Modify `crates/caelum-core/src/road.rs`: policy-aware single roads and ordered road strokes with explicit cost accumulation.
- Modify `crates/caelum-core/src/roundabouts.rs`: geometry-first policy authorization and budget-neutral Creative placement.
- Modify `crates/caelum-core/src/transit.rs`: policy-aware tracks, transit nodes, and vehicle assignment; retain public snapshot wrappers; add price-drift guards.
- Modify `crates/caelum-core/src/buildings.rs`: policy-aware player placement while keeping `place_building_core()` free.
- Modify `crates/caelum-core/src/route_editor.rs`: policy-aware implicit vehicle purchase for route creation.
- Modify `crates/caelum-core/src/preview.rs`: shared route quote and shared transit vehicle-price selector.
- Add `crates/caelum-core/tests/economy_cost_policy.rs`: cross-preset purchase matrix, nominal-cost checks, low-budget behavior, and deterministic world parity.
- Modify `crates/caelum-core/tests/engine_smoke.rs`: free-dispatch explicit-cost regression.
- Modify `crates/caelum-core/tests/road_authoring.rs`: ordered road stroke, duplicate, divergence, and parity coverage.
- Modify `crates/caelum-core/tests/transit_build.rs`: track stroke, transit-node, compatibility-path, and dual-failure coverage.
- Modify `crates/caelum-core/tests/roundabouts.rs`: both sizes, Creative preview/commit, and geometry-first rejection coverage.
- Modify `crates/caelum-core/tests/areas_buildings.rs`: ordinary building, terminal, compatibility, and core-helper behavior.
- Modify `crates/caelum-core/tests/route_editing.rs`: route creation and vehicle assignment policy/atomicity.
- Modify `crates/caelum-core/tests/route_preview.rs`: Standard/Creative route and road preview parity.
- Modify `crates/caelum-core/tests/persistence_determinism.rs`: restored Creative core behavior.
- Modify `src/render/placementValidation.ts`: one read-only building affordability helper.
- Modify `src/render/overlayRenderer.ts`: consume the shared presentation helper.
- Modify `src/render/cursorBadge.ts`: consume the same presentation helper.
- Modify `tests/render/placementValidation.test.ts`: helper and geometry-only contract.
- Modify `tests/render/overlayRenderer.test.ts`: Creative low-budget and invalid-geometry hover behavior.
- Modify `tests/render/cursorBadge.test.ts`: matching Creative badge behavior.
- Modify `tests/runtime/wasmArtifact.smoke.test.ts`: restored Creative real-WASM purchase proof.
- Modify `src-tauri/src/lib.rs`: restored Creative purchase through real Tauri IPC test only; production handlers stay unchanged.
- Verify `tests/runtime/backendContract.test.ts`: existing normalized dispatch/preview shapes still require no policy-specific field.
- Modify `docs/architecture.md`: document nominal-cost policy and host ownership.

---

### Task 1: Cost Policy Primitives and Explicit Engine Cost Plumbing

**Files:**

- Add: `crates/caelum-core/src/cost_policy.rs`
- Modify: `crates/caelum-core/src/lib.rs`
- Modify: `crates/caelum-core/src/engine.rs`
- Modify: `crates/caelum-core/src/transit.rs`
- Modify: `crates/caelum-core/src/buildings.rs`
- Modify: `crates/caelum-core/src/route_editor.rs`
- Modify: `crates/caelum-core/src/preview.rs`
- Test: `crates/caelum-core/tests/engine_smoke.rs`

**Interfaces:**

- Consumes: `EconomyPreset`, `GameSnapshot`, `GameplayRejection::budget()`.
- Produces:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CostPolicy {
    Standard,
    Creative,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CostQuote {
    nominal_cost: i32,
    available_budget: i32,
    affordable: bool,
    deduction: i32,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct AuthorizedCost {
    nominal_cost: i32,
    deduction: i32,
}

#[derive(Debug, PartialEq)]
pub(crate) struct CostedMutation {
    snapshot: GameSnapshot,
    cost: i32,
}
```

- Paid public helpers remain `GameplayResult<GameSnapshot>` wrappers around internal variants:

```rust
pub(crate) fn lay_track_costed(
    state: &GameSnapshot,
    point: &Point,
) -> GameplayResult<CostedMutation>;

pub(crate) fn lay_track_line_costed(
    state: &GameSnapshot,
    points: &[Point],
) -> GameplayResult<CostedMutation>;

pub(crate) fn add_bus_stop_costed(
    state: &GameSnapshot,
    point: &Point,
) -> GameplayResult<CostedMutation>;

pub(crate) fn add_metro_station_costed(
    state: &GameSnapshot,
    point: &Point,
) -> GameplayResult<CostedMutation>;

pub(crate) fn assign_vehicle_costed(
    state: &GameSnapshot,
    mode: &str,
    line_id: &str,
) -> GameplayResult<CostedMutation>;

pub(crate) fn place_building_costed(
    state: &GameSnapshot,
    building_type: &str,
    origin: &Point,
    rotation: u16,
) -> GameplayResult<CostedMutation>;

pub(crate) fn create_route_costed(
    state: &GameSnapshot,
    context: RoutingContext<'_>,
    mode: TransitMode,
    pattern: ServicePattern,
    waypoint_ids: Vec<String>,
) -> GameplayResult<CostedMutation>;
```

- [ ] **Step 1: Write failing policy and explicit-context tests**

Register `pub(crate) mod cost_policy;` in `lib.rs`. Create
`cost_policy.rs` with a `#[cfg(test)]` module that characterizes the complete
table before adding the implementation:

```rust
#[test]
fn standard_affordable_quote_deducts_the_full_nominal_cost_once() {
    let quote = CostPolicy::Standard.quote(500, 700);
    assert!(quote.affordable());
    assert_eq!(quote.nominal_cost(), 500);
    assert_eq!(quote.available_budget(), 700);

    let mut budget = 700;
    let reported = quote.authorize().unwrap().apply_to(&mut budget);
    assert_eq!(reported, 500);
    assert_eq!(budget, 200);
}

#[test]
fn standard_unaffordable_quote_returns_the_existing_budget_rejection() {
    let rejection = CostPolicy::Standard
        .quote(500, 499)
        .authorize()
        .unwrap_err();

    assert_eq!(rejection.code, RejectionCode::InsufficientBudget);
    assert_eq!(rejection.context.required_budget, Some(500));
    assert_eq!(rejection.context.available_budget, Some(499));
}

#[test]
fn creative_quote_is_affordable_reports_price_and_deducts_zero() {
    let quote = CostPolicy::Creative.quote(500, 0);
    assert!(quote.affordable());
    assert_eq!(quote.nominal_cost(), 500);

    let mut budget = 0;
    let reported = quote.authorize().unwrap().apply_to(&mut budget);
    assert_eq!(reported, 500);
    assert_eq!(budget, 0);
}

#[test]
fn zero_cost_is_affordable_and_budget_neutral_in_both_presets() {
    for policy in [CostPolicy::Standard, CostPolicy::Creative] {
        let mut budget = 0;
        let reported = policy
            .quote(0, budget)
            .authorize()
            .unwrap()
            .apply_to(&mut budget);
        assert_eq!(reported, 0);
        assert_eq!(budget, 0);
    }
}
```

In `engine_smoke.rs`, add the regression that exposes the current budget-delta
bug:

```rust
#[test]
fn set_budget_debug_intent_reports_zero_purchase_cost() {
    let mut engine = GameEngine::new();
    let result = engine.dispatch(GameIntent::SetBudget { budget: 7 });

    assert!(result.applied);
    assert_eq!(result.snapshot.budget, 7);
    assert_eq!(result.context.cost, 0);
}
```

- [ ] **Step 2: Run the focused tests and verify red**

Run:

```bash
rtk cargo test -p caelum-core cost_policy::tests
rtk cargo test -p caelum-core --test engine_smoke set_budget_debug_intent_reports_zero_purchase_cost -- --exact
```

Expected: the policy target fails to compile because the new types do not
exist; the engine regression reports the old positive budget delta instead of
zero.

- [ ] **Step 3: Implement the policy with one-use authorization**

Implement `CostPolicy::from_snapshot`, `CostPolicy::quote`, read-only quote
accessors, `CostQuote::authorize`, and consuming
`AuthorizedCost::apply_to`. Use the current snapshot budget supplied at quote
time and enforce the internal non-negative price invariant:

```rust
impl CostPolicy {
    pub(crate) fn from_snapshot(snapshot: &GameSnapshot) -> Self {
        match snapshot.rules.economy_preset {
            EconomyPreset::Standard => Self::Standard,
            EconomyPreset::Creative => Self::Creative,
        }
    }

    pub(crate) fn quote(self, nominal_cost: i32, available_budget: i32) -> CostQuote {
        debug_assert!(nominal_cost >= 0);
        let affordable =
            matches!(self, Self::Creative) || available_budget >= nominal_cost;
        CostQuote {
            nominal_cost,
            available_budget,
            affordable,
            deduction: if matches!(self, Self::Standard) {
                nominal_cost
            } else {
                0
            },
        }
    }
}

impl CostQuote {
    pub(crate) fn authorize(self) -> GameplayResult<AuthorizedCost> {
        if !self.affordable {
            return Err(GameplayRejection::budget(
                self.nominal_cost,
                self.available_budget,
            ));
        }
        Ok(AuthorizedCost {
            nominal_cost: self.nominal_cost,
            deduction: self.deduction,
        })
    }
}

impl AuthorizedCost {
    pub(crate) fn apply_to(self, budget: &mut i32) -> i32 {
        *budget -= self.deduction;
        self.nominal_cost
    }
}
```

Keep fields private. `AuthorizedCost` is not `Copy`; consuming `apply_to`
prevents accidental double deduction. Add `CostedMutation::new`,
`CostedMutation::free`, `into_snapshot`, and `into_parts`.

- [ ] **Step 4: Make dispatch context accept nominal cost explicitly**

Change the engine helper contract:

```rust
pub(crate) fn dispatch_context(
    before: &GameSnapshot,
    after: &GameSnapshot,
    requested_tiles: &[Point],
    cost: i32,
) -> DispatchContext {
    // Existing changed/skipped/affected-route derivation stays byte-for-byte.
    DispatchContext {
        changed_tiles,
        skipped_tiles,
        affected_route_ids:
            route_lifecycle::structurally_changed_route_ids(before, after),
        cost,
    }
}
```

Update `normalize_road_mutation_result()` to pass `result.cost` and retain it.
This is required for Creative roundabouts, whose correct nominal result would
otherwise be overwritten by a zero budget delta:

```rust
let context = dispatch_context(
    before,
    &result.snapshot,
    &requested_tiles,
    result.cost,
);
result.changed_tiles = context.changed_tiles;
result.skipped_tiles = context.skipped_tiles;
```

Do not assign `result.cost = context.cost` from a derived value.

- [ ] **Step 5: Thread `CostedMutation` through all three engine helpers**

Change `network_candidate_for_tiles()`, `commit_result()`, and
`commit_result_for_tiles()` to consume `GameplayResult<CostedMutation>`.
Extract `(snapshot, cost)` once and pass `cost` to `dispatch_context()`:

```rust
fn network_candidate_for_tiles(
    &self,
    result: GameplayResult<CostedMutation>,
    requested_tiles: &[Point],
) -> GameplayResult<NetworkCandidate> {
    result.map(|mutation| {
        let (snapshot, cost) = mutation.into_parts();
        let context =
            dispatch_context(&self.snapshot, &snapshot, requested_tiles, cost);
        let mut candidate = NetworkCandidate::plain(snapshot);
        candidate.context = context;
        candidate
    })
}
```

Apply the same extraction in `commit_result_for_tiles()`. Keep
reference-equality dispatch unchanged after extraction.

For this mechanical slice, introduce the internal `*_costed` paid helpers by
moving each current body into the costed variant and returning its existing
nominal price beside the snapshot. The public wrapper discards only the
reporting value:

```rust
pub fn lay_track(
    state: &GameSnapshot,
    point: &Point,
) -> GameplayResult<GameSnapshot> {
    lay_track_costed(state, point).map(CostedMutation::into_snapshot)
}
```

The actual Standard/Creative policy replacement occurs in Tasks 2–4. Until
then, these moved bodies keep their existing Standard comparisons and
deductions so this task is a reporting-only refactor.

- [ ] **Step 6: Wrap every free engine result with cost zero**

At every free `commit_result`/`commit_result_for_tiles` call, use:

```rust
result.map(CostedMutation::free)
```

Audit and wrap all free categories explicitly:

- pause and speed changes;
- road direction changes and all removal mutations;
- route update, rename, recolor, activation, deletion, and platform assignment;
- area painting;
- `SetBudget`; and
- any other shared-helper arm not listed as a paid purchase in the design.

Paid engine arms call the new internal costed variants. Road mutations continue
using `RoadMutationResult.cost`.

- [ ] **Step 7: Update road preview's context call and run focused checks**

Pass the authoritative `RoadMutationResult.cost` through the existing road
preview normalization. Do not add a second preview price calculation.

Run:

```bash
rtk cargo test -p caelum-core cost_policy::tests
rtk cargo test -p caelum-core --test engine_smoke
rtk cargo test -p caelum-core --test transit_build road_stroke_dispatch_context_reports_changed_skipped_and_cost -- --exact
rtk cargo test -p caelum-core --test transit_build track_stroke_dispatch_context_reports_changed_skipped_and_cost -- --exact
rtk cargo check -p caelum-core
```

Expected: policy unit tests pass; `SetBudget` and every other free intent report
cost zero; existing Standard paid contexts remain positive.

- [ ] **Step 8: Commit**

```bash
rtk git add crates/caelum-core/src/cost_policy.rs crates/caelum-core/src/lib.rs crates/caelum-core/src/engine.rs crates/caelum-core/src/transit.rs crates/caelum-core/src/buildings.rs crates/caelum-core/src/route_editor.rs crates/caelum-core/src/preview.rs crates/caelum-core/tests/engine_smoke.rs
rtk git commit -m "refactor(core): carry nominal purchase costs"
```

---

### Task 2: Roads, Road Strokes, Roundabouts, and Road Preview

**Files:**

- Modify: `crates/caelum-core/src/road.rs`
- Modify: `crates/caelum-core/src/roundabouts.rs`
- Add: `crates/caelum-core/tests/economy_cost_policy.rs`
- Modify: `crates/caelum-core/tests/road_authoring.rs`
- Modify: `crates/caelum-core/tests/roundabouts.rs`
- Modify: `crates/caelum-core/tests/route_preview.rs`

**Interfaces:**

- Consumes: `CostPolicy`, `CostQuote`, `ROAD_COST`, `roundabout_cost(size)`.
- Produces: policy-aware `RoadMutationResult` with explicit nominal cost.

- [ ] **Step 1: Add paired road/roundabout fixtures and failing tests**

Start `economy_cost_policy.rs` with helpers that fork an identical prepared
snapshot into Standard and Creative engines:

```rust
fn engine_for(snapshot: &GameSnapshot, preset: EconomyPreset, budget: i32) -> GameEngine {
    let mut candidate = snapshot.clone();
    candidate.rules.economy_preset = preset;
    candidate.budget = budget;
    candidate.paused = true;
    GameEngine::from_snapshot(candidate).unwrap()
}

fn assert_world_equal_ignoring_cost_policy(
    standard: &GameSnapshot,
    creative: &GameSnapshot,
) {
    let mut normalized = creative.clone();
    normalized.rules.economy_preset = standard.rules.economy_preset;
    normalized.budget = standard.budget;
    assert_eq!(standard, &normalized);
}
```

Add tests covering:

- low-budget single road: Standard rejects with required/available budget,
  Creative applies, Creative budget is unchanged, and both attempted contexts
  use `ROAD_COST` only on success;
- sufficiently funded single road world parity and equal nominal context cost;
- compact and standard roundabout low-budget Creative success;
- sufficiently funded roundabout parity for both sizes.

In `road_authoring.rs`, add failing tests for:

```rust
#[test]
fn budget_limited_road_stroke_diverges_only_by_ordered_affordability() {
    // Three valid new tiles, budget for two.
    // Standard authors the first two and skips the third.
    // Creative authors all three, reports 3 * ROAD_COST, and keeps its budget.
}

#[test]
fn road_stroke_keeps_scanning_to_a_later_free_existing_road_overlay() {
    // One new tile consumes the remaining Standard budget, a second new tile
    // is skipped, and a final pre-existing two-way road is updated by the
    // one-way preset at zero cost.
}

#[test]
fn duplicate_road_points_contribute_nominal_cost_once() {
    // Host-sent [p, p, p] authors one tile and reports ROAD_COST in both presets.
}
```

Add a second duplicate/overlap case for `DualBidirectional` and assert every
unique newly authored map tile contributes at most one `ROAD_COST`, even when
forward/reverse carriageway inputs overlap. Add a fully skipped paired stroke
that retains `InvalidRoadStroke` in both presets.

Add the budget-first single-road dual failure explicitly: with budget below
`ROAD_COST` and an out-of-bounds point, Standard returns
`InsufficientBudget`, Creative returns `OutOfBounds`, and neither snapshot or
topology changes.

In `roundabouts.rs`, add a geometry-first dual-failure test: use invalid
geometry plus budget below the attempted size cost and assert the same
non-budget rejection/context in Standard and Creative with no snapshot or
topology change. Also pair an existing unsafe-port-mapping/structure-ownership
fixture at sufficient budget so Standard and Creative return identical
non-budget rejection context.

In `route_preview.rs`, pair the existing unaffordable road preview with a
Creative engine restored from the same snapshot and assert:

- Standard retains the budget rejection and nominal attempted cost;
- Creative succeeds with the same nominal cost;
- neither preview changes the engine snapshot or cached topology.

- [ ] **Step 2: Run focused tests and verify Creative is red**

Run:

```bash
rtk cargo test -p caelum-core --test economy_cost_policy
rtk cargo test -p caelum-core --test road_authoring budget_limited_road_stroke_diverges_only_by_ordered_affordability -- --exact
rtk cargo test -p caelum-core --test roundabouts
rtk cargo test -p caelum-core --test route_preview
```

Expected: Creative still rejects or deducts because road and roundabout paths
still contain direct budget logic.

- [ ] **Step 3: Replace single-road budget logic at the existing check site**

In `lay_single_road()`, quote before geometry validation, preserving the
current budget-first order:

```rust
let authorized = CostPolicy::from_snapshot(original)
    .quote(ROAD_COST, original.budget)
    .authorize()?;

if !is_valid_road_placement(original, point) {
    // Existing rejection selection remains unchanged.
}

let cost = authorized.apply_to(&mut candidate.budget);
```

Return the nominal cost to `apply_linear_tiles_in_order()` rather than deriving
it from a budget difference.

- [ ] **Step 4: Accumulate road-stroke nominal cost from paid authoring**

Replace `author_lane_tiles() -> Vec<Point>` with a private result and return
`GameplayResult<AuthoredLane>` so authorization failure can be propagated
without a panic:

```rust
struct AuthoredLane {
    points: Vec<Point>,
    cost: i32,
}
```

For every new valid tile:

```rust
let quote =
    CostPolicy::from_snapshot(original).quote(ROAD_COST, candidate.budget);
if !quote.affordable() {
    continue;
}
let authorized = quote.authorize()?;
let nominal_cost = authorized.apply_to(&mut candidate.budget);
// Author the tile only after authorization.
lane.cost += nominal_cost;
```

Keep the existing-road branch before the quote so overlays remain free and can
still apply after Standard exhausts its budget. Keep invalid/owned/out-of-map
skips unchanged. Forward and reverse lanes add their costs into one stroke
total. Repeated road points re-enter the free existing-road path; they never
add `ROAD_COST` twice.

Return this accumulated total from `apply_linear_tiles_in_order()`. Remove:

```rust
original.budget.saturating_sub(candidate.budget)
```

The 28×18 map bounds and candidate-state existing-road check bound paid
contributions to unique newly authored tiles, so the total remains within
`i32` even for duplicate or overlapping host input.

- [ ] **Step 5: Apply the policy to roundabouts after all geometry checks**

Keep the five current validations and `roundabout_cost(size)` selection in
their existing order. Then:

```rust
let authorized = CostPolicy::from_snapshot(state)
    .quote(cost, state.budget)
    .authorize()?;

let mut candidate = state.clone();
remove_contained_automatic_junctions(&mut candidate.map, &template);
install_roundabout(&mut candidate.map, &template, captured_ports);
let nominal_cost = authorized.apply_to(&mut candidate.budget);
```

Return `nominal_cost` in `RoadMutationResult.cost`. Do not branch the topology
mutation by preset.

- [ ] **Step 6: Run road and roundabout suites**

Run:

```bash
rtk cargo test -p caelum-core --test economy_cost_policy road
rtk cargo test -p caelum-core --test economy_cost_policy roundabout
rtk cargo test -p caelum-core --test road_authoring
rtk cargo test -p caelum-core --test roundabouts
rtk cargo test -p caelum-core --test route_preview road
rtk cargo clippy -p caelum-core --all-targets -- -D warnings
```

Expected: Standard behavior remains characterized; Creative road and
roundabout commits/previews retain nominal cost with zero deduction; duplicate
and over-budget strokes obey the explicit ordered rules.

- [ ] **Step 7: Commit**

```bash
rtk git add crates/caelum-core/src/road.rs crates/caelum-core/src/roundabouts.rs crates/caelum-core/tests/economy_cost_policy.rs crates/caelum-core/tests/road_authoring.rs crates/caelum-core/tests/roundabouts.rs crates/caelum-core/tests/route_preview.rs
rtk git commit -m "feat(core): apply cost policy to roads"
```

---

### Task 3: Tracks, Transit Nodes, Buildings, and Compatibility Paths

**Files:**

- Modify: `crates/caelum-core/src/transit.rs`
- Modify: `crates/caelum-core/src/buildings.rs`
- Modify: `crates/caelum-core/tests/economy_cost_policy.rs`
- Modify: `crates/caelum-core/tests/transit_build.rs`
- Modify: `crates/caelum-core/tests/areas_buildings.rs`

**Interfaces:**

- Consumes: policy primitives plus `TRACK_COST`, `BUS_STOP_COST`,
  `METRO_STATION_COST`, and `building_definition(building_type).cost`.
- Produces: policy-aware costed variants used by the engine; existing public
  wrappers still return snapshots.

- [ ] **Step 1: Add the failing purchase matrix and drift guards**

Expand `economy_cost_policy.rs` with valid prepared snapshots/intents for:

- one track tile and a multi-tile track stroke;
- `AddBusStop`;
- `AddMetroStation`;
- `PlaceBuilding` for `smallHouse`;
- `PlaceBuilding` for `busTerminal`;
- direct `PlaceBuilding` for `busStop`;
- direct `PlaceBuilding` for `metroStation`.

For each atomic case, test a zero/low-budget Standard and Creative fork:

```rust
assert!(!standard_result.applied);
assert_eq!(
    standard_result.rejection.as_ref().unwrap().code,
    RejectionCode::InsufficientBudget,
);
assert_eq!(standard_result.snapshot, standard_before);

assert!(creative_result.applied);
assert_eq!(creative_result.snapshot.budget, creative_before.budget);
assert_eq!(creative_result.context.cost, expected_cost);
```

For sufficiently funded forks, assert equal `context.cost`, equal dispatch
metadata, and complete world equality after normalizing only budget and
economy preset.

In `transit.rs`'s internal test module, add the price-drift guard:

```rust
#[test]
fn dedicated_and_building_catalog_transit_node_prices_match() {
    assert_eq!(
        BUS_STOP_COST,
        crate::building_catalog::building_definition("busStop")
            .unwrap()
            .cost,
    );
    assert_eq!(
        METRO_STATION_COST,
        crate::building_catalog::building_definition("metroStation")
            .unwrap()
            .cost,
    );
}
```

In the integration matrix, also assert dedicated and generic intents report
the same `context.cost` for each node type.

- [ ] **Step 2: Add failing stroke and rejection-precedence tests**

In `transit_build.rs`, add:

- an all-new track stroke whose total price exceeds Standard budget;
- duplicate track points, proving the first authors/charges and subsequent
  points are invalid against the running candidate;
- a fully skipped track stroke retaining `invalidTrackStroke`;
- Standard continuing ordered track processing after invalid points;
- budget-first dual failures for track, bus stop, and metro station.

In `areas_buildings.rs`, add:

- Creative ordinary building and terminal placement with zero budget;
- direct `PlaceBuilding` compatibility cases for bus stop and metro station;
- a budget-first invalid-zoning dual failure: Standard returns
  `insufficientBudget`, Creative returns `invalidBuildingPlacement`;
- a parity assertion that `place_building_core()` remains budget-exempt in
  both presets.

Use sufficiently funded paired fixtures for representative non-budget
placement, structure-ownership, and compatibility failures. Cover at least an
out-of-bounds track, a structure-owned infrastructure tile, an already-present
transit node, and a generic transit-node building colliding with incompatible
occupancy. Assert identical rejection code/context in both presets.

Every rejected fixture compares the complete before/after snapshot. For road
or track-affecting failures, also compare `road_topology_for_test()`.

- [ ] **Step 3: Run focused tests and verify red**

Run:

```bash
rtk cargo test -p caelum-core --test economy_cost_policy
rtk cargo test -p caelum-core --test transit_build
rtk cargo test -p caelum-core --test areas_buildings
```

Expected: Creative cases fail until direct track/node/building comparisons and
deductions are replaced.

- [ ] **Step 4: Apply policy per tile in `lay_track_line_costed()`**

For a single track, quote before geometry validation to retain budget-first
precedence; authorize once, mutate the clone, apply the authorized deduction,
and return `CostedMutation`.

For a track stroke:

```rust
let policy = CostPolicy::from_snapshot(state);
let mut cost = 0;
for point in points {
    if !is_valid_track_placement(&next, point) {
        continue;
    }
    let quote = policy.quote(TRACK_COST, next.budget);
    if !quote.affordable() {
        continue;
    }
    let nominal_cost = quote.authorize()?.apply_to(&mut next.budget);
    set_tile_track(&mut next.map, point, true);
    cost += nominal_cost;
    changed = true;
}
```

Validation remains against the running candidate so a duplicate becomes
already tracked and cannot charge twice. If nothing changes, retain
`InvalidTrackStroke`. Return the accumulated nominal cost independently of the
budget delta.

- [ ] **Step 5: Apply policy to dedicated transit nodes**

At the existing first checks in `add_bus_stop_costed()` and
`add_metro_station_costed()`, create and authorize the quote before placement
validation. Thread the authorized value through the unchanged clone/restore
logic, apply it exactly once after successful node construction, and return
the nominal price in `CostedMutation`.

This deliberately preserves:

- Standard `insufficientBudget` on an invalid-and-unaffordable node attempt;
- Creative's underlying `OutOfBounds`, `BlockedTile`, `NoRoadAccess`,
  `TrackRequired`, or `NodeAlreadyExists` rejection; and
- atomic restoration semantics.

- [ ] **Step 6: Apply policy only in the player building wrapper**

In `place_building_costed()`:

1. select the building definition;
2. quote/authorize at the current budget-first position;
3. call the unchanged `place_building_core()`;
4. apply the authorized deduction to the returned candidate; and
5. return its catalog cost in `CostedMutation`.

Do not add a policy call to `place_building_core()`. This automatically covers
ordinary buildings, the bus terminal, and generic bus-stop/metro-station wire
compatibility without a parallel bypass.

- [ ] **Step 7: Run transit/building suites and the matrix**

Run:

```bash
rtk cargo test -p caelum-core dedicated_and_building_catalog_transit_node_prices_match -- --exact
rtk cargo test -p caelum-core --test economy_cost_policy
rtk cargo test -p caelum-core --test transit_build
rtk cargo test -p caelum-core --test areas_buildings
rtk cargo clippy -p caelum-core --all-targets -- -D warnings
```

Expected: all track/node/building matrix rows satisfy low-budget Creative
behavior, Standard regression semantics, nominal-cost parity, and catalog
drift guards.

- [ ] **Step 8: Commit**

```bash
rtk git add crates/caelum-core/src/transit.rs crates/caelum-core/src/buildings.rs crates/caelum-core/tests/economy_cost_policy.rs crates/caelum-core/tests/transit_build.rs crates/caelum-core/tests/areas_buildings.rs
rtk git commit -m "feat(core): apply cost policy to construction"
```

---

### Task 4: Routes, Vehicle Assignment, and Route Preview

**Files:**

- Modify: `crates/caelum-core/src/transit.rs`
- Modify: `crates/caelum-core/src/route_editor.rs`
- Modify: `crates/caelum-core/src/preview.rs`
- Modify: `crates/caelum-core/tests/economy_cost_policy.rs`
- Modify: `crates/caelum-core/tests/route_editing.rs`
- Modify: `crates/caelum-core/tests/route_preview.rs`

**Interfaces:**

- Consumes: `transit::vehicle_cost(mode)` and the shared policy quote.
- Produces: policy-aware route creation, vehicle assignment, and route preview
  with unchanged wire types.

- [ ] **Step 1: Add failing bus/metro route and vehicle matrix rows**

Expand `economy_cost_policy.rs` with prepared connected bus and metro
snapshots for:

- bus route creation (`BUS_COST`);
- metro line creation (`METRO_COST`);
- additional bus assignment (`BUS_COST`);
- additional metro assignment (`METRO_COST`).

For each, cover low-budget Standard rejection/Creative success, Creative
budget neutrality, positive nominal context cost, atomic Standard failure,
and sufficiently funded deterministic world parity.

- [ ] **Step 2: Add failing precedence and preview tests**

In `route_editing.rs`, add:

- a geometry-first invalid-connectivity plus low-budget route creation fixture;
  both presets must return the same `DisconnectedLeg` context and neither may
  commit;
- a budget-first missing-route plus low-budget vehicle assignment fixture;
  Standard must retain `InsufficientBudget`, while Creative must reach
  `RouteNotFound`;
- inactive/disconnected validly funded paired fixtures proving identical
  non-budget rejection context;
- an invalid mode string with sufficient budget, proving identical
  `IncompatibleRouteNode` compatibility rejection in both presets;
- atomic checks across route/line collections, vehicles, platforms, budget,
  and stable ID counters.

In `route_preview.rs`, add paired Standard/Creative tests for:

1. a valid connected create draft at low budget;
2. a disconnected create draft at low budget;
3. invalid early-return cases such as missing route, stale revision, or invalid
   waypoints; and
4. a free edit draft.

Assert:

```rust
assert_eq!(standard.initial_vehicle_cost, BUS_COST);
assert_eq!(creative.initial_vehicle_cost, BUS_COST);
assert!(!standard.affordable);
assert!(creative.affordable);
```

For the valid connected draft, Standard has the existing budget rejection and
Creative has none. For the disconnected draft, Standard retains the
`DisconnectedLeg` rejection plus the budget warning; Creative retains only the
`DisconnectedLeg` rejection. Early-return cases keep their domain rejection
while their already-computed `affordable` field follows policy. Edit drafts
remain zero-cost and affordable in both presets.

- [ ] **Step 3: Run focused route tests and verify red**

Run:

```bash
rtk cargo test -p caelum-core --test economy_cost_policy
rtk cargo test -p caelum-core --test route_editing
rtk cargo test -p caelum-core --test route_preview
```

Expected: Creative route/vehicle operations still fail or deduct, and preview
still uses the raw budget comparison.

- [ ] **Step 4: Apply policy to route creation after connectivity validation**

In `create_route_costed()`, preserve:

```rust
validate_waypoints(state, mode, &waypoint_ids, None, None)?;
let legs = resolve_route_legs(
    state,
    context,
    mode,
    &waypoint_ids,
    pattern,
);
require_all_connected(&legs, None)?;
```

Then select `vehicle_cost(mode)`, authorize its quote, build the candidate,
assign platforms, insert the route/line and implicit vehicle, apply the
authorized deduction exactly once, and return `CostedMutation`.

Keep the public `create_route()` wrapper returning only the snapshot. Do not
change the implicit-first-vehicle contract or ID allocation order.

- [ ] **Step 5: Apply policy at vehicle assignment's current first gate**

After lifting the mode string to `TransitMode`, quote and authorize before
route lookup/activity/connectivity checks, exactly where the current budget
check occurs. Build the unchanged candidate, then apply the authorized
deduction and return `CostedMutation`.

This retains Standard's budget-first dual-failure behavior while allowing
Creative to reach route-specific rejections.

- [ ] **Step 6: Make route preview use shared price and policy**

Remove the private `preview.rs::vehicle_cost()` and the now-unused
`BUS_COST`/`METRO_COST` imports. Use:

```rust
let initial_vehicle_cost = if request.route_id.is_none() {
    crate::transit::vehicle_cost(request.mode)
} else {
    0
};
let quote = CostPolicy::from_snapshot(snapshot)
    .quote(initial_vehicle_cost, snapshot.budget);
let affordable = quote.affordable();
```

Leave all existing response construction and early returns in place. The final
budget rejection/warning block continues to run only when `!affordable`, which
automatically suppresses budget feedback in Creative without a preview-only
exception.

- [ ] **Step 7: Run route/preview suites**

Run:

```bash
rtk cargo test -p caelum-core --test economy_cost_policy
rtk cargo test -p caelum-core --test route_editing
rtk cargo test -p caelum-core --test route_preview
rtk cargo test -p caelum-core --test transit_build
rtk cargo clippy -p caelum-core --all-targets -- -D warnings
```

Expected: bus and metro creation/assignment preserve nominal prices, Creative
budget neutrality, route validation, preview warning behavior, and stable IDs.

- [ ] **Step 8: Commit**

```bash
rtk git add crates/caelum-core/src/transit.rs crates/caelum-core/src/route_editor.rs crates/caelum-core/src/preview.rs crates/caelum-core/tests/economy_cost_policy.rs crates/caelum-core/tests/route_editing.rs crates/caelum-core/tests/route_preview.rs
rtk git commit -m "feat(core): apply cost policy to transit service"
```

---

### Task 5: Shared TypeScript Building Affordability Presentation

**Files:**

- Modify: `src/render/placementValidation.ts`
- Modify: `src/render/overlayRenderer.ts`
- Modify: `src/render/cursorBadge.ts`
- Modify: `tests/render/placementValidation.test.ts`
- Modify: `tests/render/overlayRenderer.test.ts`
- Modify: `tests/render/cursorBadge.test.ts`

**Interfaces:**

- Consumes: read-only `GameState.rules.economyPreset` and
  `BUILDING_CATALOG[type].cost`.
- Produces:

```typescript
export function isBuildingAffordableForPresentation(
  state: GameState,
  buildingType: BuildingType,
): boolean;
```

- [ ] **Step 1: Add failing helper and renderer tests**

In `placementValidation.test.ts`, add:

```typescript
it("treats a zero-budget building as affordable only in Creative", () => {
  const standard = { ...createTestGameState(), budget: 0 };
  const creative = {
    ...standard,
    rules: { ...standard.rules, economyPreset: "creative" as const },
  };

  expect(
    isBuildingAffordableForPresentation(standard, "smallHouse"),
  ).toBe(false);
  expect(
    isBuildingAffordableForPresentation(creative, "smallHouse"),
  ).toBe(true);
});
```

Retain a separate assertion that `canPlaceBuilding()` is geometry-only and
returns the same value for equivalent Standard/Creative snapshots.

Extend the existing low-budget tests:

- `overlayRenderer.test.ts`: a geometrically valid Creative small-house
  footprint with budget zero uses `colors.previewValid`; Standard remains
  `previewInvalid`.
- `cursorBadge.test.ts`: the same Creative state omits `⊘`; Standard retains
  it.
- Both suites: a Creative occupied/invalid footprint remains invalid/blocked,
  proving economy does not bypass geometry presentation.

- [ ] **Step 2: Run the render tests and verify red**

Run:

```bash
rtk bunx vitest run --project ui tests/render/placementValidation.test.ts tests/render/overlayRenderer.test.ts tests/render/cursorBadge.test.ts
```

Expected: the helper is missing and both render consumers still mark
zero-budget Creative placement invalid.

- [ ] **Step 3: Add one read-only helper and use it at both sites**

In `placementValidation.ts`:

```typescript
export function isBuildingAffordableForPresentation(
  state: GameState,
  buildingType: BuildingType,
): boolean {
  return (
    state.rules.economyPreset === "creative" ||
    state.budget >= BUILDING_CATALOG[buildingType].cost
  );
}
```

In both `renderBuildingPreview()` and `badgeText()`, combine this helper with
the existing `canPlaceBuilding()` call. Remove the two direct budget
comparisons. Keep `canPlaceBuilding()` itself unchanged and geometry-only.

- [ ] **Step 4: Run TypeScript render and type checks**

Run:

```bash
rtk bunx vitest run --project ui tests/render/placementValidation.test.ts tests/render/overlayRenderer.test.ts tests/render/cursorBadge.test.ts
rtk bun run check
rtk bun run lint
```

Expected: both hover surfaces agree for Standard and Creative, invalid
geometry remains invalid, and TypeScript introduces no gameplay mutation
authority.

- [ ] **Step 5: Commit**

```bash
rtk git add src/render/placementValidation.ts src/render/overlayRenderer.ts src/render/cursorBadge.ts tests/render/placementValidation.test.ts tests/render/overlayRenderer.test.ts tests/render/cursorBadge.test.ts
rtk git commit -m "feat(render): present Creative building affordability"
```

---

### Task 6: Restored Snapshot, WASM, and Tauri Parity

**Files:**

- Modify: `crates/caelum-core/tests/persistence_determinism.rs`
- Modify: `tests/runtime/wasmArtifact.smoke.test.ts`
- Modify: `src-tauri/src/lib.rs`
- Verify: `tests/runtime/backendContract.test.ts`
- Verify: `src/runtime/backend/wasmBackend.ts`
- Verify: `src/runtime/backend/tauriBackend.ts`

**Interfaces:**

- Consumes: existing schema-v4 snapshot restoration and unchanged host
  `dispatch` APIs.
- Produces: proof that restored rules immediately drive policy in core, real
  WASM, and real Tauri IPC.

- [ ] **Step 1: Add a restored-core regression test**

In `persistence_determinism.rs`, create a valid paused Creative schema-v4
snapshot with budget zero, restore it through `GameEngine::from_snapshot()`,
and dispatch a valid road:

```rust
let restored_before = restored.snapshot();
let result = restored.dispatch(GameIntent::LayRoad {
    point: Point { x: 2, y: 2 },
});

assert!(result.applied);
assert_eq!(result.context.cost, ROAD_COST);
assert_eq!(result.snapshot.budget, restored_before.budget);
assert_eq!(
    result.snapshot.rules.economy_preset,
    EconomyPreset::Creative,
);
```

Also compare a direct engine built from the same snapshot to prove identical
result and topology.

- [ ] **Step 2: Add a real-WASM restored snapshot regression test**

In `wasmArtifact.smoke.test.ts`:

1. create or obtain a valid Creative Blank Grid snapshot;
2. set/retain budget zero and paused state;
3. call the real backend's `loadSnapshot`;
4. dispatch `{ type: "layRoad", point: { x: 2, y: 2 } }`; and
5. assert `applied`, `context.cost === 100`, unchanged budget, authored road,
   and retained `"creative"` rules.

This test must use `createWasmBackend()` and the generated artifact, not the
mock backend.

- [ ] **Step 3: Add a real Tauri IPC restored snapshot regression test**

Expand only `sandbox_test_app()`'s test ACL and generated test handler to
include:

```rust
"game_load_snapshot",
"game_dispatch",
```

Add helpers that send:

```rust
InvokeBody::Json(json!({ "snapshot": snapshot_value }))
InvokeBody::Json(json!({
    "intent": {
        "type": "layRoad",
        "point": { "x": 2, "y": 2 }
    }
}))
```

Decode the second response as `DispatchResult`. Build a direct
`GameEngine::from_snapshot()` oracle from the same JSON snapshot and assert the
complete Tauri dispatch result equals the direct-core result, including
Creative budget, nominal cost, rules, and road tile. Production Tauri commands
and handler registration remain unchanged.

- [ ] **Step 4: Run the new parity tests**

The core and WASM assertions should pass immediately after Tasks 2–4. The
Tauri IPC test is initially red until the test-only ACL and invoke handler
admit `game_load_snapshot` and `game_dispatch`; update that harness in Step 3,
without changing production registration.

Run:

```bash
rtk cargo test -p caelum-core --test persistence_determinism restored_creative
rtk bun run wasm:build
rtk bunx vitest run --project runtime tests/runtime/wasmArtifact.smoke.test.ts
rtk cargo test -p caelum
```

Expected: all three boundaries pass without host policy code, and the Tauri
result equals the direct-core oracle.

- [ ] **Step 5: Verify unchanged backend normalization**

Run:

```bash
rtk bunx vitest run --project runtime tests/runtime/backendContract.test.ts tests/runtime/wasmBackend.test.ts tests/runtime/tauriBackend.test.ts
```

Inspect the diff and confirm:

- no backend type or normalization field was added;
- `DispatchContext.cost` remains an integer on the existing shape;
- preview warning/rejection null normalization is unchanged; and
- neither backend checks `economyPreset`.

- [ ] **Step 6: Run all restored-host parity checks**

Run:

```bash
rtk cargo test -p caelum-core --test persistence_determinism
rtk bun run wasm:build
rtk bunx vitest run --project runtime tests/runtime/wasmArtifact.smoke.test.ts
rtk cargo test -p caelum
```

Expected: restored Creative policy is immediate and equivalent in core, the
real WASM artifact, and real Tauri IPC.

- [ ] **Step 7: Commit**

```bash
rtk git add crates/caelum-core/tests/persistence_determinism.rs tests/runtime/wasmArtifact.smoke.test.ts src-tauri/src/lib.rs
rtk git commit -m "test(hosts): prove restored Creative cost parity"
```

---

### Task 7: Architecture Documentation and Full Verification

**Files:**

- Modify: `docs/architecture.md`
- Verify: all files changed in Tasks 1–6.

**Interfaces:**

- Consumes: the completed implementation and approved design.
- Produces: current architecture documentation and a fully verified branch.

- [ ] **Step 1: Document the authoritative purchase-cost contract**

Add a concise `### Purchase cost policy` section near the sandbox/runtime
ownership material:

```markdown
Rust derives a transient purchase `CostPolicy` from the active snapshot's
`rules.economyPreset` for every player purchase. Standard requires and deducts
the full catalog price; Creative treats the same quote as affordable and
deducts zero. Both retain the same positive nominal price in dispatch and
preview responses. Nominal cost is carried explicitly rather than inferred
from a budget delta.

Atomic purchases remain atomic, while road and track strokes authorize and
accumulate each newly authored paid tile in input order. Scenario-authored
`place_building_core()` remains free. WASM and Tauri only forward the existing
Rust results; TypeScript's economy use is limited to read-only hover
presentation.
```

- [ ] **Step 2: Scan for forbidden direct affordability/deduction remnants**

Run:

```bash
rtk rg -n "budget <|budget >=|budget -=|saturating_sub\\(.*budget|fn vehicle_cost" crates/caelum-core/src src/render --glob '!src/generated/**'
```

Inspect every match. Expected HPA-338 outcomes:

- covered player-purchase sites use `CostPolicy`;
- only `transit::vehicle_cost()` selects vehicle prices;
- objective/scenario/debug or other non-purchase budget references are
  justified;
- `overlayRenderer.ts` and `cursorBadge.ts` no longer contain duplicate
  building budget comparisons.

Also run:

```bash
rtk rg -n "CostPolicy|CostedMutation|isBuildingAffordableForPresentation" crates/caelum-core/src src/render
```

Expected: one Rust policy module, the intended internal costed call paths, and
one shared TypeScript presentation helper with two consumers.

- [ ] **Step 3: Run focused acceptance suites**

Run:

```bash
rtk cargo test -p caelum-core cost_policy::tests
rtk cargo test -p caelum-core --test economy_cost_policy
rtk cargo test -p caelum-core --test road_authoring
rtk cargo test -p caelum-core --test roundabouts
rtk cargo test -p caelum-core --test transit_build
rtk cargo test -p caelum-core --test areas_buildings
rtk cargo test -p caelum-core --test route_editing
rtk cargo test -p caelum-core --test route_preview
rtk cargo test -p caelum-core --test persistence_determinism
rtk bunx vitest run --project ui tests/render/placementValidation.test.ts tests/render/overlayRenderer.test.ts tests/render/cursorBadge.test.ts
rtk bunx vitest run --project runtime tests/runtime/wasmArtifact.smoke.test.ts tests/runtime/backendContract.test.ts tests/runtime/wasmBackend.test.ts tests/runtime/tauriBackend.test.ts
rtk cargo test -p caelum
```

Expected: every purchase category, preview, duplicate/stroke invariant,
dual-failure precedence, and restored host boundary passes.

- [ ] **Step 4: Run every repository gate**

Run:

```bash
rtk cargo fmt --all --check
rtk cargo clippy --workspace --all-targets -- -D warnings
rtk cargo test --workspace
rtk bun run check
rtk bun run lint
rtk bun run format:check
rtk bun run test
rtk bun run build
rtk bun run test:e2e
```

Expected: every command exits zero. Bun pre-hooks rebuild the WASM artifact
from the changed Rust core before TypeScript test/build gates.

- [ ] **Step 5: Review the complete diff against every design guarantee**

Run:

```bash
rtk git diff --check
rtk git status --short
rtk git diff --stat
```

Verify directly:

- every purchase row in design section 3.1 has Standard and Creative coverage;
- low-budget Standard atomic failures commit no state or topology;
- Creative keeps budget unchanged and reports the nominal cost;
- sufficiently funded paired worlds differ only by budget and economy preset;
- budget-limited strokes intentionally diverge in authored world;
- duplicate points never inflate road/track cost;
- budget-first and geometry-first dual failures retain their specified
  precedence;
- road and route previews use shared policy and price selection;
- both building hover consumers use one helper and geometry remains enforced;
- restored core/WASM/Tauri snapshots use persisted Creative rules immediately;
- no schema, host, wire, warning, or rejection contract changed.

- [ ] **Step 6: Commit documentation**

```bash
rtk git add docs/architecture.md
rtk git commit -m "docs: document purchase cost policy"
```

- [ ] **Step 7: Verify the committed branch is clean**

Run:

```bash
rtk git status --short
rtk git log --oneline -8
```

Expected: no worktree changes and one focused commit per implementation slice
plus the architecture documentation commit.

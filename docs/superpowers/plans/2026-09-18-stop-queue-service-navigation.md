# HPA-464 Stop Queue and Service Navigation Implementation Plan

> **Design:** `docs/superpowers/specs/2026-09-18-stop-queue-service-navigation-design.md`

## Outcome

A player can start from either a selected stop/station or an existing long-wait line warning, see the real current waiting evidence at the affected platform, move directly between that stop and HPA-48's existing operating controls, explicitly tune/add service, and observe refreshed live values without entering route geometry edit.

Keep this as one HPA-464 PR. The implementation adds one compact frame-only wait-location projection and small UI navigation glue. It does **not** add a diagnostics framework, backend query, saved state, new gameplay intent, historical data, or a second renderer path.

## Global constraints

- One Linear ticket = one GitHub PR. Continue implementation on this PR; do not create implementation/QA/closeout PRs.
- Rust owns waiter eligibility, capacity admission, current-leg wait, and at-risk classification.
- Existing `platformOccupancy` keeps counting the full physical platform queue, including overflow.
- New per-line wait rows use the exact capacity-admitted eligibility used by route health. Label the two concepts separately.
- Every non-empty admitted line/platform group gets a raw wait row even without a target; only at-risk classification and line-level HPA-48 ServiceMetrics remain target-gated.
- No citizen/trip IDs cross the presentation boundary.
- No snapshot field, schema bump, migration, backend query, gameplay intent, or event bus.
- Reuse `selectedRouteId`, `selectedId`, `selectedNodeKind`, `setCommandDestination`, and the existing Lines/Inspect panels.
- Add no wait-focus field to `UiState`.
- An active route draft keeps the existing pinned Save/Cancel gate and cannot be silently replaced.
- A target edit or vehicle purchase never displays causal success language.
- HPA-463 workplace demand behavior remains untouched.
- No new image art.

## File map

### Rust authority / projection

- `crates/caelum-core/src/platforms.rs` — preserve platform identity while grouping capacity-admitted waiters.
- `crates/caelum-core/src/service_control.rs` — derive per-line/platform waiting count, longest current-leg wait, and at-risk count once; aggregate existing line health from the same rows.
- `crates/caelum-core/src/presentation.rs` — add deterministic `WaitingLocationPresentation` rows to `PresentationFrame`.
- `crates/caelum-core/tests/service_control.rs` — targeted/no-target line/location consistency and controlled warning fixture.
- `crates/caelum-core/tests/model_wire_format.rs` — update exact camelCase frame/wire expectations only where the frame shape is pinned.

Do not add another trip-lifecycle boarding test. Existing `waiting_trip_that_boards_and_disembarks_does_not_advance_the_following_walk` already exercises a waiting rider through boarding/disembark with a 240-second patience budget; HPA-464 only needs grouping tests to keep `Riding` trips out of wait rows.

### TypeScript presentation / view model

- `src/runtime/backend/types.ts` — wire type for `WaitingLocationPresentation` and `PresentationFrame.waitingLocations`.
- `src/domain/types.ts` — flat `WaitingLocationView` and `GameState.waitingLocations`.
- `src/runtime/presentationView.ts` — copy newest frame rows into `GameState`.
- `src/runtime/types.ts` — add stop/line wait fields to shell rows and one `focusWaitLocation` controller method.
- `src/runtime/runtimeSelectors.ts` — join wait rows to selected platforms and group at-risk locations into line rows.

### UI / runtime navigation

- `src/runtime/createGameRuntime.ts` — one UI-only `focusWaitLocation(routeId, nodeId)` action; no new `UiState` field.
- `src/App.svelte` — wire stop→line controls and line-warning→stop focus.
- `src/components/hud/panels/InspectPanel.svelte` — platform total plus per-serving-line live wait evidence; serving-line button opens Lines.
- `src/components/hud/panels/LinesPanel.svelte` — local at-risk stop buttons under the existing warning.

### WebGPU emphasis

- `src/render/webgpu/overlayBatch.ts` — derive selected line's current at-risk stop markers from `GameState.waitingLocations`.
- Reuse existing overlay batch buffers/palette; no shader or renderer architecture changes.

### Focused tests / fixture fallout

- `tests/runtime/presentationView.test.ts`
- `tests/runtime/runtimeSelectors.test.ts`
- `tests/runtime/gameRuntime.test.ts`
- `tests/ui/inspectPanel.test.ts` if present; otherwise create this isolated component test beside existing panel tests.
- `tests/ui/linesPanel.test.ts`
- `tests/ui/appShell.test.ts` — required full warning-focus → inspector chip → same-line Lines round-trip, not optional callback-only coverage.
- `tests/render/webgpuOverlayBatch.test.ts`
- `tests/e2e/routes.spec.ts`
- Shared fixture defaults that construct `GameState` / `PresentationFrame`, especially:
  - `tests/helpers/gameState.ts`
  - `tests/helpers/renderScaleState.ts`
  - `tests/fixtures/rustSnapshot.ts`

Do not pre-edit unrelated fixtures. Let the required field addition identify the actual compile/test fallout, then update only those constructors.

---

## Task 1 — Preserve platform identity in the existing route-health eligibility

**Files**

- Modify: `crates/caelum-core/src/platforms.rs`
- Modify: existing tests in `crates/caelum-core/src/platforms.rs`

### 1.1 Add a failing grouped-location characterization

Start from the current shared-platform tests.

Add/replace a focused test proving a capacity-2 shared platform with multiple waiting riders produces groups keyed by both line and platform, and only the two riders admitted by `on_platform_trip_ids` appear.

The contract must pin:

- waiting rider at a real serving platform -> included;
- riding/non-waiting trip -> excluded;
- waiting rider at the wrong position -> excluded;
- capacity overflow -> excluded;
- admitted route-001 and route-002 riders remain in distinct `(line_id, platform_id)` groups;
- one admitted trip appears exactly once.

Run:

```bash
cargo test -p caelum-core platforms::
```

Expected: RED because the location grouping helper does not exist.

### 1.2 Add the smallest grouping helper

Prefer replacing the line-only helper with:

```rust
pub(crate) fn platform_waiters_by_location(
    state: &GameSnapshot,
) -> BTreeMap<(String, String), Vec<&ActiveTrip>>
```

where the tuple is `(line_id, platform_id)`.

Implementation must reuse, in order:

1. `platform_waiter_candidates(state)`;
2. `on_platform_trip_ids(state)`;
3. one group insertion for each admitted candidate.

Do not parse platform IDs, change candidate ordering, alter `platform_waiting_occupancy`, or move boarding policy into service-control code.

If retaining `platform_waiters_by_line` avoids unnecessary test churn, implement it as a thin aggregate over the new helper rather than a second candidate scan. Delete it if no production consumer remains after Task 2.

### 1.3 Keep the overflow total test unchanged

The existing test:

```text
waiting_occupancy_counts_overflow_beyond_boarding_capacity
```

must remain green and continue proving:

```text
platform queue = 2
capacity = 1
admitted = 1
```

This is an intentional product distinction used by the inspector.

### 1.4 Verify

```bash
cargo test -p caelum-core platforms::
```

Suggested commit:

```text
refactor: retain platform identity in waiter health groups
```

---

## Task 2 — Derive one wait-location health source and keep line metrics consistent

**Files**

- Modify: `crates/caelum-core/src/service_control.rs`
- Modify: `crates/caelum-core/tests/service_control.rs`
- Modify if needed for the boarding proof: `crates/caelum-core/tests/trip_lifecycle.rs`

### 2.1 Write failing location-health tests beside existing wait-health authority

Use existing wait fixtures/builders rather than creating a parallel scenario framework.

Add tests for a targeted line with waiters on two platforms/stops:

- location A: one admitted rider with current-leg wait 90s;
- location B: two admitted riders with current-leg waits 30s and 150s;
- target 60s;
- patience values chosen so the expected at-risk count is explicit.

Pin:

- each location's `waiting_count`;
- each location's exact longest current-leg wait;
- each location's `at_risk_count`;
- line `ServiceMetrics.waiting_at_risk_count` equals the sum of its location counts;
- line `longest_wait_seconds` equals the max location longest wait.

Add one explicit **no-target** case before implementation:

- one capacity-admitted waiter on `route-none` with no target still produces a location row;
- that row has `waiting_count > 0`, `at_risk_count = 0`, and the real `longest_wait_seconds`;
- the existing line-level contract remains target-gated: `ServiceMetrics.longest_wait_seconds` stays null and `waiting_at_risk_count == 0` for that line;
- keep the existing `none-ignored` assertion as a line-level ServiceMetrics/health assertion, not as a location-row exclusion.

Also keep the existing transfer test proving wait health uses `current_leg_wait_seconds`, not trip-wide elapsed wait.

Run:

```bash
cargo test -p caelum-core --test service_control
cargo test -p caelum-core service_control::
```

Expected: RED because the location health seam does not exist.

### 2.2 Extract target lookup and location health without changing the rule

Add an internal row:

```rust
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct WaitingLocationHealth {
    pub waiting_count: u32,
    pub at_risk_count: u32,
    pub longest_wait_seconds: f64,
}
```

Add a crate-private deterministic function returning location rows keyed by `(line_id, platform_id)`.

For each admitted waiter:

```text
wait = current_leg_wait_seconds(trip)
risk = target exists &&
       (wait > target || patience_remaining <= MIN_HEADWAY_SECONDS)
```

Rows exist only for non-empty groups.

Rows exist for every non-empty admitted group, including lines with no target. The risk predicate is target-gated, so untargeted rows publish raw count/longest wait with `at_risk_count = 0`.

Keep the current **line-level** target semantics. HPA-464 does not make HPA-48 `ServiceMetrics.longestWaitSeconds` available on untargeted lines.

### 2.3 Make `waiting_health_by_line` aggregate the location rows

Remove the second independent waiter scan.

Line health should be derived from the new rows:

- sum `at_risk_count`;
- max `longest_wait_seconds`;
- preserve the current target gate for the existing `ServiceMetrics` row.

This is the important drift-prevention lock: the warning total and the warning's concrete locations cannot use different eligibility/formulas.

### 2.4 Reuse existing boarding coverage; pin only the new grouping boundary

Do not add another engine/trip-lifecycle characterization. Existing `waiting_trip_that_boards_and_disembarks_does_not_advance_the_following_walk` already proves a Waiting trip boards/disembarks through the real lifecycle before its 240-second patience budget expires.

The new HPA-464 coverage belongs next to the grouping rule: keep the Task 1 assertion that a `TripStatus::Riding` trip does not appear in `platform_waiters_by_location`. That is the only new boarding-related contract this feature needs.

### 2.5 Verify

```bash
cargo test -p caelum-core --test service_control
cargo test -p caelum-core
```

Suggested commit:

```text
feat: derive wait health by serving location
```

---

## Task 3 — Project compact wait-location rows through the existing frame boundary

**Files**

- Modify: `crates/caelum-core/src/presentation.rs`
- Modify: `crates/caelum-core/tests/model_wire_format.rs` only where relevant
- Modify: `src/runtime/backend/types.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/runtime/presentationView.ts`
- Modify: `tests/runtime/presentationView.test.ts`
- Update only affected shared fixture constructors.

### 3.1 Add failing Rust presentation coverage

Add a deterministic presentation test with two wait locations and assert exact rows:

```json
[
  {
    "lineId": "route-001",
    "platformId": "stop-001-p0",
    "waitingCount": 1,
    "atRiskCount": 1,
    "longestWaitSeconds": 90.0
  }
]
```

The exact fixture values may differ; pin these properties:

- row exists only for a non-empty capacity-admitted line/platform group;
- untargeted admitted groups still produce raw rows with `atRiskCount = 0`;
- ordering is deterministic by line/platform;
- no trip/citizen IDs or duplicated node ID appear;
- existing `platformOccupancy` still reports the physical queue total independently.

Run the focused presentation/model-wire tests and confirm RED.

### 3.2 Add `WaitingLocationPresentation` to `PresentationFrame`

Add:

```rust
pub struct WaitingLocationPresentation {
    pub line_id: String,
    pub platform_id: String,
    pub waiting_count: u32,
    pub at_risk_count: u32,
    pub longest_wait_seconds: f64,
}
```

and:

```rust
pub waiting_locations: Vec<WaitingLocationPresentation>
```

Do not add `node_id` to the frame row. Like `PlatformOccupancyPresentation`, the dynamic row carries the platform key and the frontend joins it to current present stop/station topology when it needs a node.

Sort by `(line_id, platform_id)` before returning.

### 3.3 Add the strict TypeScript wire/view field

In `src/runtime/backend/types.ts`, add the exact camelCase row and required `PresentationFrame.waitingLocations`.

In `src/domain/types.ts`, add:

```ts
export interface WaitingLocationView {
  lineId: string;
  platformId: string;
  waitingCount: number;
  atRiskCount: number;
  longestWaitSeconds: number;
}
```

and required `GameState.waitingLocations`.

Do not make it optional and do not add compatibility fallbacks. There are no production users requiring backward wire compatibility.

### 3.4 Fold newest rows on every frame

In `applyPresentationUpdate`, copy:

```ts
waitingLocations: update.frame.waitingLocations
```

beside `platformOccupancy`, `trafficFlow`, and `demandFlow`.

Add a test that starts with one location row, applies a frame-only update with a different row set, and proves the old rows are replaced rather than accumulated.

### 3.5 Update only real fixture fallout

Add `waitingLocations: []` to shared constructors that now fail typechecking. Expected likely homes include:

- `tests/helpers/gameState.ts`;
- `tests/helpers/renderScaleState.ts`;
- `tests/fixtures/rustSnapshot.ts`.

Do not edit every test file preemptively.

### 3.6 Verify

```bash
cargo test -p caelum-core presentation::
cargo test -p caelum-core --test model_wire_format
bunx vitest run tests/runtime/presentationView.test.ts
bun run check
```

Suggested commit:

```text
feat: project live wait locations
```

---

## Task 4 — Join wait rows into stop and line shell models

**Files**

- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/runtimeSelectors.ts`
- Modify: `tests/runtime/runtimeSelectors.test.ts`

### 4.1 Add failing stop-inspector selector coverage

Extend an existing selected transit-node fixture with:

- platform occupancy greater than admitted per-line wait, so labels cannot accidentally conflate totals;
- two serving routes sharing a platform;
- wait rows for one or both routes.

Assert the selected inspector returns, per serving line:

- route ID/name/color;
- `waitingCount`;
- `longestWaitSeconds`;
- existing platform reassignment targets unchanged.

No matching wait row must yield `0 / null`. Do not expose `atRiskCount` on the inspector route model.

### 4.2 Extend `ShellPlatformRoute`

Add:

```ts
waitingCount: number;
longestWaitSeconds: number | null;
```

Build a local map keyed by `${lineId}|${platformId}` once per selector invocation; do not repeatedly scan the full row vector inside nested loops.

Keep current `ShellPlatform.occupancy/capacity` unchanged.

### 4.3 Add route wait-location rows

Add:

```ts
export interface ShellRouteWaitLocation {
  nodeId: string;
  nodeLabel: string;
  nodeKind: "stop" | "station";
  platformId: string;
  platformLabel: string;
  waitingCount: number;
  atRiskCount: number;
  longestWaitSeconds: number;
}
```

and:

```ts
waitLocations: ShellRouteWaitLocation[];
```

to `ShellRouteListItem`.

Resolve each `platformId` back to its current present stop/station, then derive node/platform labels there. Reuse `waypointLabel(...)` for the node label rather than inventing another ordinal system. `nodeId` exists only on this shell row, not on the 10 Hz frame row.

Sort locations in route itinerary order where possible, then platform label/ID for deterministic fallback. Do not add a generic navigation model.

### 4.4 Pin line/location consistency in selector tests

For one selected route:

- warning total remains the Rust-projected `service.waitingAtRiskCount`;
- `waitLocations.filter(atRiskCount > 0)` contains only that line's affected nodes;
- summed location at-risk count equals the service warning count in the controlled fixture;
- unrelated line rows are absent.

### 4.5 Verify

```bash
bunx vitest run tests/runtime/runtimeSelectors.test.ts
bun run check
```

Suggested commit:

```text
feat: expose wait evidence in shell selectors
```

---

## Task 5 — Add UI-only stop/line navigation without a new focus state

**Files**

- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `src/App.svelte`
- Modify: `src/components/hud/panels/InspectPanel.svelte`
- Modify: `src/components/hud/panels/LinesPanel.svelte`
- Modify: `tests/runtime/gameRuntime.test.ts`
- Modify/create focused panel tests:
  - `tests/ui/inspectPanel.test.ts`
  - `tests/ui/linesPanel.test.ts`
  - `tests/ui/appShell.test.ts` only if needed.

### 5.1 Add failing runtime tests for `focusWaitLocation`

Add `RuntimeController.focusWaitLocation(routeId, nodeId)`.

Tests first:

1. valid route + present stop:
   - `activeTool === "inspect"`;
   - selected point equals stop position;
   - `selectedNodeKind === "stop"`;
   - `selectedRouteId` remains/gets the route;
   - `activeCommandDestination === null`;
   - no gameplay/backend dispatch occurs;
   - no route draft exists.
2. station parity for `selectedNodeKind === "station"`.
3. active route draft -> reference-preserving/no-op behavior.
4. missing/deleted route or node -> no-op.
5. city replacement/reset clears selected route and point through existing `createUiState()` lifecycle.

Separately, make the full App loop a required jsdom test rather than optional callback coverage:

- start with `selectedRouteId` already set on a line with an at-risk location;
- call/follow `focusWaitLocation` so the inspector opens on that stop and the line stays selected;
- activate that inspector's serving-line chip;
- assert Lines opens with the **same** `selectedRouteId`, no route draft, and the same stop `selectedId` preserved.

This test is required because `selectRoute` toggles; a component-only "chip emitted route ID" test cannot catch an accidental deselection.

### 5.2 Implement `focusWaitLocation` as an explicit focused-navigation commit

Do not add a `UiState` field and do not spread `nextToolUiState("inspect", ui)`.

That generic helper intentionally clears `selectedRouteId`, and `gameRuntime.test.ts` already locks "switching to Inspect clears the selected route." HPA-464 must preserve that generic tool-switch contract.

After validating the route and present stop/station, commit the fields this action owns directly:

```ts
return commit(state, {
  ...ui,
  activeTool: "inspect",
  activeCommandDestination: null,
  selectedId: `${node.position.x},${node.position.y}`,
  selectedNodeKind,
  selectedRouteId: routeId,
  routeFailureFocus: null,
});
```

Keep the dead/draft/missing route or node paths as no-ops. Do not copy `focusRouteFailure`'s panel behavior: `focusWaitLocation` must explicitly close Lines so `InspectPanel` can mount.

### 5.3 Make the stop inspector show factual live waits

In `InspectPanel.svelte`:

- retain existing platform assignment controls;
- label header total as platform queue/capacity;
- make each serving-line chip/action accessible as an "Open service controls for …" action;
- show line-specific:
  - waiting count;
  - longest current wait or em dash/No current wait.

Keep the line wait row present at zero so the player can distinguish a serving line with no current wait from a line that does not serve the platform.

Add component tests for:

- total queue and per-line counts are labelled separately;
- zero line wait;
- non-zero longest wait;
- route action fires only the route ID;
- platform reassignment action still works.

### 5.4 Open existing Lines controls from the inspector

In App add a small handler:

1. if no runtime/snapshot, return;
2. if a draft is active, return (defensive; inspector should not be reachable while Lines is pinned);
3. if `snapshot.ui.selectedRouteId !== routeId`, call `runtime.selectRoute(routeId)`;
4. call `runtime.setCommandDestination("lines")`;
5. publish the resulting snapshot.

Do not call `selectRoute` when the same line is already selected because the existing method toggles selection. This non-toggle guard is part of the required App-level round-trip test from Task 5.1.

Do not clear `selectedId`; closing Lines should reveal the same stop inspector. `setCommandDestination("lines")` also toggles, but the inspector only renders while the destination is null, so this open-from-inspector call is not ambiguous.

### 5.5 Make the existing line warning local

In `LinesPanel.svelte`, keep the existing running + at-risk warning gate.

Under it, render only:

```ts
route.waitLocations.filter(location => location.atRiskCount > 0)
```

as buttons carrying route ID + node ID to a new `onFocusWaitLocation` callback.

Copy stays descriptive, for example:

```text
2 riders at risk
Bus Stop B · 1 at risk · 3m 10s
```

Do not add "Add bus/train", "capacity problem", "fixed", or before/after claims.

Panel tests must prove:

- warning location list is scoped to the route;
- raw `Longest wait` still renders independently from warning visibility;
- clicking location calls `onFocusWaitLocation(route.id, nodeId)`;
- explicit Edit still owns route geometry editing.

### 5.6 Wire App warning focus

Pass the callback to:

```ts
runtime.focusWaitLocation(routeId, nodeId)
```

This one call closes Lines, keeps route selection, and opens the existing contextual inspector.

### 5.7 Verify

```bash
bunx vitest run tests/runtime/gameRuntime.test.ts tests/ui/inspectPanel.test.ts tests/ui/linesPanel.test.ts tests/ui/appShell.test.ts
bun run check
```

If `inspectPanel.test.ts` does not exist before this task, create only that test file; do not introduce a panel test harness/framework.

Suggested commit:

```text
feat: navigate between wait locations and service controls
```

---

## Task 6 — Highlight selected line's live at-risk stops in the existing WebGPU overlay

**Files**

- Modify: `src/render/webgpu/overlayBatch.ts`
- Modify: `tests/render/webgpuOverlayBatch.test.ts`

### 6.1 Add failing rendering tests

Construct a state with:

- selected route route-001;
- two waiting-location rows for route-001, one at-risk and one raw-only;
- one at-risk row for route-002;
- current stop/station nodes for each row.

Assert:

- only route-001's at-risk node gets a wait-risk marker;
- route-001 raw-only location does not get the warning marker;
- route-002 location does not render while route-001 is selected;
- no route selected -> no wait-risk markers;
- duplicate platform rows for the same node produce one marker.

Use the existing recording/vertex helpers and current overlay palette semantics. Do not add screenshot-golden infrastructure.

### 6.2 Render from live frame rows, not UI state

Inside the existing overlay batch construction:

1. if `selectedRouteId === null`, skip;
2. filter `state.waitingLocations` by selected line and `atRiskCount > 0`;
3. resolve each `platformId` through current present stop/station platforms;
4. dedupe resolved node IDs;
5. draw a compact existing-style warning ring/outline.

Do not cache the node list in `UiState`. Frame updates must add/remove markers naturally.

Do not change route/vehicle selection emphasis, selected-building demand emphasis, route-failure focus, shaders, or render passes.

### 6.3 Verify

```bash
bunx vitest run tests/render/webgpuOverlayBatch.test.ts
bun run check
```

Suggested commit:

```text
feat: highlight selected line wait-risk stops
```

---

## Task 7 — Add one browser navigation journey and run the full gate

**Files**

- Modify: `tests/e2e/routes.spec.ts`
- Modify only integration code/tests uncovered by the browser flow.

### 7.1 Reuse the existing real-WASM route/service setup

Extend the current HPA-48 route E2E rather than creating a new sandbox/test framework.

The browser path does **not** need to manufacture a long wait and must not clone HPA-48's existing Add-vehicle journey. Use the selected-stop branch allowed by HPA-464:

1. ensure one route serves a visible stop;
2. select that stop using ordinary Inspect UI;
3. assert platform total and the serving line's current wait row are visible; zero wait is acceptable before simulation time elapses;
4. activate the serving-line control;
5. assert Lines opens on that same route with `routeDraft === null`;
6. close Lines;
7. assert the same `panel-inspect` returns and runtime `selectedId` is still the same stop.

HPA-48's existing routes E2E already asserts Add vehicle, fleet +1, daily-cost refresh, and no solved/success claim. Do not repeat those assertions here.

Do not use browser sleep/elapsed wall time to prove boarding or improved waits. Existing Rust lifecycle coverage owns boarding correctness; Tasks 1–2 own wait-row eligibility/classification.

If a warning-path UI can be exercised deterministically with an existing fixture at no extra framework cost, it may replace the selected-stop start; it is not required when Rust + jsdom coverage already pins the warning-focus round trip.

### 7.2 Run focused suites

```bash
cargo test -p caelum-core
bun run test:unit
bun run test:e2e -- tests/e2e/routes.spec.ts
```

Use the repository's actual Playwright filtering syntax if the script does not accept a path.

### 7.3 Run the complete repository gate

```bash
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
bun run test:unit
bun run test:e2e
bun run check
bun run lint:svelte
bun run lint:css
bun run format:check
bun run build
```

Any integration correction required by HPA-464 belongs on this same PR.

### 7.4 Final scope review

Before marking ready, inspect the branch diff and confirm:

- one new frame-only waiting-location row;
- no snapshot schema change;
- no persistence migration;
- no gameplay intent;
- no backend query;
- no per-citizen/trip wire payload;
- no new `UiState` wait-focus field;
- no renderer/shader/camera architecture change;
- no workplace-demand changes;
- no image assets;
- design + plan + implementation + tests remain one HPA-464 PR.

Suggested final commit if documentation needs synchronization:

```text
docs: sync HPA-464 implementation notes
```

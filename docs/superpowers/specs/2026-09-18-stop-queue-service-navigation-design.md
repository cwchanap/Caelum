# HPA-464 Stop Queue and Service Navigation Design

**Issue:** HPA-464 — Link stop queues and line warnings to service controls  
**Status:** Proposed for implementation on the same PR

## Summary

Connect the live waiting evidence Caelum already computes to the two places where the player needs it: the selected stop inspector and the existing Lines service controls.

The slice stays deliberately small:

- Rust continues to own waiter eligibility, platform-capacity admission, current-leg wait duration, and target-relative at-risk classification.
- Add one compact frame-only aggregate row per **serving line + platform** that currently has service-eligible waiting riders.
- Keep existing platform queue occupancy/capacity as a separate total. Do not reinterpret it as the sum of per-line health rows.
- Extend the stop inspector so each serving line shows its current line-specific waiting count and longest wait, and the line chip opens HPA-48's existing operating controls.
- Make the existing line warning local by listing the actual at-risk stops for that line and letting the player focus one in the existing inspector.
- Reuse `UiState.selectedRouteId`, `selectedId`, and `selectedNodeKind`. Add no wait-navigation manager or durable focus state.
- When a line is selected, the existing WebGPU overlay derives at-risk stop emphasis directly from the newest frame rows; no second renderer path or stored highlight list.
- Keep queue/wait feedback descriptive. Changing a target or buying a vehicle refreshes ordinary frame values but never claims the service problem was solved.

No snapshot/schema change, persistence migration, gameplay intent, backend query, historical store, recommendation engine, camera work, or image asset is needed.

## Existing seams

Current `main` already provides the important boundaries:

- `platforms.rs::platform_waiter_candidates` identifies only `TripStatus::Waiting` trips whose current non-walk leg has a real serving platform.
- `on_platform_trip_ids` applies the platform-capacity admission rule used by route health.
- `platform_waiters_by_line` filters capacity overflow before route-health calculation, so onboard riders, future trips, wrong-location riders, and shared-platform overflow do not inflate line health.
- `service_control.rs::waiting_health_by_line` owns the target/patience rule and `current_leg_wait_seconds`.
- `PresentationFrame` already carries compact platform occupancy and service metrics on every tick.
- `runtimeSelectors.ts::buildInspector` already joins selected transit nodes to platform occupancy and route assignment.
- `UiState.selectedRouteId` and `RuntimeController.selectRoute(...) ` already select/highlight a line without editing geometry.
- `selectedId` / `selectedNodeKind` already own the contextual stop/station inspector.
- `LinesPanel` already exposes HPA-48 target editing, fleet guidance, daily cost, raw longest wait, warning count, and explicit vehicle addition.
- WebGPU already renders route selection and contextual overlays from `GameState + UiState`.

HPA-464 should extend those seams rather than introduce a diagnostics subsystem.

## Approaches considered

### A. One Rust line/platform wait-location aggregate — chosen

Derive one live row for each line/platform pair that has at least one capacity-admitted waiting rider. Project it through the existing frame wire and join it to static stop/station data in TypeScript.

This keeps simulation truth in Rust, bounds output by active line/platform relationships rather than citizens, and gives both the stop inspector and line-warning UI the same evidence.

### B. Recompute stop queues from TypeScript scene/trip state

Rejected. The frontend no longer receives latent trip rows and should not reconstruct simulation eligibility. It would also duplicate platform-capacity admission and current-leg wait rules.

### C. Add a backend query when the player opens a stop

Rejected. The data is already live frame state and must refresh while the simulation runs. A query adds synchronization and host parity work for no benefit.

### D. Store a separate wait-location focus/navigation state

Rejected. Existing line selection plus selected stop/station point already models the required navigation. Live at-risk locations can be derived from the frame and selected route.

## Rust wait-location authority

### Preserve platform total semantics

Keep `platform_waiting_occupancy` unchanged.

It intentionally counts every real waiting candidate at the platform, including riders beyond boarding capacity. Existing tests pin that a platform may show, for example, queue `2 / capacity 1` while only one rider is admitted by `on_platform_trip_ids`.

That total answers a different question from route health:

- **Platform queue** — everyone physically waiting at that serving platform.
- **Line wait row** — riders currently admitted by the same eligibility/capacity rule used by route health, grouped by their current line.

The UI must label these separately and must not imply that per-line rows sum to the platform queue when capacity overflow exists.

### Group admitted waiters by line and platform

Replace or extend the current line-only grouping with one crate-private helper that preserves the platform identity after capacity admission.

A lean shape is:

```rust
pub(crate) fn platform_waiters_by_location(
    state: &GameSnapshot,
) -> BTreeMap<(String, String), Vec<&ActiveTrip>>
```

The key is `(line_id, platform_id)`.

The helper must continue to:

1. start from `platform_waiter_candidates`;
2. apply the exact `on_platform_trip_ids` admission set;
3. include each admitted trip in exactly one current line/platform group.

Do not change candidate ordering, shared-platform capacity semantics, or boarding logic.

### Derive raw wait and warning evidence once

In `service_control.rs`, derive a small internal location row:

```rust
struct WaitingLocationHealth {
    waiting_count: u32,
    at_risk_count: u32,
    longest_wait_seconds: f64,
}
```

Rows exist only when `waiting_count > 0`, so the longest wait is non-null internally.

For each admitted trip:

- increment `waiting_count`;
- update longest wait from `current_leg_wait_seconds(trip)`;
- increment `at_risk_count` only when the line has a target and the existing rule matches:
  - current-leg wait is greater than the target, **or**
  - remaining patience is at most `MIN_HEADWAY_SECONDS`.

The current per-line `ServiceMetrics.waitingAtRiskCount` / `longestWaitSeconds` continues to be derived from the same location rows rather than a second independent waiter pass.

Preserve the existing service-metric contract for lines without a target; HPA-464 does not redefine HPA-48's line-level metric availability.

## Presentation wire

Add one frame-only row:

```rust
#[serde(rename_all = "camelCase")]
pub struct WaitingLocationPresentation {
    pub line_id: String,
    pub node_id: String,
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

to `PresentationFrame`.

`node_id` is presentation metadata, not simulation state. Build a small platform-id → node-id lookup in `presentation.rs` from the current present stops/stations, then map the Rust line/platform health rows into deterministic presentation rows.

Properties:

- frame-only, never persisted;
- no citizen/trip IDs;
- one row per non-empty line/platform group;
- deterministic ordering by line/node/platform;
- no zero rows;
- no new scene resend trigger;
- no new backend method.

TypeScript adds the matching `WaitingLocationView` to `GameState` and copies `update.frame.waitingLocations` through the existing `applyPresentationUpdate` fold.

## Stop inspector

### View model

Extend `ShellPlatformRoute` with only the live values the panel consumes:

```ts
waitingCount: number;
atRiskCount: number;
longestWaitSeconds: number | null;
```

For each selected platform + serving route:

- find the matching `waitingLocations` row;
- no row means `waitingCount = 0`, `atRiskCount = 0`, and `longestWaitSeconds = null`;
- retain current route name/color and platform reassignment targets.

Do not aggregate across platforms in the inspector. The panel is already platform-shaped.

### Copy

Keep the current platform header, but label the existing occupancy clearly as the platform total, for example:

```text
Platform A
Platform queue 4 / 2 capacity

Blue Line
Line wait 1 · longest 1m 30s
```

For zero line wait, render a compact factual zero state rather than hiding the serving line:

```text
Line wait 0 · longest —
```

Do not add the longest waits together or present line counts as components of the platform total.

### Open service controls from the route chip

Make the existing route chip/action in `InspectPanel` open the Lines command panel on that route.

Do not dispatch a gameplay intent and do not create a route draft.

At App level:

1. if the requested route is not already `selectedRouteId`, call existing `runtime.selectRoute(routeId)`;
2. call existing `runtime.setCommandDestination("lines")`;
3. retain the selected stop point.

Guard against the current toggle behavior: do not call `selectRoute` when the same route is already selected, or it would deselect it.

Closing Lines therefore reveals the same stop inspector again, preserving the player's place on the map.

An active route draft keeps the existing pinned Lines editor/Save/Cancel gate; HPA-464 never replaces it.

## Make line warnings local

### Shell route locations

Derive per-route wait locations in `runtimeSelectors.ts` from `GameState.waitingLocations`.

Create a small shell row such as:

```ts
interface ShellRouteWaitLocation {
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

Use existing scene nodes and `waypointLabel(...) ` for player-facing labels.

`ShellRouteListItem.waitLocations` contains current non-empty rows for that line. The existing warning count remains `route.service.waitingAtRiskCount`; focused tests must pin that its value equals the sum of location `atRiskCount` values under the current target semantics.

### Lines panel

Keep the current warning gate:

```text
route.status.primary === "running" && waitingAtRiskCount > 0
```

Under that warning, render only the locations whose `atRiskCount > 0`. Each location is an explicit button into the stop/station inspector, for example:

```text
2 riders at risk
[Bus Stop B · 1 at risk · 3m 10s]
[Bus Stop D · 1 at risk · 2m 40s]
```

This is evidence, not a diagnosis. Do not append "add a bus", "insufficient capacity", "problem solved", or an improvement percentage.

A target edit may clear `atRiskCount` while raw waiting rows and longest waits remain. A vehicle purchase may change fleet/cost immediately while wait rows change only through ordinary simulation.

## Focus an at-risk location without a new state machine

Add one small UI-only controller action:

```ts
focusWaitLocation(routeId: string, nodeId: string): RuntimeSnapshot
```

It does not add a `UiState` field.

Behavior:

1. no-op when dead or a route draft is active;
2. verify the route and present stop/station still exist;
3. reuse `nextToolUiState("inspect", ui)` to clear placement/road tool state and close the command panel;
4. set the existing selected point and `selectedNodeKind` from the resolved node;
5. set `selectedRouteId = routeId`;
6. clear `routeFailureFocus`.

Result:

- the line stays highlighted;
- the chosen stop/station opens in the existing contextual inspector;
- no backend dispatch occurs;
- no location ID is stored beyond existing selection state.

This is the only new runtime navigation method required.

### Stale state

Do not add custom stale-reference cleanup for derived wait rows.

- Waiting rows disappear automatically on the next frame when the line/node/waiter no longer exists.
- Existing successful `deleteRoute` already clears the selected route.
- City replacement/reset already rebuilds `UiState` from `createUiState()`, clearing selected route and selected point.
- A focused stop uses the existing point/node-kind inspector state rather than a new wait-location reference.

Cover one city-replacement or selected-route-deletion case in runtime tests.

## WebGPU at-risk stop emphasis

When `ui.selectedRouteId` is non-null, the existing overlay batch may derive live at-risk node markers from:

```ts
state.waitingLocations.filter(
  row => row.lineId === ui.selectedRouteId && row.atRiskCount > 0
)
```

Resolve `nodeId` to the current stop/station position and draw a small existing-style warning ring/outline at each unique node.

Constraints:

- no new UI state;
- no new shader, canvas fallback, render loop, camera state, or persistent marker cache;
- deduplicate by node ID if multiple platform rows ever point to the same node;
- selected route remains the gate, so unrelated warning locations are not drawn;
- rows disappearing on a frame removes markers automatically.

Use an existing warning semantic from the overlay palette; do not introduce an Office/Factory/route-specific renderer taxonomy.

## Interaction flows

### Selected stop → line controls

1. Player selects a stop/station with Inspect.
2. Inspector shows platform queue/capacity plus per-serving-line live wait evidence.
3. Player activates a line chip.
4. Existing Lines panel opens with that line selected; no route draft exists.
5. Player edits target or explicitly adds one vehicle.
6. Fleet/cost refresh through the normal applied dispatch; queue/wait rows refresh on normal presentation frames.
7. Closing Lines returns to the same selected stop.

### Line warning → affected stop → line controls

1. Lines shows the existing at-risk count plus concrete affected stop buttons.
2. Selected line's current at-risk stops are also emphasized on the map.
3. Player chooses a stop button.
4. Runtime switches to Inspect, keeps the line selected, and focuses that stop.
5. Inspector shows the same line/platform wait evidence.
6. Player reopens the line controls from the serving-line chip.

No path enters geometry editing unless the player explicitly presses Edit.

## Verification strategy

### Rust authority

Focused tests must prove:

- onboard riders, future/non-waiting trips, wrong-location riders, and platform-capacity overflow do not enter line/platform wait-location rows;
- shared-platform admitted riders appear exactly once under their current line;
- waiting count, longest current-leg wait, and at-risk count use the same rules as existing route health;
- the sum/max of location rows agrees with current per-line `ServiceMetrics`;
- a controlled at-risk waiting rider actually boards before patience expires in a lifecycle/integration test, so a later queue reduction is not treated as sufficient proof by itself.

Keep existing platform occupancy overflow characterization unchanged.

### TypeScript/UI

Focused tests cover:

- presentation fold installs/replaces `waitingLocations` on frame updates;
- stop inspector shows platform total separately from per-line waiting/longest-wait values;
- serving-line action opens/selects existing service controls without a draft;
- warning shows only real at-risk locations for that line;
- focusing a warning location selects the existing stop/station inspector and retains line selection;
- target-relative warning can disappear while raw wait evidence remains;
- selected route WebGPU overlay emphasizes only its current at-risk nodes;
- one stale-selection case through existing lifecycle handling.

### Browser path

Use one representative real-WASM browser journey, preferably extending the existing routes E2E setup rather than adding a new scenario framework:

```text
selected stop
→ serving line
→ Lines operating controls
→ explicit Add vehicle
→ refreshed fleet/daily-cost + current queue/wait display
```

Do not rely on elapsed browser time to prove queue improvement. Rust owns the deterministic waiting/boarding proof.

## Non-goals

- workplace-demand visualization (HPA-463);
- per-citizen/trip presentation rows;
- global alerts/inbox;
- recommendation or causal-diagnosis engine;
- historical wait series, daily ledger, before/after chart;
- automatic vehicle purchase/removal/rebalancing;
- route optimizer or demand forecast;
- backend query/API;
- schema/persistence change or migration;
- camera changes;
- new art or generated assets.

## Delivery

One Linear ticket = one GitHub PR.

The same HPA-464 PR carries design, implementation, focused tests, browser integration, and final repository checks. Do not split implementation, renderer cleanup, QA, or closeout into follow-up PRs.

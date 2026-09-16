# HPA-48 Deployed Service Tuning Implementation Plan

> **Design:** `docs/superpowers/specs/2026-09-15-deployed-service-tuning-design.md`

## Outcome

A running Bus or Metro line can be selected and tuned from the Lines panel without entering route geometry edit. The player may change the deployed target headway, let Rust recompute the fleet requirement, and use the existing one-vehicle top-up action when the new target creates a shortfall.

Keep this on the existing HPA-628 service-control seams. No new fleet manager, schema, intent, renderer path, or asset work.

## Task 1 — Unlock deployed target editing in Rust

**Files**

- Modify: `crates/caelum-core/src/service_control.rs`
- Modify: `crates/caelum-core/tests/service_control.rs`

### 1.1 Replace the old lifecycle-lock test first

Find the service-control coverage that currently expects `SetServiceTargetHeadway` to return `FleetAlreadyAssigned` after deployment.

Replace that expectation with tests for both Bus and Metro proving a deployed target can change.

For the preservation case, snapshot the line's existing vehicles before dispatch and compare after dispatch:

- vehicle IDs;
- itinerary/path cursor fields;
- parked position;
- passenger IDs;
- budget.

The target should change; those values should not.

Add focused assertions for:

- target `< MIN_HEADWAY_SECONDS` still -> `InvalidHeadway`;
- tighter target -> larger live `required_fleet` and non-null `next_vehicle_cost` when assigned fleet is short;
- looser target -> lower/equal `required_fleet`, unchanged assigned fleet, no vehicle removal;
- a second `DeployInitialFleet` still -> `FleetAlreadyAssigned`.

Run the focused test before implementation and confirm the new deployed-edit expectation fails for the current fleet lock.

```bash
cargo test -p caelum-core --test service_control
```

### 1.2 Remove only the post-deployment lock

In `service_control::set_service_target_headway`:

- keep line/mode resolution;
- keep the 60-second minimum validation;
- remove the `vehicle_count > 0 -> FleetAlreadyAssigned` branch;
- update the function comment from "pre-deployment target" to the persistent service target;
- continue changing only `target_headway_seconds` on the matching Bus/Metro line.

Do not change `deploy_initial_fleet`, `add_service_vehicle`, `top_up_offer`, vehicle placement, CostPolicy, or any wire type.

### 1.3 Verify Rust behavior

```bash
cargo test -p caelum-core --test service_control
cargo test -p caelum-core
```

Commit once the Rust contract is green.

Suggested commit:

```text
feat: allow deployed service headway retargeting
```

## Task 2 — Separate line inspection from route geometry editing

**Files**

- Modify: `src/components/hud/panels/LinesPanel.svelte`
- Modify: `src/App.svelte`
- Modify: `tests/ui/linesPanel.test.ts`
- Modify only if needed: `tests/ui/appShell.test.ts`

`RuntimeController.selectRoute(routeId | null)` already exists and is already covered in runtime tests. Reuse it; do not add another runtime/UI state concept.

### 2.1 Pin the interaction contract in component tests

Update `linesPanel.test.ts` so the primary line summary is expected to:

```text
onSelectRoute(route.id)
```

and explicitly **not** call `onEditRoute`.

Add/adjust a second assertion for an `Edit route` button/action that calls:

```text
onEditRoute(route.id)
```

exactly once.

Keep the existing `route.selected` visual assertion so selection remains a view-model concern rather than component-local state.

### 2.2 Restore the selection callback to LinesPanel

Add to the Lines panel props:

```ts
onSelectRoute: (routeId: string | null) => void;
```

Change the current primary `route-select` click from `onEditRoute(route.id)` to `onSelectRoute(route.id)`.

Use a clear accessible name such as `Select ${route.name}` instead of implying geometry editing.

Add one explicit `Edit route` control alongside the existing row actions. It should call the unchanged `onEditRoute(route.id)` path.

Do not make selection automatically pause service or change the active tool.

### 2.3 Wire App to the existing runtime seam

Add/restore the small App handler:

```ts
function handleSelectRoute(routeId: string | null): void {
  if (runtime !== null) {
    setSnapshot(runtime.selectRoute(routeId));
  }
}
```

Pass it to `LinesPanel`/the relevant HUD composition next to `onEditRoute`.

Do not modify `createGameRuntime.ts` or `runtime/types.ts` unless current code proves the existing `selectRoute` contract is missing; the baseline already exposes it.

### 2.4 Verify component/runtime shell tests

```bash
bun run test:unit -- tests/ui/linesPanel.test.ts tests/ui/appShell.test.ts
```

If Vitest project filtering ignores explicit paths under this script, run the direct equivalent:

```bash
bunx vitest run tests/ui/linesPanel.test.ts tests/ui/appShell.test.ts
```

Suggested commit:

```text
feat: separate line selection from route editing
```

## Task 3 — Reuse the target editor for deployed lines

**Files**

- Modify: `src/components/hud/panels/LinesPanel.svelte`
- Modify: `tests/ui/linesPanel.test.ts`

### 3.1 Add deployed-target UI tests first

For both Bus and Metro route fixtures with `assignedFleet > 0`:

- assert the target input is visible;
- enter a valid whole-minute value;
- click Set;
- assert `onSetServiceTargetHeadway(route.id, minutes * 60)` once.

Keep the current invalid-input tests; TypeScript validation remains convenience only and Rust stays authoritative.

Also retain the existing assertions for:

- Target;
- Nominal;
- assigned/required Fleet;
- Daily cost;
- long-wait warning;
- Add bus/train button iff `nextVehicleCost !== null`.

### 3.2 Remove presentation duplication, not domain behavior

Reshape the service block so the same target display/editor is available regardless of `assignedFleet`.

A lean shape is:

```text
common Target + target editor
if no fleet:
  Required
  Est. deploy cost
  Est. daily cost
  Deploy fleet
else:
  Nominal
  Fleet assigned / required
  Daily cost
  existing wait warning
  existing Add bus/train offer
```

Reuse the existing `headwayMinuteDrafts`, `commitHeadway`, `headwayMinuteValue`, and callback. Do not create a second headway form component unless the Svelte template becomes materially harder to read after the move.

Do not calculate `requiredFleet`, top-up eligibility, or vehicle cost in Svelte.

### 3.3 Verify UI tests

```bash
bunx vitest run tests/ui/linesPanel.test.ts
```

Suggested commit:

```text
feat: expose target tuning on deployed lines
```

## Task 4 — Add one representative operating-flow E2E

**Files**

- Modify: `tests/e2e/routes.spec.ts`
- Reuse existing helpers; avoid adding a new E2E helper layer unless an exact helper is already missing from multiple tests.

### 4.1 Build a deterministic Bus case

Use the existing route/service fixture style to create a route whose round trip is comfortably above the 60-second minimum.

Flow:

1. create the Bus line;
2. set a loose initial target and deploy its initial fleet;
3. leave route geometry edit mode;
4. click the normal line summary;
5. assert the line becomes selected/highlighted while `snapshot.ui.routeDraft === null`;
6. record original vehicle IDs/state and budget;
7. set a tighter valid target that produces `requiredFleet > assignedFleet`;
8. read the post-retarget runtime snapshot rather than deriving the requirement in the test;
9. assert original fleet state is preserved by retargeting;
10. record Rust-provided `nextVehicleCost`;
11. click Add bus once;
12. assert assigned fleet is exactly `before + 1` and budget falls by the recorded Rust cost;
13. assert geometry edit was never entered during selection/retarget/top-up.

Do not duplicate this browser journey for Metro; Bus/Metro parity belongs in Rust/component tests.

### 4.2 Run the focused route suite

```bash
bun run test:e2e -- tests/e2e/routes.spec.ts
```

Suggested commit:

```text
test: cover deployed service tuning flow
```

## Task 5 — Regression and quality gates

No generated image/art task is required.

Run the normal repository gates after the focused tests are green:

```bash
cargo test --workspace
bun run check
bun run test
bun run lint
bun run format:check
bun run test:e2e
bun run build
```

Tauri-specific code is not changing, so do not add a new Tauri harness. Existing critical Tauri/host coverage must remain green through the normal suite/build gates.

## Scope guard during implementation

Stop and keep the ticket small if implementation starts asking for any of the following:

- desired fleet count separate from target headway;
- automatic purchase/removal after target change;
- vehicle sale/refund/reassignment;
- depot or timetable model;
- peak/off-peak target bands;
- re-spacing existing vehicles;
- new wait/bunching metrics;
- new service-details page/modal;
- renderer/camera changes;
- save/wire/schema changes.

Those are follow-up product decisions, not prerequisites for this operating loop.

## PR rule

Continue implementation on this same HPA-48 branch and draft PR. Do not split design, implementation, and tests into separate PRs.

# HPA-183 — Save & Run and Coverage Hover — Implementation Plan

> **Design:** [2026-10-25-hpa-183-save-run-coverage-design.md](../specs/2026-10-25-hpa-183-save-run-coverage-design.md)  
> **Linear:** [HPA-183](https://linear.app/cwchanap/issue/HPA-183/run-a-new-transit-line-straight-from-save)  
> **PR policy:** Design and implementation remain in this **one draft PR**. No follow-up coding PR.

## Outcome

- Newly created Bus/Metro routes have a **Rust-owned 600-second starter target**.
- The new-draft **Save & run** button creates the line and purchases the initial fleet via two existing intents.
- When the purchase is rejected, the route is still saved and configured; the existing **No fleet** / **Deploy fleet** path stays usable.
- Ordinary Bus Stop and Metro Station tools preview the coverage square under the pointer.
- No new architecture, persisted field, compound Rust command, art, or sound.

## Task 1 — Pin and implement the Rust create default

**Modify:**
- `crates/caelum-core/src/service_control.rs`
- `crates/caelum-core/src/route_editor.rs`
- `crates/caelum-core/tests/service_control.rs`
- Relevant targeted Rust tests that explicitly assert a newly created route's target is null

### Tests first

- Verify a newly `CreateRoute`-created Bus route and a Metro line each carry `target_headway_seconds == Some(600)` but `vehicle_ids` remains empty.
- Keep the meaning of `HeadwayNotSet` for an **explicitly restored** route with `target_headway_seconds: None`. In `deployment_requires_target_and_existing_route_state`, take `bus_route_engine().snapshot_for_save()`, clear the route target, and restore through `GameEngine::from_snapshot` before dispatching `DeployInitialFleet`.
- Update the `engine_snapshot_publishes_metro_service_metrics` expectation: a new Metro line now has a required fleet/deployment estimate based on a 600-second target. Retain its zero-assigned-fleet and zero-operating-cost assertions. Use a deliberately null-target restored snapshot only if testing the legacy `required_fleet == None` behavior separately is still valuable; do not duplicate coverage.
- Check other narrowly affected fixtures for old `None` expectations; do not weaken tests unrelated to the default.

### Implementation

1. Add `pub const DEFAULT_TARGET_HEADWAY_SECONDS: u32 = 600;` next to `MIN_HEADWAY_SECONDS` in `service_control.rs`.
2. Import it into `route_editor.rs`.
3. In `insert_route`, initialize both Bus and Metro `target_headway_seconds: Some(DEFAULT_TARGET_HEADWAY_SECONDS)`.
4. Do **not** add vehicles in Rust `CreateRoute` or change `UpdateRoute`, `DeployInitialFleet`, serialization, or restoration.

**Verify:** `cargo test -p caelum-core --test service_control`.

## Task 2 — Compose route create + deploy using the existing runtime

**Modify:** `src/runtime/createGameRuntime.ts` and `tests/runtime/gameRuntime.test.ts`

### Reuse test coverage rather than add parallel tests

Update existing runtime tests:

- `successful creation save dispatches one atomic intent` (~line 4161): change expected two-intent sequence to `createRoute` → `deployInitialFleet`. Keep the no-`assignVehicle` assertion.
- `keeps an accepted atomic snapshot even when the backend surfaces no new id` (~line 4636): preserve its fake backend that reports an applied create with no new scene ID, and assert **no `deployInitialFleet`**, with the accepted scene retained.
- `does not duplicate a route on concurrent Saves` (~line 4661) and `deduplicates deferred Saves for the same draft` (~line 4683): expect exactly **one create and one initial fleet deployment**, not a fleet-free line. For deferred tests, release both operations explicitly in queue order.
- In the existing real-`createWasmBackend()` route/preview flow (~line 4175), assert the newly created Bus line has a 600-second target and Save & run ends with assigned vehicles. This is the primary actual-Rust happy-path check.
- Cover Metro through the same runtime Save flow (real WASM if track fixture setup remains small, otherwise the existing fake backend).
- Add **one focused budget failure case** by locally overriding `dispatch({ type: "deployInitialFleet", ... })` to return a genuine-shaped `insufficientBudget` rejection; assert saved route/target, no vehicles, closed editor, feedback, and existing manual fallback. Do not extend the general fake backend with full Rust pricing/authorizer rules.
- Reuse existing edit/rejection/supersession cases; assert that edit only sends `updateRoute` and does not buy another fleet. Add no standalone duplicate-save suite.

### Implementation

1. Extract one **unqueued** local `dispatchNow(intent, nextUi?)` containing the already duplicated `backend.dispatch` → backend error/rejection handling → `commitDispatchResult` logic from `enqueueDispatch` and `enqueueComputedDispatch`. Keep their `queueBackend` wrapper around it. Do not change their public controller contracts.
2. In `saveRouteDraft`, preserve the current token, preview eligibility, and update/edit behavior. For a **create** intent, compute the relevant mode's existing IDs when its queue operation runs.
3. After `createRoute` is **accepted**, commit that result **immediately through existing token-aware code**, including dirty/scene revision and route-draft lifecycle. Do not hold its presentation update until a later dispatch.
4. Diff the accepted **create scene** against the captured IDs; only when `newIds.length === 1` continue with `await dispatchNow({ type: "deployInitialFleet", lineId: newIds[0] })` within that same queue item. No `setServiceTargetHeadway` dispatch: Rust has already set the default.
5. On `newIds.length !== 1`, stop. The accepted route retains the Rust default and any visible undeployed line can use the existing Deploy control. Reuse the existing no-new-ID test; do not add a second multi-ID-only test or fabricate an error.
6. If fleet deployment rejects for budget, `dispatchNow` handles the rejection via the existing global feedback; no rollback. Keep the existing `saveRouteDraft` exception handling, particularly superseded-token behavior.

### Important correctness invariant

The existing `saveRouteDraft` superseded-save error handler can suppress an eventual host exception in favor of keeping a newer draft alive. **Commit the accepted create before awaiting deploy**, or a later thrown dispatch could leave Rust with a new line while TypeScript has neither the line nor a dirty save mark. A transient intermediate **No fleet** presentation frame during Tauri IPC is acceptable; do not build publish-once accumulation, a rollback saga, or another queue.

**Verify:** `bun run test -- tests/runtime/gameRuntime.test.ts`.

## Task 3 — Label new drafts only

**Modify:** `src/components/hud/panels/RouteEditor.svelte` and `tests/ui/routeEditor.test.ts`

- `editor.source === "create"` → **Save & run**.
- `editor.source === "edit"` → **Save route**.
- Preserve preview-pending `Checking route…` text, disabled status, existing button handler and cancel/reload controls.
- Retarget existing UI test text selectors; no new component API or secondary button.

**Verify:** `bun run test -- tests/ui/routeEditor.test.ts`.

## Task 4 — One coverage-square renderer helper

**Modify:**
- `src/render/webgpu/overlayBatch.ts`
- `src/domain/catalog/transit.ts`
- `tests/render/webgpuOverlayBatch.test.ts`

1. Introduce `drawCoverageSquare(g, center, radius)` in the renderer and reuse it in both persisted coverage loops and placement-hover drawing.
2. Export a named **Metro Station radius = 4** next to `stopCoverageRadius` in `domain/catalog/transit.ts`. Continue using `stopCoverageRadius` (Bus Stop radius = 2).
3. In `drawDataOverlays`, render hover-only coverage when `ui.hoverTile` is in map bounds and `ui.activeTool` is `busStop` or `metroStation`, regardless of whether Coverage overlay is selected.
4. Retain existing under-marker paint order and existing placement validity marker. `busStop`'s existing preview branch lacks its own map guard, so apply the in-bounds check when adding the coverage square.
5. **Bus Terminal is excluded**: its placement uses `selectedBuilding` / building preview, not the Bus Stop tool. No new terminal preview.
6. Extend the current vertex/alpha overlay tests for exact 5×5 and 9×9 footprints, missing/out-of-bounds hover, and tool switching. Use existing helpers; no new GPU pipeline.

**Verify:** `bun run test -- tests/render/webgpuOverlayBatch.test.ts`.

## Task 5 — Update E2E player-flow expectations

**Modify as needed:** `tests/e2e/routes.spec.ts`, `tests/e2e/commandShelf.spec.ts`, `tests/e2e/roundabouts.spec.ts`.

- Replace `Save route` locators with `Save & run` **for new route drafts only**.
- Invert the current fleet-free-on-Save Bus assertions: use existing `readRuntimeTransit` to poll for one saved route and non-empty assigned vehicles after Save & run.
- Assert Metro Save & run also deploys an initial fleet.
- Rework the existing manually-deploying route E2E flow to **edit an already running service**; avoid a second `DeployInitialFleet` after creation.
- Update `No fleet` assumptions only where the user clicked new-draft Save & run; retain valid direct Rust/fleet-free fixture cases or explicit insufficient-budget cases.
- No exhaustive Tauri vs WASM UI matrix.

**Verify:**

`bun run wasm:build`  
`bun run test:e2e -- tests/e2e/routes.spec.ts tests/e2e/commandShelf.spec.ts tests/e2e/roundabouts.spec.ts`

## Task 6 — Regression gate and manual smoke

Run from repository root:

`cargo test -p caelum-core`  
`bun run check`  
`bun run lint`  
`bun run test -- tests/runtime/gameRuntime.test.ts tests/ui/routeEditor.test.ts tests/render/webgpuOverlayBatch.test.ts`  
`bun run test:e2e -- tests/e2e/routes.spec.ts tests/e2e/commandShelf.spec.ts tests/e2e/roundabouts.spec.ts`  
`bun run format:check`

**Manual smoke:** Standard Sandbox Bus Save & run; Metro Save & run; insufficient-budget fleet rejection with saved configured line and Deploy fallback; editing a running line without auto-purchase; in-bounds Bus/Metro hover coverage and its removal on tool change/map exit.

**Definition of done**

- [x] Rust 600-second default applies to **new** Bus/Metro only; null-target restored state still rejects deployment
- [x] One serialized Save & run dispatches **create → deploy**, with no TypeScript headway-setting intent
- [x] Accepted create is committed/dirty before deployment, even if later host work fails
- [x] Old in-flight Save and no-new-ID runtime tests are **updated**, not replaced by parallel suites
- [x] Failure, edit, duplicate Save and Metro behaviors are verified
- [x] Bus Stop/Metro hover geometry shares existing coverage math and paint order
- [x] Relevant E2E contract updates and all verification gates pass
- [x] Same PR; no new backend commands, permanent schema fields, migration support, SFX or art

## Task 6 — Verification record

- `rtk cargo test -p caelum-core` — reused Task 1 result: 814 passed, 3 ignored across 50 suites. Rust production is unchanged by the final review fix.
- `rtk bun run check` — passed after the final runtime change; WASM artifacts were up to date; TypeScript/Svelte reported 0 errors and 0 warnings.
- `rtk bun run lint` — passed after the final runtime change: ESLint, Stylelint, and `cargo clippy --workspace --all-targets -- -D warnings`.
- Save & run regression — RED failed at the expected `backendError` assertion after the saved route, 600-second target, no-fleet state, and dirty mark had succeeded. GREEN passed the failure and replacement/cancellation cases; the existing pre-acceptance supersession case still passes.
- `rtk bun run test -- tests/runtime/gameRuntime.test.ts` — 190/190 passed after the final runtime change.
- `rtk bun run test` — 55 files, 926 tests passed after the final runtime change.
- `rtk bun run test:e2e -- tests/e2e/routes.spec.ts tests/e2e/commandShelf.spec.ts tests/e2e/roundabouts.spec.ts --retries=0` — 22/22 passed after the final runtime change, reusing the existing local server.
- `rtk bun run format:check` — passed after formatting the new runtime tests (Prettier and `cargo fmt --all --check`).
- The prior headed Chromium smoke on real WASM verified Bus and Metro Save & run, edit without repurchase, genuine insufficient-budget rejection and manual Deploy fallback, plus Bus/Metro coverage hover and removal on map exit/tool change. It was not rerun for this exception-path fix; screenshots and details remain in ignored `.superpowers/sdd/2026-10-25-hpa-183-save-run-coverage/manual-smoke-report.md`.

No native Tauri UI/IPC or hosted/release run was performed; Rust test evidence is reused from Task 1, while the final review fix was verified in the shared runtime, browser/WASM, and Chromium paths.

### Post-push integration with current `origin/main`

The counts above are historical pre-integration evidence. This full gate ran against merge tree `8b5d0561f6cb0cc75aa00c9be15bc0c847313721`, with parents `6d22208a30c0f7a6215c64510622c2741b866880` (HPA-183) and `fb3d2b2d162f3dbb4e4a3f25c05a96a56d61261a` (`origin/main`). The only source change after these gates is this verification record.

- `rtk cargo test -p caelum-core` — 778 passed, 3 ignored across 49 suites; the lower count reflects main's campaign removal.
- `rtk bun run wasm:build` — passed. Frontend `ensure-wasm` hooks reported the generated artifacts up to date; no overlapping build ran.
- `rtk bun run test` — 56 files and 933 tests passed.
- `rtk bun run check` — passed; TypeScript and Svelte reported 0 errors and 0 warnings.
- `rtk bun run lint` — passed: ESLint, Stylelint, and workspace Clippy.
- `rtk bun run test:e2e -- tests/e2e/routes.spec.ts tests/e2e/commandShelf.spec.ts tests/e2e/roundabouts.spec.ts --retries=0` — 22/22 passed in 28.1 seconds against the existing healthy localhost:5281 server.
- `rtk bun run format:check` — passed: Prettier and `cargo fmt --all --check`.
- `rtk git diff --check` — passed before creating the merge commit.

The only conflict was `src/runtime/createGameRuntime.ts`. Resolution retains HPA-183's `dispatchNow` queue and accepted-create/dirty/deploy sequence while passing each original intent through main's notice-aware `commitDispatchResult`. Main's campaign removal and schema v14, nullable wire and `HeadwayNotSet` behavior, road-direction/broken-route feedback and styling remain present. The Rust and runtime test overlaps auto-merged cleanly.

No native Tauri UI/IPC, hosted/release, or remote CI gate was run in this integration pass. The controller completed a headed browser smoke against the integrated source: Bus and Metro each started with one vehicle and a 600-second target; reverse editing preserved budget and fleet; with budget zero, Save & run retained the configured Bus route without a vehicle and manual Deploy recovered; Bus/Metro hover coverage appeared and cleared on map exit/tool switch. The controller inspected updated screenshots: feedback icon sizing and error-panel readability are correct. The browser console showed only the missing `favicon.ico` 404 and no application errors.

## Review decisions adopted

The second-pass review correctly moves the 600-second default into Rust, removes the unnecessary `setServiceTargetHeadway` step and publish-once accumulation, and expands the regression gate to `cargo test -p caelum-core`. Keep the design at that size; do not introduce new infrastructure to guard one theoretically unreachable ambiguous-ID case.

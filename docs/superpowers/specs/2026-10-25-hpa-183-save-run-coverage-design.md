# HPA-183 — Save & Run and Transit Coverage Hover — Design

**Linear:** [HPA-183](https://linear.app/cwchanap/issue/HPA-183/run-a-new-transit-line-straight-from-save)  
**Repository:** `cwchanap/Caelum`  
**Baseline:** `main` at `eb183b7`, checked against the second-pass GitHub review  
**Delivery:** One PR for the design, plan, and eventual implementation; continue in this draft PR.

## Player outcome

Place stops, create a Bus/Metro line, select **Save & run**, and see its first vehicles without having to find a separate Deploy button. A newly built line that cannot afford a fleet remains saved with the existing **No fleet** status and manual **Deploy fleet** action.

While hovering an ordinary Bus Stop or Metro Station placement, preview the footprint used by the existing Coverage overlay.

This is a small gameplay polish change, not a new service-control or presentation framework.

## Verified seams and revised decision

- `crates/caelum-core/src/route_editor.rs` has one `insert_route` reached by route **creation**, not editing. It currently sets `target_headway_seconds: None` for Bus and Metro. New routes are active but fleet-free.
- `crates/caelum-core/src/service_control.rs` already owns the 60-second headway floor, required fleet math, prices, budget validation, and `deploy_initial_fleet`. Its `HeadwayNotSet` check is deliberate.
- The starter target influences how many vehicles Rust buys and therefore gameplay expenditure. **The default belongs in Rust** rather than in a TypeScript Save handler.
- `src/runtime/createGameRuntime.ts` already holds `saveRouteDraft` inside one serialized `queueBackend` item with an in-flight token and special handling for a superseded draft.
- `src/runtime/backend/types.ts` already supports `createRoute` and `deployInitialFleet`; no new intent or backend method is necessary.
- `src/runtime/createGameRuntime.ts` has two queue helpers duplicating result acceptance and publication. Their common unqueued dispatch work can be reused by Save & run.
- `src/render/webgpu/overlayBatch.ts` already renders saved coverage before hover/placement markers. `stopCoverageRadius` is available for a Bus Stop, and a Metro Station uses radius 4.
- `LinesPanel.svelte` already has the target editor and conditional Deploy fallback. New-line ID can be obtained by diffing complete pre/post Bus or Metro scene arrays rather than assuming an ID format.
- Several `tests/runtime/gameRuntime.test.ts` and browser E2E assertions still encode the previous fleet-free-on-Save contract. Update them in place.

## 1. Rust owns the initial service target

Add `pub const DEFAULT_TARGET_HEADWAY_SECONDS: u32 = 600` beside `MIN_HEADWAY_SECONDS` in `crates/caelum-core/src/service_control.rs`.

In the Bus and Metro branches of `route_editor::insert_route`, initialize `target_headway_seconds` to `Some(DEFAULT_TARGET_HEADWAY_SECONDS)` rather than `None`.

- This is a starting **10-minute headway** on every **newly created** Bus/Metro line, regardless of caller or host. It is editable afterward using the existing Lines controls.
- Creation remains fleet-free at the Rust intent level: no vehicles are purchased until an explicit `DeployInitialFleet`.
- `UpdateRoute` does not reset a player's target. Restored snapshots with an explicitly null target remain valid and `HeadwayNotSet` still protects them.
- No saved-schema change, backward-compatibility layer, UI-side default, additional service plan, or TS-side fleet calculation.

## 2. Save & run composes two existing intents

For a new draft only, keep the entire sequence within **one** serialized `queueBackend` save operation:

1. Capture the relevant mode's current line IDs **when the queued operation executes**.
2. Dispatch the existing `createRoute`. Use existing token-aware behavior to **commit its accepted presentation immediately**, mark the city dirty, and close only the still-current original draft.
3. If the create did not apply, stop. Keep the current draft and existing rejection handling.
4. From the accepted create scene, diff line IDs against the IDs from step 1. If **exactly one** ID is new, run `deployInitialFleet({ lineId })` in that same queue operation, directly through a small unqueued dispatch helper. If not exactly one, stop without guessing an ID.
5. Accept the fleet result through the normal dispatch path. On a budget rejection, keep the already committed line, its 10-minute target, and the genuine Rust rejection in the existing action-feedback banner.

Extract a small local `dispatchNow(intent, nextUi?)` from `enqueueDispatch` and `enqueueComputedDispatch` to share normal backend dispatch, rejection preservation, `commitDispatchResult` and dirty bookkeeping. **Do not queue a queued operation**, introduce a compound Rust intent, or add another manager.

**Commit every applied step before awaiting a subsequent host call.** Holding all updates until the end risks discarding the successful create presentation and dirty mark if a later dispatch throws after the original draft was superseded. A brief intermediary No fleet frame on a slow Tauri IPC call is an acceptable tradeoff; do not add publish-once accumulation or rollback.

### Outcomes

| Outcome | Player-visible result |
| --- | --- |
| Create accepted; deploy accepted | Saved, configured route with a running initial fleet |
| Create accepted; deploy rejected (budget) | Saved route, 10-minute target, No fleet, existing Deploy button and budget rejection |
| Create rejected | No new route or fleet; draft stays editable with existing rejection |
| Existing route edited | Plain Save; only `updateRoute`, no automatic fleet purchase |
| Create accepted but new ID cannot be uniquely resolved | Keep accepted scene and 10-minute target; no fleet or unrelated-line mutation, existing Deploy button remains available |

The ambiguous ID condition is an adapter-invariant guard, not a new user workflow. One `newIds.length !== 1` check is enough; **reuse the existing no-new-ID test**, avoid fabricated Rust errors or diagnostics plumbing, and do not add a parallel multi-ID test.

The existing save token still deduplicates rapid Saves. If the original draft is superseded while its create is in flight, preserve the newer editor state and ensure the old accepted create is committed before attempting deployment. No independent gameplay dispatch/tick may interleave inside the serialized two-step operation.

## 3. Hover coverage uses existing renderer geometry

In `src/render/webgpu/overlayBatch.ts`, use one local `drawCoverageSquare(g, center, radius)` helper for the existing persisted coverage and the hover-only footprint. Export one named Metro Station coverage radius (4) next to `stopCoverageRadius` in `src/domain/catalog/transit.ts` so both placed and hover Metro geometry share it.

- Bus Stop hover: **5×5** footprint (radius 2).
- Metro Station hover: **9×9** footprint (radius 4).
- Draw only for an in-map `ui.hoverTile` and the matching armed tool, whether or not Coverage overlay is selected.
- Continue using `colors.coverage` and the current data-overlay pass; the hover footprint is automatically **beneath** the placement marker. Preserve the placement validity indicator.
- No hovered footprint when the cursor leaves the map, the tool changes, or the tile is out of bounds.
- **Bus Terminal hover is out of scope**: terminal placement uses the building-preview path, not the `busStop` tool.
- Informational overlay only. Existing Rust placement and coverage/growth rules remain authoritative.

## 4. Test and scope decisions

Prefer modifying existing tests over introducing parallel variants:

- Replace the old `successful creation save dispatches one atomic intent` test and extend the existing duplicate/deferred Save assertions in `tests/runtime/gameRuntime.test.ts` to expect exactly **one create and one deployment**, not three intents.
- Reuse the existing `keeps an accepted atomic snapshot even when the backend surfaces no new id` test to prove the ambiguity guard does not deploy to another line.
- Use a **real `createWasmBackend()` happy path** for at least Bus, so the actual Rust default and purchase logic are tested. Cover Metro with the same route-save workflow. For budget rejection use one localized backend override returning the existing Rust rejection shape rather than expanding a fake engine.
- Pin Rust creation defaults for Bus/Metro and update the small number of intentionally target-less fixtures/tests by explicitly restoring a snapshot with `target_headway_seconds: None`. In particular check `deployment_requires_target_and_existing_route_state` and `engine_snapshot_publishes_metro_service_metrics` in `tests/service_control.rs`.
- Migrate E2E assertions in `routes.spec.ts`, `commandShelf.spec.ts`, and `roundabouts.spec.ts` that currently expect `Save route` / fleet-free creation.
- Exercise renderer coverage vertices with the existing overlay test helpers.

Out of scope: placing stops while drawing a route; dynamic headway balancing; automatic post-deploy top-up; new Rust `SaveAndRun` intent; new backend/host APIs; save migration; notification subsystem; new art or SFX.

## Acceptance criteria

1. New Bus and Metro routes receive a 600-second Rust-owned starting target while remaining fleet-free until deployment.
2. One Save & run creates and deploys exactly one initial fleet in both modes. The create and deploy are serialized, and existing edit paths preserve their target/fleet.
3. Budget-rejected or ambiguous-ID deployment retains the saved line and configured target, with an existing manual Deploy recovery; a rejected create leaves the original draft open.
4. Duplicate and superseded saves cannot duplicate fleets or lose the accepted route from the frontend/save dirty state.
5. Ordinary Bus Stop / Metro Station coverage hover matches saved coverage; no Bus Terminal hover or new art.
6. Updated Rust, runtime, UI, renderer, and browser tests validate the changed contract using existing fixtures and tests wherever possible.

**Tradeoff accepted:** The 600-second default changes the behavior of all new Rust-created lines, not just Save & run. This keeps the gameplay rule in the core and avoids a UI-only configuration path.

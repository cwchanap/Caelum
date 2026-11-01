# HPA-585 — Undo Last Build — Implementation Plan

> **Design:** [2026-10-31-hpa-585-undo-last-build-design.md](../specs/2026-10-31-hpa-585-undo-last-build-design.md)  
> **Linear:** [HPA-585](https://linear.app/cwchanap/issue/HPA-585/undo-the-last-build-with-a-full-refund)  
> **PR policy:** This **single draft PR** is the planning and future implementation PR. Continue with code and tests on this branch; **do not open a separate implementation PR**.

## Goal and approach

Deliver Ctrl/Cmd+Z for the most recent successful construction action, exactly once, inside one game hour, with full **actual** refund and conservative route/tile conflict checks. Keep Rust authoritative, WASM and Tauri thin, and use the existing serial gameplay queue, action-feedback banner and keyboard handler. No redo, generalized history or persistence schema bump.

**Critical clock fact:** one day is `clock::GAME_DAY_SECONDS = 1_200.0` in `GameSnapshot.time`; the undo window is `GAME_DAY_SECONDS / 24.0` (50 engine-time seconds), **not 3,600**.

## 1. Core tests first: structural undo and the one-hour gate

**Files:** new `crates/caelum-core/tests/build_undo.rs` (or extend `engine_topology.rs` if smaller), existing `crates/caelum-core/tests/common/mod.rs`, plus a small `engine.rs` unit test if private ECS inspection is needed.

Add player-level tests using `GameEngine::dispatch` and current snapshot/budget, not internal undo internals:

1. Build a multi-point road stroke near an existing road. Assert undo restores original tile connections, any automatic-junction structures and exact paid budget; assert the second undo returns an unapplied rejection. A partial stroke must refund only successfully constructed/charged points.
2. Test representative track, standalone Bus Stop, Metro Station, roundabout, placed building (one multi-tile and one transit-node-creating placement), and zoning rectangle. Check exactly restored authored footprint, with unrelated map/buildings kept. For tombstone restoration, verify pre-build tombstone state is restored rather than deleting an old logical node.
3. Set Creative mode through a sandbox snapshot/request; assert successful undo leaves budget unchanged rather than adding nominal cost. For Standard, permit time/income between construction and undo and assert refund is added to the *current* budget.
4. Advance game time just inside, exactly at, and beyond `GAME_DAY_SECONDS / 24.0` (respect pause/speed). Expiry is an unapplied rejection and cannot be used to extract a refund.
5. Create a route after constructing a needed road, or a line referencing a newly activated stop/station; assert undo rejects with original budget and map retained. Also test a conflicting footprint occupied by later automatic growth/changed entity.
6. A second successful build replaces the first undo; a successful demolish clears it; a rejected/no-op build preserves the old record. Test the save-capture, restore and reset boundaries.
7. For an occupied residential building undo, assert the existing ECS building reconciliation keeps population/trips valid; do not copy/rewind an old citizen snapshot.

Tests must exercise the real existing `GameIntent` dispatch path and its `GameplayUpdateResult.applied` behavior. Avoid a combinatorial test matrix for every road preset or rejection branch.

## 2. Implement a single transient core record

**Files:** `crates/caelum-core/src/engine.rs`, a small `crates/caelum-core/src/build_undo.rs` if warranted, `crates/caelum-core/src/lib.rs`, `crates/caelum-core/src/intent.rs`, `crates/caelum-core/src/rejection.rs`.

1. Define private `BuildUndo` and `Option<BuildUndo>` on `GameEngine`; initialize to `None` in `from_parts`. The record is not in `GameSnapshot` and is not serialized. Store creation time, amount **actually deducted**, all differing before/after map tiles (including neighbor changes), before/after `road_structures` only when modified, and before/after *authored* additions/reactivations to buildings and transit nodes. Compute the touched footprint from tile and entity deltas. Do not retain full snapshots after capture.
2. Add the `UndoLastBuild` intent and `NothingToUndo`, `UndoExpired`, `UndoConflict` rejections (names consistent in Rust + TS). If useful, populate `context.point` with the first changed/conflicting tile.
3. Wrap the current `dispatch` body with a tiny classifier: candidate capture for the ten construction intent variants; record only after an applied commit; successful removal clears without becoming undoable; other intents leave it alone. Preserve the existing `commit_result` versus `commit_network_mutation` behavior for ordinary builds. Do **not** duplicate build rules in the undo module.
4. Build the inverse against the **current** `GameSnapshot`, not an old snapshot. Before creating it, compare tracked post-build tiles/structure/entities to current values, check footprint occupancy and route/node/service-path dependencies, and check `budget.checked_add(refund)`. Reject atomically on failure. Restore only the changed authored layers and add refund. Use the existing network commit path to compile topology, normalize stop access, recompute routes and reconcile buildings with ECS; clear the record only on success.
5. A no-op or rejection must not mark gameplay dirty or mutate `self.world`. The core `GameplayUpdateResult` and presentation/scene update continue to supply the existing UI refresh and invalidation logic.

**Review gate:** verify generated roundabouts/junctions and dual-road-adjacent tile changes are covered by the *authoritative before/after diff*, not only requested stroke points. Verify the station and bus-terminal `PlaceBuilding` paths undo the associated node, including tombstone reuse. Keep this one code path for both hosts.

## 3. Save/restore semantics and shared wire contract

**Files:** `crates/caelum-core/src/engine.rs`, `crates/caelum-wasm/src/lib.rs`, `src-tauri/src/lib.rs`, `src/runtime/backend/types.ts`, `src/domain/types.ts`, `src/runtime/rejectionMessages.ts`.

1. Change `GameEngine::snapshot_for_save` to take `&mut self` and clear `last_build` on capture. Update `WasmGameEngine::snapshot_for_save` to take `&mut self` and Tauri `game_snapshot_for_save` to lock its `OwnedEngine` **mutably**. No new command/transport method. Keep `snapshot_for_save` wire payload identical; a storage failure after capture may still consume undo.
2. Existing engine `reset` and `restore_snapshot` already replace `self` through `from_parts`; verify they always return with no last build. Adjust Rust call sites/tests requiring a mutable receiver.
3. Extend the TypeScript `GameIntent` union with `undoLastBuild` and the rejection-code union with the three new cases. Add clear, concise messages in the existing `rejectionMessage`: nothing to undo, expired, and changed footprint/dependent route. Use existing `GameplayRejection` context rather than a new feedback channel.
4. Verify WASM/JS and Tauri/serde use the same tagged camelCase intent; no extra backend interface, save field or schema version. Existing generic `dispatch` adapters require no branching.

**Review gate:** fail closed on any runtime epoch mismatch before touching last-build state. Preserve candidate-first restore. Save/load with a preexisting last-build record cannot resurrect it.

## 4. Add only the world-undo keyboard action

**Files:** `src/runtime/types.ts`, `src/runtime/createGameRuntime.ts`, `src/App.svelte`.

1. Add `undoLastBuild(): RuntimeCommandResult` to the existing `RuntimeController`. Implement with `enqueueDispatch({ type: "undoLastBuild" })`, sharing serialization, busy gating, rejection persistence, dirty tracking and road preview regeneration. Do not add an undo-specific queue, mutation manager, UI state or separate host RPC.
2. Extend `handleWindowKeydown` **after** the existing route-draft Ctrl/Cmd+Z/Shift+Z and Ctrl/Cmd+Y branches but **before** the general modifier early-return. When the target is not editable, a city is active, New City is not shown, no draft is open, and plain Ctrl/Cmd+Z was pressed (not Alt/Shift), call `event.preventDefault()` and `void applyRuntimeResult(() => runtime.undoLastBuild())`.
3. If a route draft exists, keep its current undo/redo behavior. In editable fields/contenteditable, let native text undo run. Do not intercept Ctrl/Cmd+Shift+Z or Ctrl+Y outside route drafts (world redo is not supported).
4. Reuse `ActionFeedback.svelte` via existing rejection messages. No new toolbar, undo button, keyboard registry or additional shortcut-display system.

**Review gate:** rejected undo returns the existing game scene/budget, surfaces one message and does not accidentally bypass the active-city or save busy guards.

## 5. Focused tests, verification and finish on the same PR

**Files:** `tests/runtime/gameRuntime.test.ts`, `tests/runtime/rejectionMessages.test.ts`, `tests/ui/appShell.test.ts` (and existing `tests/ui/routeDraft.test.ts` only if necessary); optional concise `tests/e2e/routes.spec.ts` or a small construction flow if a browser test adds unique value.

- Runtime fake backend: Ctrl/Cmd+Z world path dispatches exactly one `undoLastBuild`, respects queue/busy, keeps route editor undo priority, and publishes the returned Rust rejection. Do not duplicate the whole Rust inverse matrix in TS tests.
- App keyboard: input/contenteditable native undo unchanged; route-draft redo unchanged; no active city/New City overlay never issues a world undo.
- Rejection message cases for the three codes. One browser smoke test may place and undo a road with budget feedback if deterministic; Rust covers structural correctness.
- Confirm temporary undo does not leak into durable save JSON and both native/browser adapters remain thin.

Run before marking **this PR** ready:

```sh
cargo fmt --all --check
cargo test -p caelum-core
cargo test --workspace
bun run check
bun run test:unit
bun run lint
bun run format:check
```

Where useful, run one focused Playwright construction smoke (`bun run test:e2e -- <test-file>`) after the WASM build is current. Do not create a new visual/audio asset task: no new art or SFX is required.

## Scope and completion checklist

- [ ] Exactly one undoable successful construction gesture; previous gesture is not still undoable
- [ ] Actual cash refund, including partial affordability, free edits and Creative mode
- [ ] One **game** hour, derived from the compressed clock
- [ ] Structural and route dependency conflicts reject atomically
- [ ] Unrelated ticks, income, active vehicles, trips and autonomous growth preserved
- [ ] Successful demolition, reset, save capture and restore invalidate the record
- [ ] Existing route-draft undo and editable-field native undo unaffected
- [ ] Browser/WASM + native Tauri use the same core intent; no save schema or backend expansion
- [ ] Targeted Rust/TS tests pass and this **same** PR is reviewed before implementation is declared done

**Explicitly not doing:** generalized reversible commands, deep history, undo demolition, redo, migration/backward compatibility, extra state owners, autosave redesign, new image art/SFX, or a second implementation PR.

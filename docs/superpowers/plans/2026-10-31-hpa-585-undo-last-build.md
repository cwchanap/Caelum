# HPA-585 — Undo Last Build — Implementation Plan

> **Design:** [2026-10-31-hpa-585-undo-last-build-design.md](../specs/2026-10-31-hpa-585-undo-last-build-design.md)  
> **Linear:** [HPA-585](https://linear.app/cwchanap/issue/HPA-585/undo-the-last-build-with-a-full-refund)  
> **PR policy:** This **single draft PR** is the planning and future implementation PR. Continue with code and tests on this branch; **do not open a separate implementation PR**.

## Goal and approach

Deliver one-level Ctrl/Cmd+Z for the most recent successful build, within one in-game hour, refunding **actual spent budget** while preserving running simulation state. Reuse `caelum-core`, the existing network preparation/commit path, generic WASM/Tauri `dispatch`, the gameplay queue, the rejection banner, and existing route-draft keyboard precedence. No command/history framework or persisted undo field.

**Clock:** `clock::GAME_DAY_SECONDS == 1200.0`; one in-game hour is `GAME_DAY_SECONDS / 24.0 == 50` engine-time units, not 3,600.

**Review resolution:** [PR design review](https://github.com/cwchanap/Caelum/pull/76#issuecomment-6554853715) F1–F5 are incorporated: route outcome check instead of scanning dependent paths; whole-map inverse for map builds; reuse of `transit::remove_at_tile` for placements; candidate preparation split; and an exhaustive intent classifier. The zone conflict check specifically compares changed `area` fields to avoid a false rejection when an existing metro station occupies a road whose direction was changed.

## 1. Core tests first: eight representative Rust scenarios

**Files:** `crates/caelum-core/tests/build_undo.rs` (or existing engine tests if shorter). Use actual `GameEngine::dispatch`, `GameplayUpdateResult.applied`, and snapshots; avoid a test fixture matrix for every construction intent.

1. A road stroke changes nearby connections/automatic junctions; undo restores the whole pre-build `GameMap` and actual budget debit. A second undo returns `NothingToUndo`.
2. A partially affordable stroke refunds only its actual charged amount, not attempted or skipped tiles.
3. Undo `PlaceBuilding` for a transit-node building, using existing demolition to remove both building and node and return the actual cost.
4. At **exactly 50** elapsed simulation-time units undo succeeds; just beyond 50 returns `UndoExpired` without refund. Use the compressed clock, not a wall timer.
5. A newly authored route/line relies on the new road and would become `path_broken`: undo yields `UndoConflict`, preserving current snapshot, budget and ECS.
6. Seed time just before a six-game-hour growth boundary, paint zoned land and allow growth onto a changed zone tile within the one-hour undo window. Undo rejects without disturbing the grown building.
7. Existing connected bus line takes an automatically recomputed shortcut through a newly built road; undo succeeds and the line remains connected using its earlier route. This is the high-value regression guard against the old path-scanner rule.
8. Save capture consumes the record; subsequent undo is `NothingToUndo` and no undo fields appear in saved JSON.

Reuse `crates/caelum-core/tests/population.rs` for building/ECS demolition behavior and existing route/roundabout tests. Do **not** add redundant per-kind track/stop/roundabout cases, separate Creative-mode cases, tombstone-state equality, restore/reset matrix, or branch-only tests unless a real bug is reproduced.

## 2. Implement the small Rust inverse and candidate-validation seam

**Files:** `crates/caelum-core/src/engine.rs`, `crates/caelum-core/src/intent.rs`, `crates/caelum-core/src/rejection.rs`; `crates/caelum-core/src/build_undo.rs` and `lib.rs` only if a separate tiny module improves readability.

1. Add private `last_build: Option<BuildUndo>` to `GameEngine`, default `None` in `from_parts`. Store `built_at: f64`, `refund: i32`, and one of two inverses: `RestoreMap(GameMap)` or `Demolish(Point)`. No full GameSnapshot backup, per-tile before/after records, entity diff, route scanner or serialized field.
2. Add `GameIntent::UndoLastBuild` and Rust rejection codes `NothingToUndo`, `UndoExpired`, `UndoConflict` using the existing tagged/camelCase wire behavior.
3. **Exhaustively** classify `&GameIntent` with `match` (no wildcard) into map construction, placement construction, demolition, undo and other. A new gameplay intent must force an explicit classification choice at compile time. For an applied map build, retain a clone of the pre-build `self.snapshot.map`; for an applied placement build, retain its point/origin; either stores the **actual** `budget_before - budget_after` refund and the final `self.snapshot.time`. Rejected/no-op builds preserve the previous record. Successful `RemoveAtTile(s)` clear it; other actions leave it alone.
4. Extract `prepare_network_candidate(&self, snapshot: GameSnapshot) -> GameplayResult<(GameSnapshot, RoadTopology)>` from `commit_network_mutation`: keep the existing stop-access normalization, conditional topology compilation and route recomputation unchanged. Ordinary builds call prepare then `commit_snapshot_and_topology`; undo uses the same preparation before its extra validation. Keep any ECS `reconcile_buildings` call **after** the no-op guard and behind the successful commit.
5. Undo checks record and elapsed time; expiration drops the record and returns `UndoExpired`. Otherwise clone the **current** snapshot:
   - For `RestoreMap(before_map)`, reject `UndoConflict` if **a building now occupies a tile whose zone (`area`) would be changed back**, then set only `candidate.map = before_map`. This prevents overwriting autonomous growth but does not falsely reject direction edits under an already placed metro station.
   - For `Demolish(point)`, call `transit::remove_at_tile` on the current candidate. It already removes a building plus its node (or a standalone stop/station) and uses Missing tombstones where appropriate. A failed demolition is `UndoConflict`. Do not clone or restore old node metadata.
   - Add refund with `candidate.budget.checked_add(refund)`, rejecting overflow as `UndoConflict`; do not reset budget to its old value.
6. Run `prepare_network_candidate` **before** any ECS/live-shell mutation. Reject `UndoConflict` only when a bus route/metro line that was `path_broken == false` in the live shell becomes `path_broken == true` after preparation. A route that simply switches back to a different connected path is allowed. Use existing route IDs / flags: no new path or platform dependency scanner.
7. Only after all checks pass call `commit_snapshot_and_topology` exactly once and clear `last_build`. Rejected conflicts retain the record until expiration. Undo never creates another record.

**Review gate:** both network and placement inverses operate on **current state**, so they cannot rewind time, vehicles, citizen activity, unrelated buildings or income. A rejected undo must not change topology, world, budget or scene. Tests cover the one meaningful growth overlap and the connected→broken route transition; no speculative stale-map equality tests.

## 3. Save/restore semantics and shared wire contract

**Files:** `crates/caelum-core/src/engine.rs`, `crates/caelum-wasm/src/lib.rs`, `src-tauri/src/lib.rs`, `src/runtime/backend/types.ts`, `src/domain/types.ts`, `src/runtime/rejectionMessages.ts`.

1. Change `GameEngine::snapshot_for_save` to take `&mut self` and clear `last_build` on capture. Update `WasmGameEngine::snapshot_for_save` to take `&mut self` and Tauri `game_snapshot_for_save` to lock its `OwnedEngine` **mutably**. No new command/transport method. Keep `snapshot_for_save` wire payload identical; a storage failure after capture may still consume undo.
2. Existing engine `reset` and `restore_snapshot` already replace `self` through `from_parts`; verify they always return with no last build. Adjust Rust call sites/tests requiring a mutable receiver.
3. Extend the TypeScript `GameIntent` union with `undoLastBuild` and the rejection-code union with the three new cases. Add clear, concise messages in the existing `rejectionMessage`: nothing to undo, expired, and changed footprint/dependent route. Use existing `GameplayRejection` context rather than a new feedback channel.
4. Verify WASM/JS and Tauri/serde use the same tagged camelCase intent; no extra backend interface, save field or schema version. Existing generic `dispatch` adapters require no branching.

**Review gate:** reuse the **existing** Tauri runtime-epoch check before taking/clearing the record; do not add a new epoch mechanism. `from_parts` automatically clears undo on restore/reset; no extra test matrix. Save/load cannot resurrect the record.

## 4. Add only the world-undo keyboard action

**Files:** `src/runtime/types.ts`, `src/runtime/createGameRuntime.ts`, `src/App.svelte`.

1. Add `undoLastBuild(): RuntimeCommandResult` to the existing `RuntimeController`. Implement with `enqueueDispatch({ type: "undoLastBuild" })`, sharing serialization, busy gating, rejection persistence, dirty tracking and road preview regeneration. Do not add an undo-specific queue, mutation manager, UI state or separate host RPC.
2. Extend `handleWindowKeydown` **after** the existing route-draft Ctrl/Cmd+Z/Shift+Z and Ctrl/Cmd+Y branches but **before** the general modifier early-return. When the target is not editable, a city is active, New City is not shown, no draft is open, and plain Ctrl/Cmd+Z was pressed (not Alt/Shift), call `event.preventDefault()` and `void applyRuntimeResult(() => runtime.undoLastBuild())`.
3. If a route draft exists, keep its current undo/redo behavior. In editable fields/contenteditable, let native text undo run. Do not intercept Ctrl/Cmd+Shift+Z or Ctrl+Y outside route drafts (world redo is not supported).
4. Reuse `ActionFeedback.svelte` via existing rejection messages. No new toolbar, undo button, keyboard registry or additional shortcut-display system.

**Review gate:** rejected undo returns the existing game scene/budget, surfaces one message and does not accidentally bypass the active-city or save busy guards.

## 5. Focused UI checks and verification on this PR

**Files:** `tests/runtime/gameRuntime.test.ts`, `tests/runtime/rejectionMessages.test.ts`, `tests/ui/appShell.test.ts` (plus existing route-draft tests only if needed).

- A narrow runtime test confirms that world Ctrl/Cmd+Z dispatches exactly one `undoLastBuild` through the existing queue/busy guard, and rejected results surface through existing feedback.
- Keyboard assertions preserve route-draft undo/redo, editable input/contenteditable native undo, New City/absent-city gates. No worldwide redo action.
- Cover three rejection-message cases, reusing current UI components. An optional one-path browser smoke is enough; Rust tests prove the inverse.
- Save capture does not persist the undo record; both thin adapters dispatch the same Rust intent without special-case host logic.

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

Only run a focused `bun run test:e2e -- <test-file>` if it adds coverage beyond Rust/runtime. No new image art or SFX task: none is needed.

## Scope and completion checklist

- [ ] One temporary `RestoreMap` or `Demolish` record, replaced by the next applied build and cleared by successful demolition
- [ ] Actual refund (including partial strokes and zero-cost actions) applied to the current budget
- [ ] One **game** hour (50 engine-time units) with inclusive boundary
- [ ] Growth on reverted zone and healthy→broken route conflict rejected **before commit**
- [ ] Existing connected route auto-reroute can be reversed successfully
- [ ] Time, vehicles, trips, population, other buildings and unrelated money preserved
- [ ] Save capture, reset, restore and New City clear the record through existing engine lifecycle
- [ ] Route-draft undo and native text undo unaffected; no redo button/history
- [ ] WASM/Tauri share one core intent; no schema/version/backend expansion
- [ ] Eight focused Rust cases and minimal TS smoke/feedback checks pass on **this same PR**

**Explicitly not doing:** generalized reversible commands, deep history, undo demolition, redo, migration/backward compatibility, extra state owners, autosave redesign, new image art/SFX, or a second implementation PR.

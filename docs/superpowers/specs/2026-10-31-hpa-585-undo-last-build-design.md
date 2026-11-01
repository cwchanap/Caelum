# HPA-585 — Undo the Last Build with a Full Refund — Design

> **Linear:** [HPA-585](https://linear.app/cwchanap/issue/HPA-585/undo-the-last-build-with-a-full-refund)  
> **Implementation plan:** [2026-10-31-hpa-585-undo-last-build.md](../plans/2026-10-31-hpa-585-undo-last-build.md)  
> **PR policy:** Keep design, implementation, tests and review in **one draft PR**. This first commit is documentation, not a claim that undo is implemented.

## Player contract

With an active city and no route draft, **Ctrl/Cmd+Z** undoes the **most recent successful construction gesture**, once, within **one game hour** of that gesture. This includes one-tile and dragged roads, road-direction edits, roundabouts, track, bus stops, metro stations, placed buildings (including transit buildings), and area rectangle paint. One multi-tile stroke is one undo. Partially successful strokes undo only actual changes and refund only money actually spent.

Undo restores the authored footprint and the relevant structural entities, **not the entire game snapshot**. It refunds the construction deduction into the *current* budget, preserving income, vehicle movement, population and time that happened afterward. Successful undo consumes the record; a subsequent Ctrl/Cmd+Z reports “Nothing to undo.” A successful second build replaces the first record. Successful demolition also clears it, but is never itself undoable. Rejected/no-op build attempts leave the prior record intact.

The time limit uses **the clock already implemented in Caelum**: `clock::GAME_DAY_SECONDS == 1_200.0`, so one in-game hour is `GAME_DAY_SECONDS / 24.0 == 50` units of `GameSnapshot.time`. Check the elapsed simulation time, not wall-clock seconds or `3600`. Pause holds the window open; speed affects how quickly game time advances. Accept the exact boundary; reject elapsed time greater than one hour. An expired record is discarded after reporting the expiration.

A conflict is rejected **without modifying map, budget, ECS world or topology**, with the existing action-feedback UI explaining that the affected construction or a dependent route changed. Examples: a later route uses a newly created road/track or node; auto-growth occupied an area-painted tile; a touched structure or entity no longer matches its recorded post-build state. A conflicted record may be retried if the dependency is resolved before expiry. This is intentionally conservative: it is better to refuse a questionable undo than to silently break a running route.

## Existing implementation boundaries (verified against main)

- The authoritative `GameEngine` in `crates/caelum-core/src/engine.rs` owns `snapshot`, cached `road_topology` and an ECS population `World`. Its `dispatch` already routes construction to `commit_network_mutation` or `commit_result`, and successful `GameplayUpdateResult.applied` is available.
- Road mutations in `road.rs` update neighboring connections and generated automatic junctions; roundabouts also own generated road structures. Undo cannot merely clear the originally clicked tile.
- `PlaceBuilding` can create or reactivate a bus/metro node, while standalone `AddBusStop` and `AddMetroStation` can restore tombstones. `commit_network_mutation` handles stop-access normalization, topology compilation, route recomputation and building/ECS reconciliation.
- `snapshot_for_save` is currently an immutable Rust method, called by the WASM wrapper and the Tauri `game_snapshot_for_save` command. Save flows through `workingSaveRuntime.ts` after gameplay queue drain. Restore/reset replace the engine candidate.
- `src/App.svelte::handleWindowKeydown` already routes Cmd/Ctrl+Z to **route-draft undo** before the generic modifier early-return. `createGameRuntime.ts` has a serial `enqueueDispatch` path and `rejectionMessages.ts` provides feedback for rejected gameplay intents.

## Narrow Rust design

Add one private non-serialized field `last_build: Option<BuildUndo>` to `GameEngine`, with a small internal `build_undo.rs` module for capture/check/inverse work (or keep it local to `engine.rs` if the final code is shorter). Do **not** add durable data to `GameSnapshot`, a history stack, command trait, reversible-intent framework or per-host undo implementation.

`BuildUndo` stores:

1. `built_at: f64` and `refund: i32` (the **actual** positive `budget_before - budget_after`; zero in Creative, for free direction edits and area paint).
2. The **changed** `Tile` values, as before/after pairs, at every authoritative changed coordinate. Compare the full before/after `map.tiles` and retain only differences: road strokes change adjacent connections and sometimes tiles outside their requested points; building placement does not change the tile layer at all.
3. The before/after `map.road_structures` vectors **only when they differ**. This small structural backup covers automatic junction and roundabout creation/removal/port updates without inventing an inverse geometry algorithm.
4. Before/after changes to **authored building and transit-node entities by ID**: newly added buildings, newly added stops/stations, and tombstones reactivated by placement. Capture the actual entity changes, including full building footprints and restored node state. Do not save unrelated route, vehicle, trip, budget or clock snapshots. Road-derived stop-access for unchanged nodes is recomputed by the normal network commit path.

Derive `affected_points` from changed map tiles, building footprints and changed stop/station anchors; deduplicate them. The temporary pre/post snapshots needed to calculate the diff can be dropped immediately after an applied dispatch. This stays small even when the city grows; it does not retain full snapshots for an hour.

### Capture and invalidation

Keep the current dispatch match and mutations as the authority. A thin `dispatch` wrapper may classify the incoming intent as:
- **Eligible build:** `LayRoad`, `LayRoadLine`, `CycleRoadDirection`, `PlaceRoundabout`, `LayTrack`, `LayTrackLine`, `AddBusStop`, `AddMetroStation`, `PlaceBuilding`, `PaintAreaRectangle`.
- **Demolition:** `RemoveAtTile`, `RemoveAtTiles`: clear previous undo on a successful removal, do not capture a demolition.
- **Undo:** `UndoLastBuild`, handled separately without recapturing the inverse as a new build.
- **Other intents:** keep the record until save/reset/restore, replacement build, successful demolish, expiration or successful undo. This permits a player to open/tune service but requires a dependency check before undo.

For eligible builds: take a temporary *shell* snapshot before the existing dispatch path; only when the resulting `applied` is true, build the delta from that snapshot to the committed `self.snapshot` and replace the previous record. The live shell excludes ECS citizen rows already. Compute the refund from actual budget deductions, **never** from a catalog's nominal quote. A rejected or no-op dispatch must not accidentally consume a prior undo.

### Validate then apply

`UndoLastBuild` first checks record presence and elapsed game time. It then checks that:
- Each recorded post-build tile still matches the current tile; every tracked entity still matches the relevant post-build authored state and has not been replaced/occupied on its footprint. In particular, zoning undo must not erase autonomously grown buildings. Unchanged entities and map cells elsewhere must be preserved.
- Recorded road structures still match their post-build version, if any.
- No current Bus/Metro line, live route leg/service path, or platform assignment depends on the modified road/track footprint or the added/reactivated stop/station. Check the current route paths/waypoint IDs; never “repair” dependency by silently breaking the player's line. This may conservatively reject an undo that could have rerouted.
- A refund can be added safely to the current `i32` budget.

Only after all checks pass, construct an inverse candidate **from the current shell**, restore recorded tiles and road structures, undo only the recorded building/node additions/reactivations, and add `refund` to the current budget. Pass the candidate through existing topology/stop-access/route recompute and building/ECS reconciliation so the authoritative invariants stay in place. If candidate compilation fails, reject without altering the live engine. Do not directly assign an old `GameSnapshot` to `self.snapshot`: that would rewind time, income, trips, vehicles, IDs, and current population.

The record is cleared **only after a successful** undo; a dependency rejection retains it until its time limit. Do not generate a second record from undo.

### Save/reset/restore

Make `GameEngine::snapshot_for_save(&mut self)` consume/clear `last_build` on **save capture**, and minimally change the WASM wrapper to `&mut self` and the Tauri command to take a mutable `OwnedEngine` mutex guard. This may also clear undo when the later storage write fails; accept that conservative behavior rather than adding another backend call or post-save handshake. The exported snapshot stays structurally identical. `from_parts`, `from_snapshot`, `restore_snapshot`, `reset`, and new city creation initialize `last_build: None`. No schema bump, persistence migration, host-specific state or extra `GameBackend` method.

## Wire and UI

- Add `GameIntent::UndoLastBuild` in Rust with existing tagged camelCase serialization, and `{ type: "undoLastBuild" }` in the TypeScript `GameIntent` union. WASM and Tauri already dispatch arbitrary intents through the same core.
- Add only **three** actionable rejection codes (names may be finalized with the implementation): `NothingToUndo`, `UndoExpired`, `UndoConflict`. Add matching TS `RejectionCode` variants and `rejectionMessage` text; use `context.point` for an affected tile when available.
- Add one `RuntimeController.undoLastBuild()` method implemented as `enqueueDispatch({ type: "undoLastBuild" })`; reuse existing dirty marking, preview invalidation and feedback flow. No `canUndo` or undo-history field on presentation/UI.
- In `App.svelte`, keep route-draft Cmd/Ctrl+Z (and route-draft redo) first. With **no** route draft, a live city, no New City overlay and a non-editable key target, handle plain Ctrl/Cmd+Z (not Shift+Z/Alt+Z) via the existing `applyRuntimeResult` helper. Respect the save busy gate. Do not swallow text-input or native browser undo.

## Acceptance / tests

1. Rust: one successful road stroke undo restores neighboring connections, generated structure state, changed tiles and **actual** budget debit; a second undo rejects. Cover representative track, stop/station, building (including transit-node creation), roundabout and zone-paint cases without repetitive per-tile test matrices.
2. Rust: a partially affordable stroke refunds only charged tiles; Creative mode does not mint money; refund augments the **current** budget instead of resetting other income/expenses.
3. Rust: expiry is tested at `GAME_DAY_SECONDS / 24.0`, including the boundary; paused time does not advance it. A conflicting route/path/occupied footprint rejects without changing gameplay state.
4. Rust: second build replaces record; successful demolish clears it; rejected build preserves it; save capture and restore/reset clear it, with unchanged snapshot schema and payload. Verify ECS reconciliation on undo of occupied residential construction.
5. Runtime/UI: route-draft undo keeps priority, input/contenteditable retains native undo, and world Cmd/Ctrl+Z dispatches exactly once through the queue. Feedback for no record, expired and conflicting is readable. The browser and native paths use the identical intent and Rust logic.

**Out of scope:** undo demolition, redo, multi-step history, redo stack, autosave or snapshot format changes, UI toolbar/button redesign, new art/SFX, generalized transaction log, extra performance abstraction, or an implementation PR separate from this design PR.

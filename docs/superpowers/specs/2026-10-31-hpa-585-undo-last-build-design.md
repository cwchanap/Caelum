# HPA-585 — Undo the Last Build with a Full Refund — Design

> **Linear:** [HPA-585](https://linear.app/cwchanap/issue/HPA-585/undo-the-last-build-with-a-full-refund)  
> **Implementation plan:** [2026-10-31-hpa-585-undo-last-build.md](../plans/2026-10-31-hpa-585-undo-last-build.md)  
> **PR policy:** Keep design, implementation, tests and review in **one draft PR**. This first commit is documentation, not a claim that undo is implemented.

## Player contract

With an active city and no route draft, **Ctrl/Cmd+Z** undoes exactly the **last successful construction gesture** within **one in-game hour**. One road/track drag or rectangle paint is one gesture. Eligible construction: `LayRoad`, `LayRoadLine`, `CycleRoadDirection`, `PlaceRoundabout`, `LayTrack`, `LayTrackLine`, `PaintAreaRectangle`, `AddBusStop`, `AddMetroStation`, `PlaceBuilding` (including transit buildings).

The inverse operates on the **current** simulation state: the build is removed, the amount actually paid is added back to the *current* budget, and live time, trips, population, income and unrelated growth are preserved. Partial strokes refund only tiles actually charged; Creative/free placement refunds zero. A second undo returns `NothingToUndo`; a successful later build replaces the record, and a successful demolish discards it without becoming undoable. Rejected/no-op builds do not erase the earlier record.

The limit is `clock::GAME_DAY_SECONDS / 24.0`: the current game day is 1,200 time units, so **one game hour is 50 units of `GameSnapshot.time`, not 3,600**. Accept the exact boundary and reject afterward. Pausing freezes the window; speeding the simulation consumes it faster. An expired record is discarded on attempt.

Undo is rejected **without touching the live engine or its budget** if restoring the map would overlap a building added since the build, or if the resulting world would turn an existing working bus route or metro line into a broken one. Undo **must not reject merely because a running line uses newly built road**: normal construction can automatically reroute an already-working line onto the new road. If removing that road simply reroutes the line back to another valid path, undo succeeds. Existing route-draft undo retains keyboard precedence.

No demolition undo, redo, multi-level history, saved-game schema changes or new art/SFX.

## Existing implementation boundaries (verified against main)

- The authoritative `GameEngine` in `crates/caelum-core/src/engine.rs` owns `snapshot`, cached `road_topology` and an ECS population `World`. Its `dispatch` already routes construction to `commit_network_mutation` or `commit_result`, and successful `GameplayUpdateResult.applied` is available.
- Road mutations in `road.rs` update neighboring connections and generated automatic junctions; roundabouts also own generated road structures. Undo cannot merely clear the originally clicked tile.
- `PlaceBuilding` can create or reactivate a bus/metro node, while standalone `AddBusStop` and `AddMetroStation` can restore tombstones. `commit_network_mutation` handles stop-access normalization, topology compilation, route recomputation and building/ECS reconciliation.
- `snapshot_for_save` is currently an immutable Rust method, called by the WASM wrapper and the Tauri `game_snapshot_for_save` command. Save flows through `workingSaveRuntime.ts` after gameplay queue drain. Restore/reset replace the engine candidate.
- `src/App.svelte::handleWindowKeydown` already routes Cmd/Ctrl+Z to **route-draft undo** before the generic modifier early-return. `createGameRuntime.ts` has a serial `enqueueDispatch` path and `rejectionMessages.ts` provides feedback for rejected gameplay intents.

## Narrow Rust design

Use one private, **non-serialized** `last_build: Option<BuildUndo>` on `GameEngine`, initialized to `None` in `from_parts`. A tiny `build_undo.rs` is optional only if it keeps `engine.rs` readable. No command abstraction, diff ledger, route-path scanner or separate history manager.

```rust
struct BuildUndo {
    built_at: f64,
    refund: i32,
    inverse: Inverse,
}
enum Inverse {
    RestoreMap(GameMap),
    Demolish(Point),
}
```

### Record the smallest inverse

Classify **every `GameIntent` explicitly with an exhaustive match**, no `_ =>` wildcard: map construction, placement construction, demolition, undo, or non-construction. This is a maintenance invariant: new map-changing intents must be considered for undo so a saved old map can never silently overwrite their effects. The classifier borrows the intent before dispatch; it must not duplicate the existing mutation rules.

- **Map construction** (`LayRoad`, `LayRoadLine`, `CycleRoadDirection`, `PlaceRoundabout`, `LayTrack`, `LayTrackLine`, `PaintAreaRectangle`): clone only the pre-build `GameMap`. This includes all road connections, generated automatic junctions and roundabout structures. Map construction adds no player building or transit node.
- **Placement construction** (`AddBusStop`, `AddMetroStation`, `PlaceBuilding`): remember the clicked point/origin as `Demolish(Point)`. Placement does not change map tiles. One point is sufficient because `transit::remove_at_tile` finds the occupying building (including its footprint) or a standalone node.
- Only when the existing dispatch result says `applied` store/replace the record, with `built_at = self.snapshot.time` and `refund = budget_before - budget_after` (the **actual deduction**, not the catalog quote). Rejected/no-op actions preserve the prior record.
- A **successful** `RemoveAtTile` or `RemoveAtTiles` clears it. Undo itself never records a new inverse. Other intents preserve the record.

Between successful builds/demolition and reset/restore, ordinary gameplay intents cannot change `GameMap`; ticks only add buildings, and `tick` asserts road topology is not modified. Therefore no after-tile/entity copies or generic `post_build_matches` checks are needed. This invariant depends on the exhaustive classifier, not on trusting arbitrary future actions.

### Prepare candidate, validate, then commit

Extract `prepare_network_candidate(&self, snapshot: GameSnapshot) -> GameplayResult<(GameSnapshot, RoadTopology)>` from `commit_network_mutation`'s existing stop-access normalization, topology compilation and `route_lifecycle::recompute_all_routes`. Ordinary network builds call prepare then `commit_snapshot_and_topology` just as before. A rejected preparation must never touch `self.world`; avoid reconciling ECS in the no-op branch.

For `UndoLastBuild`:

1. Require an existing record; reject `NothingToUndo` otherwise. On `time - built_at > GAME_DAY_SECONDS / 24.0`, clear and reject `UndoExpired`.
2. Clone the **current** shell snapshot. For `RestoreMap(before_map)`, compare current tiles to the stored map and reject `UndoConflict` if **any current building's occupied footprint intersects tiles whose map data would change**. This protects a building that grew on newly painted land. Replace only `candidate.map` with `before_map`; preserve current buildings and the rest of the shell.
3. For `Demolish(point)`, apply the existing `transit::remove_at_tile(&candidate, &point)`. That routine removes player buildings/standalone nodes, uses logical tombstones when still referenced, and already cooperates with ECS building reconciliation. Do not duplicate its entity/route logic. A reactivated tombstone will become Missing again if still referenced; **do not assert byte-for-byte pre-build node metadata**, because demolition does not promise to reset all derived fields.
4. Add `refund` with `checked_add`; overflow or unsuccessful demolition becomes `UndoConflict`. Do not reset budget to its old amount.
5. Call `prepare_network_candidate` on this inverse. Before committing, compare `path_broken` for each route/metro line in the **current** shell vs the prepared candidate; reject `UndoConflict` only if a formerly connected line becomes broken. This reuses route recomputation already required for ordinary network mutation; it allows a harmless auto-reroute back to a previous path. No path-step/waypoint/platform scanner.
6. On success, call `commit_snapshot_and_topology` **once** (including existing ECS reconciliation) and clear the undo record. Conflicts keep the record until expiry for retry. No rollback state machine.

### Save/reset/restore

Change `GameEngine::snapshot_for_save` to `&mut self` and clear the temporary record on save capture; minimally update the WASM wrapper `&mut self` and the existing Tauri `game_snapshot_for_save` mutable mutex guard. The Tauri runtime epoch is checked **before** modifying engine state; this check already exists. A later failed storage write may still consume undo, which is acceptable for this local game.

`from_parts` initializes the record to `None`, so reset, restore and New City automatically clear it. The serialized `GameSnapshot` and two thin host `GameBackend` implementations do not acquire new fields, version numbers or RPC methods.

## Wire and UI

- Add `GameIntent::UndoLastBuild` in Rust with existing tagged camelCase serialization, and `{ type: "undoLastBuild" }` in the TypeScript `GameIntent` union. WASM and Tauri already dispatch arbitrary intents through the same core.
- Add only **three** actionable rejection codes (names may be finalized with the implementation): `NothingToUndo`, `UndoExpired`, `UndoConflict`. Add matching TS `RejectionCode` variants and `rejectionMessage` text; use `context.point` for an affected tile when available.
- Add one `RuntimeController.undoLastBuild()` method implemented as `enqueueDispatch({ type: "undoLastBuild" })`; reuse existing dirty marking, preview invalidation and feedback flow. No `canUndo` or undo-history field on presentation/UI.
- In `App.svelte`, keep route-draft Cmd/Ctrl+Z (and route-draft redo) first. With **no** route draft, a live city, no New City overlay and a non-editable key target, handle plain Ctrl/Cmd+Z (not Shift+Z/Alt+Z) via the existing `applyRuntimeResult` helper. Respect the save busy gate. Do not swallow text-input or native browser undo.

## Acceptance / tests

Focus Rust testing on **eight player-level cases**, not per-kind matrices:

1. Road stroke undo restores the whole pre-build map and full actual refund; second undo is `NothingToUndo`.
2. Partial affordable stroke refunds only actual payment.
3. One `PlaceBuilding` transit-node placement undo reuses demolition and refunds.
4. Undo at exactly one game hour (50 time units) succeeds; just beyond fails `UndoExpired`.
5. A route made possible by the newly built network would become broken: `UndoConflict` without modifying state or budget.
6. Growth occupies an altered zone tile before undo: `UndoConflict` (start just before a six-hour growth boundary to keep the one-hour undo window).
7. A formerly connected route auto-reroutes onto the new road, and undo successfully returns it to a connected old path.
8. `snapshot_for_save` clears the record; no undo state appears in serialized snapshots.

Reuse the existing demolition/ECS and route-recompute coverage instead of multiplying track, stop, roundabout, Creative, tombstone and reset/restore tests. Include focused TS runtime/keyboard/rejection tests: draft undo has priority, text inputs keep native undo, world Cmd/Ctrl+Z issues one queued intent, and feedback shows the three rejection reasons. Browser and native hosts use the same Rust code and current generic dispatch.

**Out of scope:** undo demolition, redo, multi-step history, redo stack, autosave or snapshot format changes, UI toolbar/button redesign, new art/SFX, generalized transaction log, extra performance abstraction, or an implementation PR separate from this design PR.

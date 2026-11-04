# HPA-714 — Build-tool safety, costs and partial-placement feedback — Design

**Issue:** https://linear.app/cwchanap/issue/HPA-714/fix-build-tool-traps-and-missing-cost-hints-from-the-uat  
**Baseline:** `main` at `9d4e9edf00a10a77432731e9dc2d9b63798a99f6`, inspected 2026-11-03  
**Delivery:** design, implementation and review in **one PR**. Planning-only first commit; no gameplay changes yet.  
**Review:** [HPA-714 design review](https://github.com/cwchanap/Caelum/pull/78#issuecomment-6624795002) — valid findings incorporated before implementation.

## Player outcome

Accidental clicks while Road > 1-Lane / 2-Lane is selected cannot turn an existing road perpendicular and break an operating route. Players see real spend and **genuinely blocked or unaffordable placements** at the cursor for paid construction, and simple build controls say what they do.

Keep Rust authoritative for mutation validity and committed charges, with Svelte/TypeScript limited to existing read-only presentation catalogs and map overlays. No new editing framework, save migration, art, SFX, or generic cost service.

## Verified current seams and bugs

- `src/runtime/roadMutations.ts::roadClickIntent` always dispatches `cycleRoadDirection` when the tile is a road, regardless of `ui.roadPreset`. Both `handleTileClick` and zero-length `commitDrag` use this path; preview uses `roadMutationForUi`. The queued click recomputes the tile kind **at execution time**, which must be preserved.
- `crates/caelum-core/src/road.rs::cycle_road_direction` currently cycles `None → North → East → South → West → None` without inspecting `tile.road_connections`. `road::apply_road_mutation` already returns `changed_tiles` and zero cost for a direction change.
- `preview.rs::preview_road_mutation` and the existing WASM/Tauri `GameBackend.previewRoadMutation` return accepted road/roundabout/remove cost, skipped tiles, route impacts and rejection. `src/render/mapTextOverlay.ts` already shows a single cursor badge but ignores `skippedTiles` and has no track preview; `src/runtime/createGameRuntime.ts` already owns preview generation, cancel/invalidate and hover refresh.
- `transit.rs::lay_track_line_costed` is an ordered, partial build: invalid or unaffordable tiles are skipped, and only placed tiles are charged. The track cursor currently displays only `⦿ Track`. Single stop/station and building prices already exist in `BUILDING_CATALOG`. The frontend `COSTS` object in `src/domain/catalog/transit.ts` has no production consumers (only a legacy test assertion): delete it rather than reviving it. Never add another hard-coded price list.
- `rejectionMessages.ts` maps every `blockedTile` to generic "That tile is blocked."; `BuildPanel.svelte` renders `pad2(index + 1)` ordinals and a bare numeric rotate value.
- `engine.rs::dispatch_context` and `road.rs::record_line_results` classify *unchanged* requested tiles as `skippedTiles`. A harmless already-built road/track can appear as skipped; `preview.rs` currently converts all skips to generic `WarningCode::SkippedTiles`. Never use that list alone for warning tone.
- `commitDispatchResult` refreshes an armed preview after scene/budget changes but reads `activeRoadMutation`, which road/roundabout clicks invalidate before dispatch. Re-derive from current state/UI instead of adding a roundabout-only path.

## Decision 1 — Gate road clicks by preset, constrain Rust to connected axes

| Situation | Player-visible result |
| --- | --- |
| Empty tile with Road armed | Existing single-tile `layRoad` semantics (one two-way road) unchanged |
| Existing road + **1-Lane** or **2-Lane** | No dispatch; neutral "Already road" badge; no charge/direction notice |
| Ordinary straight or degree-1 end road + **1-Lane One-Way** | Cycle connected axis only: two-way → first heading → reverse heading → two-way |
| Ordinary corner, mixed-axis or isolated road + **1-Lane One-Way** | Typed `roadDirectionNeedsStraightRoad` rejection → "Only straight roads can be one-way." in preview and committed feedback |
| Structure-owned junction/roundabout | Preserve current no-op behavior, with no success claim |
| Off-axis one-way heading on a straight road (legacy bug) | First intentional One-Way click resets to two-way, then valid cycling resumes |
| Queued click | Capture the selected preset **at click/gesture commit**, re-read the latest map **at queued execution**; a later preset change must not alter that click |

Make `roadClickIntent` / `roadClickMutation` capable of returning `null` on preset-gated no-op, sharing rules for click, zero-length drag and hover. `enqueueComputedDispatch` already accepts null. Pass the **captured** preset into its closure; keep the map read inside the closure. Ordinary multi-tile `layRoadLine` behavior is unaffected.

In `cycle_road_direction`, a one-connection dead-end or two opposite `road_connections` establish the unique N/S or E/W axis; no connections or mixed axes do not. Cycle vertical North → South, horizontal East → West. If the current `one_way` is **off** that resolved axis, reset to `None` (repair the UAT city's broken road). For ordinary unsupported geometry, return a typed rejection; structure-owned road remains unchanged. Never manufacture perpendicular road connectivity.

Deliberately selecting One-Way can still alter route reachability along its legal axis: preserve Rust route-impact preview and existing committed direction-change warnings. The guarantee is **no accidental cross-axis change**, not that one-way never affects a route.
## Decision 2 — One truthful cursor cost path

Reuse the single `cursorBadge` / accessible readout and its `⦿ Label · $X` / Creative `Free` grammar.

- **Road/roundabout/remove:** keep generation-matched Rust preview charges. An existing-road preset-gated no-op shows "Already road", not an invalid-placement glyph.
- **Track:** add `layTrack` / `layTrackLine` to the **existing** `previewRoadMutation` union. `lay_track_line_costed` currently returns a snapshot-only `CostedMutation`; have its **shared inner Rust placement loop** sum actual `authorize()?.apply_to()` charges, and expose the result to both engine commit and preview. Derive changed/unchanged tiles through existing `dispatch_context`. Preserve single-track existing cost policy. No second TS simulator, new backend method or preview coordinator.
- **Bus Stop/Metro Station/buildings:** show `BUILDING_CATALOG[type].cost`, with existing `canPlaceBusStop`/`canPlaceBuilding` hover validators. Delete dead `COSTS` from `src/domain/catalog/transit.ts` and its sole selector test rather than reusing it.
- **Price drift:** Rust's `BUS_STOP_COST`/`METRO_STATION_COST` and Rust `building_catalog.rs` entries must agree. Add one focused Rust equality test, plus TS `buildingCatalog.test.ts` pins for the two player-facing prices; no codegen or additional cost layer.
- A local invalid placement may show listed price plus `⊘` as an informational quote. A **Rust** rejection supersedes any nominal charge. Pending preview is neutral; keep matching `a11yText`.

Keep existing WASM/Tauri `GameBackend.previewRoadMutation`, generation/debounce and stale-response handling; there must remain exactly nine backend operations.
## Decision 3 — Warn only for genuine blocked or unaffordable placements

`skippedTiles` is still useful for preview geometry but **not** a warning predicate. The current `dispatch_context` and `record_line_results` mark unchanged existing road and track as skipped. Do not train players to ignore warning badges for harmless no-ops.

Reuse `RoadMutationPreviewResponse.warnings` and `GameplayWarning.context.footprint`; **replace** generic `WarningCode::SkippedTiles` with `TilesBlocked` and `TilesUnaffordable` (wire `tilesBlocked`/`tilesUnaffordable`). Each footprint carries exact points and its length gives the displayed count. Pass `warnings` through `buildRoadMutationPreview` to the cursor and replace the now-misleading generic `warningMessage` copy. **No new serialized response field** or extra counts property.

Record causes only at their actual Rust skip branches:
- Road `author_lane_tiles`: out-of-bounds, roundabout-owned, disallowed reverse overlay and invalid placement → blocked; unaffordable quote → insufficient money. Accepted unchanged existing roads/crossings do not count. An atomic road-contact rejection remains a rejection, not partial-build warning.
- Track `lay_track_line_costed`: invalid placements → blocked **except when track is already present**, a harmless no-op; an unaffordable quote → insufficient money. Capture these points in the same inner placement loop commit uses.
- Render warning tone **only** if either cause footprint is nonempty: `⦿ Road · $100 · Not enough money, 11 tiles skipped` or `⦿ Track · $1,000 · 2 tiles blocked`. Show both concise counts if both apply. **Remove the generic unclassified "N tiles skipped" fallback.** Keep Rust's actual paid cost (Creative `Free`), not estimated all-tiles price.

A full Rust rejection overrides cost/warning, and stale responses remain pending. Do not infer causes from a parallel TS validity or budget simulator.
## Decision 4 — Focused copy and shared post-dispatch preview refresh

- When Bus Stop placement targets an existing road tile, return `stopMustBeBesideRoad` → **"Place stops beside a road, not on it."** Keep generic `blockedTile` wording for other collisions; no last-intent framework.
- Remove BuildPanel's fake `tool-num` 01/02 ordinals and **only that component's** unused `pad2` import/style/tests; `pad2` is still used by `runtimeSelectors.ts`. Preserve actual shortcut chips. Render rotation as `0°`/`90°`; keep accessible "degrees" wording.
- **Do not add a roundabout-specific refresh.** `commitDispatchResult` already re-issues previews after applied scene/budget changes; derive `roadMutationForUi(nextState, nextUi)` rather than using the pre-click `activeRoadMutation` that was invalidated. Reuse generation bump and `sendRoadMutationPreviewRequest`, preserving click-time invalidation to drop in-flight old results. This also refreshes Road and Track on stationary pointer. Do not request a new preview on a rejected placement with no scene/budget change, or against an obsolete tool/hover.
## Acceptance

1. Road clicks and zero-length drags in 1-Lane and 2-Lane preserve an existing straight road and its connected bus route. One-Way cycles a horizontal road E/W and a vertical road N/S; degree-1 roads use that axis, an old off-axis heading resets to two-way, ordinary corner/mixed/isolated roads reject, and structure-owned roads remain no-op.
2. Road hover and committed direction change share the preset rule; no false direction notice or stale `⊘` for a no-op.
3. Standard-mode armed Track, Bus Stop, Metro Station and building each shows its price. Multi-tile Track shows the Rust **actual** charge. Creative mode says `Free`. No new TS price constants.
4. A $150 budget with a 12-tile $100 Road drag warns that only one tile will build and eleven are unaffordable; an obstructed road/track drag warns about genuinely blocked tiles, and unchanged/already-built tiles never cause a warning. Preview and commit agree on charged cost and changed tiles.
5. A bus stop clicked on a road says the specific beside-road message; other blocked placements keep the generic message. Rust transit prices and building catalog are asserted equal; TS stop/station price display is pinned.
6. Build ordinals are gone, Rotate includes `°`, and an immediately placed roundabout displays a refreshed/settled cursor badge through the shared post-dispatch path without pointer movement.
7. Focused Rust, runtime, cursor/UI, command-shelf and existing roundabout browser journeys pass. No save schema, new host operations, art or SFX are added.
8. Dead frontend `COSTS` export and its test assertion are removed; the preview response gains no new serialized field.

## Review risk and scope gate

**Main regression risk:** existing `tests/runtime/roadDirectionFeedback.test.ts` explicitly expects the unsafe North/East/South/West cycle on a horizontal road. Replace that test contract, not the bug fix. Verify input-time preset capture, queue-time map read, and preview/commit cost parity; avoid a new pricing or preview subsystem.

## Explicitly deferred

Roundabout footprint centring or requiring adjacent roads; demolition red-colour semantics; edge auto-pan; direction-change undo; dev favicon 404. Those UAT findings are outside HPA-714. No separate implementation PR: update these documents, implement and test on **this same branch/PR**.

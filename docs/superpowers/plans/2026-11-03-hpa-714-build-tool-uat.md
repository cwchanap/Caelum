# HPA-714 — Build-tool UAT fixes — Implementation plan

**Issue:** https://linear.app/cwchanap/issue/HPA-714/fix-build-tool-traps-and-missing-cost-hints-from-the-uat  
**Design:** [2026-11-03-hpa-714-build-tool-uat-design.md](../specs/2026-11-03-hpa-714-build-tool-uat-design.md)  
**Policy:** **one ticket, one PR**. Keep this draft PR for the eventual implementation; do not open a second PR. This initial change is documentation only.  
**Review:** [HPA-714 design review](https://github.com/cwchanap/Caelum/pull/78#issuecomment-6624795002) — corrections incorporated below.

## Baseline and boundaries

The inspected `main` has no open Caelum PRs. Existing hooks are `roadClickIntent` / `roadMutationForUi` / `commitDrag`, the Rust `cycle_road_direction` + `preview_road_mutation`, and the single map-local `cursorBadgeText`. Road preview already has cost and `skippedTiles`; Track does not. `BUILDING_CATALOG` already has Bus Stop, Metro Station and building prices.

Use **test → small change → re-test** per step below. Keep native Tauri/WASM thin, with Rust owning gameplay and valid costs. Do not add a cost registry, new backend method, editor framework, notifications framework, or schema migration.

## 1. Reproduce and fix safe road-direction clicks (first priority)

**Files:** `crates/caelum-core/src/road.rs` + `rejection.rs`, focused core road tests; `src/runtime/roadMutations.ts`, `src/runtime/createGameRuntime.ts`, `src/domain/types.ts`, `src/runtime/rejectionMessages.ts`; `tests/runtime/roadDirectionFeedback.test.ts` and `tests/runtime/roadDrag.test.ts`.

- **Replace the obsolete regression** that requires a horizontal road to cycle to North and break its shuttle and then N/E/S/W; it pins the bug. Add Rust tests for horizontal E/W, vertical N/S, degree-1 dead ends, an off-axis old heading corrected to two-way, an ordinary corner/mixed-axis/isolated rejection and a structure-owned no-op. Preview and committed core cycle should agree.
- Add typed `roadDirectionNeedsStraightRoad` for ordinary roads without one straight axis, with "Only straight roads can be one-way." in cursor preview and committed feedback. `cycle_road_direction` must still reject bad headings when called directly; structure-owned roads keep current behavior.
- Change `roadClickIntent`/`roadClickMutation` to take selected preset and return `GameIntent | null` / `RoadMutation | null` for gated no-ops on existing roads. Use the same decision for click, zero-length drag and hover. Show neutral "Already road", never a charged change or false rejection.
- **Capture `roadPreset` at the click/gesture commit**, passing it to `enqueueComputedDispatch`, but re-read `state.map` **when the queued closure runs**. A subsequent preset change must not retroactively turn the user's click into another action, and an earlier queued build must still be visible. `enqueueComputedDispatch` already accepts null intents.
- Keep multi-tile `layRoadLine` and existing road/roundabout pre-click preview invalidation and route-impact notices.

**Gate:** Rust invariants and real-core road-direction/drag tests pass; clicking a normal road with 1-Lane/2-Lane does not change it. **Risk:** old tests explicitly assert the unsafe North/E/S/W cycle, so update expectations rather than retaining compatibility paths.
## 2. Reuse the existing Track preview and warnings channel

**Files:** `crates/caelum-core/src/preview.rs`, `transit.rs`, `road.rs`, `engine.rs` only as needed for the shared inner track loop; `src/runtime/backend/types.ts`, `src/runtime/runtimeSelectors.ts`, `src/runtime/rejectionMessages.ts`, `src/runtime/roadMutations.ts`, `src/runtime/createGameRuntime.ts`; focused Rust/backend/runtime tests.

- Add `layTrack` and `layTrackLine` to the existing `RoadMutation` preview variants and `preview_network_candidate`. Give `apply_linear_tiles_in_order` rejection arms for these preview-only types, like `PlaceRoundabout`. **No new `GameBackend` method**, no new coordinator, no generic preview service.
- `lay_track_line_costed` currently returns snapshot-only `CostedMutation`. Reuse a **single Rust inner loop** for engine commit and preview. It should sum `authorize()?.apply_to()` for each successfully placed track tile (the **actual charge**) and collect blocked/unaffordable causes. Map the committed result to current `CostedMutation`; use `dispatch_context` for changed/unchanged preview tiles. The single-tile path keeps existing Rust `TRACK_COST` policy. Do not reimplement a track simulator in TypeScript.
- `skippedTiles` includes harmless unchanged tiles via `dispatch_context` and `record_line_results`. **Never use `skippedTiles` to choose warning tone.** Capture causes only at real Rust skip sites: Road out of bounds/roundabout-owned/disallowed reverse overlay/invalid placement = blocked, unaffordable quote = budget; Track invalid placement **except already-laid track** = blocked, unaffordable quote = budget. An accepted unchanged road/crossing or existing track is not a blocked cause. A whole rejected road stroke remains a rejection.
- Replace `WarningCode::SkippedTiles` with `TilesBlocked` and `TilesUnaffordable` (wire `tilesBlocked`/`tilesUnaffordable`). Reuse the existing `GameplayWarning.context.footprint` and `RoadMutationPreviewResponse.warnings`; no new serialized response field or extra counts. Pass `warnings` through `buildRoadMutationPreview`; replace obsolete generic `warningMessage` copy. UI count = corresponding warning footprint length.
- Wire Track hover/drag through existing `roadMutationForUi` / `commitWithRoadPreview` / generation handling without changing actual Track dispatch. Keep coordinator invalidation and debouncing.
- Tests: compare preview and commit on $150/12-tile Road stroke ($100 charged, 11 unaffordable), blocked Road/Track stroke, existing road/track no-op (no partial-build warning), and Creative-mode paid placement.

**Gate:** Rust preview stays read-only, matches commit cost and cause footprints, and the backend retains nine operations.
## 3. Cost and genuine failure reason beside the cursor

**Files:** `src/render/mapTextOverlay.ts`, `src/runtime/runtimeSelectors.ts` and existing preview view types; `src/domain/catalog/transit.ts`, `tests/runtime/runtimeSelectors.test.ts`, `tests/runtime/buildingCatalog.test.ts`, `tests/render/mapTextOverlay.test.ts`, `tests/ui/mapTextOverlay.test.ts`; one focused Rust pricing test.

- Keep a single `cursorBadge` per hover/drag tile. Road/Roundabout/Track show **Rust** preview charges. Bus Stop/Metro Station/selected building display `BUILDING_CATALOG[type].cost` and existing `canPlaceBusStop`/`canPlaceBuilding` validity checks. Delete unused `COSTS` export from `src/domain/catalog/transit.ts` and its *only* selector-test assertion rather than reviving a TS copy of `TRACK_COST`.
- Ensure `BUS_STOP_COST` and `METRO_STATION_COST` equal their Rust `building_definition` catalog entries in one focused Rust assertion. Pin those two displayed prices in current `buildingCatalog.test.ts`. No codegen or additional cost service.
- Display `⦿ Label · $X` or `Free` in Creative mode, with equivalent non-live `a11yText`. Locally invalid placements can show an informational listed price plus `⊘`; a rejected Rust preview **wins over** price. Pending/stale previews remain neutral.
- For accepted Road/Track results, set warning tone only when `tilesBlocked` or `tilesUnaffordable` has a nonempty footprint; show concise cause/count, e.g. "Not enough money, 11 tiles skipped" or "2 tiles blocked." Keep broken-first route-impact summary, no second overlay, no generic unclassified skipped warning.
- Update the existing cursor test which accepts a Rust preview with unchanged/skipped tiles: **its warning expectation must follow `warnings`, not `skippedTiles`**. Add one no-op-only neutral test and one truly blocked warning test.

**Gate:** Stop/Station/building/Track cost, Standard/Creative, blocked/budget warnings and neutral existing-road clicks pass focused UI tests.
## 4. Contextual copy, Build polish and **shared** post-dispatch refresh

**Files:** `crates/caelum-core/src/transit.rs` + `rejection.rs`; `src/domain/types.ts`, `src/runtime/rejectionMessages.ts`; `src/components/hud/panels/BuildPanel.svelte`, applicable CSS and UI tests; `src/runtime/createGameRuntime.ts` and focused runtime preview tests.

- When a Bus Stop targets an existing road tile, return `stopMustBeBesideRoad` → "Place stops beside a road, not on it." Keep `blockedTile` for other collisions; no intent-tracking framework.
- Remove `tool-num` 01/02 ordinals, markup, obsolete style/test assertions and **BuildPanel's** `pad2` import; `pad2` elsewhere (including `runtimeSelectors.ts`) remains. Show `buildingRotation` with `°` and keep the current accessible "degrees" name; real shortcut chips remain.
- **No new roundabout-specific refresh path.** `commitDispatchResult` already handles applied scene/budget changes; derive `roadMutationForUi(nextState, nextUi)` instead of relying on cleared `activeRoadMutation`. Keep pre-click coordinator invalidation so stale answers cannot repopulate. Reuse existing generation bump and `sendRoadMutationPreviewRequest` for Roundabout/Road/Track. A rejected placement without scene/budget change does not re-request; when tool/hover changed during pending dispatch, use the current `nextUi`.
- Add focused runtime test: after successful roundabout placement, the cursor badge settles **without pointer movement**; an older pending preview is dropped.

**Gate:** one shared post-dispatch refresh mechanism, with no new component/state owner.
## 5. Focused browser journeys and verification

**Files:** extend `tests/e2e/commandShelf.spec.ts` for Road/One-Way/Track/partial-warning interactions, and `tests/e2e/roundabouts.spec.ts` for stationary-pointer post-roundabout refresh. Reuse existing setups, no new suite.

Walk through: arm 1-Lane, click existing horizontal road (no change); arm One-Way, click the road (only E/W); hover/drag Track to see actual price; inspect a truly unaffordable/blocked partial stroke and neutral unchanged road/track; place a roundabout and confirm the badge settles without moving pointer.

Run the repository's normal gates after implementation (this design-only update does **not** claim they have run):

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
bun run check
bun run lint
bun run test:unit
bun run format:check
bun run test:e2e
```

Confirm WASM and Tauri still consume the same preview contract, without a save-schema change. Manually inspect cursor text at map edges if convenient.

### Risks and controls

- **Intentional regression-test change:** `roadDirectionFeedback.test.ts` pins unsafe North/E/S/W cycling and route breakage; replace that contract before implementation.
- **False warnings:** unchanged roads/crossings and already-laid track can appear in `skippedTiles`; only Rust-classified `tilesBlocked`/`tilesUnaffordable` should tone the badge.
- **Queued clicks and stale previews:** capture preset at click, re-read map on execution, and re-derive post-dispatch preview from current state/UI; keep invalidation/generation checks.
- **Cost drift:** Rust stop/station constants match Rust building catalog; TS catalog display is pinned. Preview/commit share the same Track placement loop.

Do not broaden into cost services, an extra preview method, unrelated UAT, new art/SFX tasks or multiple PRs.
## Review checklist

- [ ] Rust headings stay on resolved axis; unsupported ordinary roads reject, structure-owned no-op, legacy off-axis headings reset
- [ ] Click and stationary drag capture preset at input, read map at queued execution; hover matches mode
- [ ] Track preview/commit share Rust cost loop; blocker/budget footprints reuse existing warnings, with no false no-op warnings
- [ ] Stop/station/building prices come from BUILDING_CATALOG; Rust/TS price pins, dead COSTS removed, Creative Free
- [ ] An accepted partial stroke shows warning + actual charge; no stale preview
- [ ] Bus Stop on road has specific copy; generic blocked error unchanged elsewhere
- [ ] No fake ordinal shortcuts; degree suffix and shared post-dispatch roundabout hover refresh verified
- [ ] Focused core/UI/Playwright checks pass; update docs on **this same PR**
- [ ] No unrelated UAT items, migrations, new host operations, or new assets

**Out of scope:** roundabout centring/grass prerequisites, demolish colour meanings, map edge-scroll, undo direction changes, favicon repair. Handle those only if separately prioritized.

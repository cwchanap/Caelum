# HPA-714 — Build-tool UAT fixes — Implementation plan

**Issue:** https://linear.app/cwchanap/issue/HPA-714/fix-build-tool-traps-and-missing-cost-hints-from-the-uat  
**Design:** [2026-11-03-hpa-714-build-tool-uat-design.md](../specs/2026-11-03-hpa-714-build-tool-uat-design.md)  
**Policy:** **one ticket, one PR**. Keep this draft PR for the eventual implementation; do not open a second PR. This initial change is documentation only.

## Baseline and boundaries

The inspected `main` has no open Caelum PRs. Existing hooks are `roadClickIntent` / `roadMutationForUi` / `commitDrag`, the Rust `cycle_road_direction` + `preview_road_mutation`, and the single map-local `cursorBadgeText`. Road preview already has cost and `skippedTiles`; Track does not. `BUILDING_CATALOG` already has Bus Stop, Metro Station and building prices.

Use **test → small change → re-test** per step below. Keep native Tauri/WASM thin, with Rust owning gameplay and valid costs. Do not add a cost registry, new backend method, editor framework, notifications framework, or schema migration.

## 1. Reproduce and fix safe road-direction clicks (first priority)

**Files:** `crates/caelum-core/src/road.rs`; `tests/road_authoring.rs` or `tests/engine_topology.rs` under `crates/caelum-core`; `src/runtime/roadMutations.ts`; `src/runtime/createGameRuntime.ts`; `tests/runtime/roadDirectionFeedback.test.ts`, `tests/runtime/roadDrag.test.ts`, existing runtime preview tests.

- Write one Rust regression for a horizontal straight road whose legal headings are only E/W, and one vertical case N/S. Assert `None → forward → reverse → None`, topology stays valid and no perpendicular direction is produced. Assert mixed-axis/structure-owned contact is unchanged.
- Replace the **old** real-core test contract in `roadDirectionFeedback.test.ts` that currently explicitly expects a horizontal road to cycle to North, break the shuttle, and cycle North/East/South/West. Do not keep that obsolete assertion as a competing test. Use `setRoadPreset("oneWay")` for direction-change tests; separately cover twoWay/dual no-op by click and stationary drag.
- Make `roadClickIntent` return `GameIntent | null` (and preview mutation `RoadMutation | null`), taking the selected road preset. Keep execution-time map lookup in `enqueueComputedDispatch` for queued actions; no-op returns without backend dispatch, price charge or direction notice.
- In Rust `cycle_road_direction` derive the axis once from reciprocal port connections and select only the two parallel directions. Do not patch by checking UI preset inside Rust: the chosen preset gates the **frontend action**, while Rust must independently keep an invoked `CycleRoadDirection` safe.
- Update hover preview fallback for no-op existing roads to a neutral "Already road"; clear stale preview on no-op. Keep normal multi-tile `layRoadLine` and explicit One-Way route-impact feedback unchanged.

**Gate:** Rust invariant tests plus selected runtime road-direction/drag tests pass before touching cost UI.

## 2. Make Track cost and partial-build previews authoritative

**Files:** `crates/caelum-core/src/preview.rs`, `crates/caelum-core/src/transit.rs`, `crates/caelum-core/src/road.rs` only as needed for the existing preview mutation variants; `src/runtime/backend/types.ts` and existing WASM/Tauri preview serialization/normalization tests; `src/runtime/roadMutations.ts` and `src/runtime/createGameRuntime.ts`.

- Extend **the existing** `previewRoadMutation` request with Track single/line mutations; no additional `GameBackend` operation or separate preview coordinator. Use Rust's current `lay_track_costed` / `lay_track_line_costed` logic on a candidate snapshot. Capture real `changedTiles`, `skippedTiles` and paid `cost`.
- Expose small skip-cause counts on the existing preview response only where necessary. Populate blocked/insufficient-budget counts at the same per-tile decisions in Rust road/track paths. Keep non-budget remainder as a generic skipped count; prevent approved unchanged crossing tiles from being falsely called "blocked." Roundabout/remove previews use empty counts.
- Wire Track hover and drag through existing `roadMutationForUi` / `commitWithRoadPreview` / generation handling. Do not lose the currently correct debounce and stale-held-preview logic. Keep actual Track dispatch (`layTrack` / `layTrackLine`) unchanged.
- Test one budget-limited 12-tile Road stroke ($150 → $100 charge, 11 unaffordable), one blocked tile within a Road stroke, and one blocked/limited Track stroke. Compare preview to actual dispatch at the core boundary, including one Creative case.

**Gate:** Rust preview is read-only, reports the correct cost and skips, and the existing backend contract remains a single nine-method interface.

## 3. Show the price and partial-build reason beside the cursor

**Files:** `src/render/mapTextOverlay.ts`, `src/runtime/runtimeSelectors.ts` and preview view type if needed; `src/domain/catalog/buildings.ts` (small reuse of existing shared prices only); `tests/render/mapTextOverlay.test.ts`, `tests/ui/mapTextOverlay.test.ts`.

- Keep one `cursorBadge` per current hover/drag tile. Use Rust quoted cost for Road/Roundabout/Track. For Bus Stop/Metro Station/armed building, reuse `BUILDING_CATALOG[type].cost` and existing read-only validation. Do not add new literals for track or transit prices; if consolidating duplicated frontend stop/station prices, reference the already-existing `COSTS` values rather than copying them again.
- Display `⦿ Label · $X` or `Free` in Creative mode; extend the non-live accessible readout consistently. Unaffordable or blocked single-placement badges still show informational listed price with `⊘`; a rejected Rust preview shows the rejection instead of an apparent charge.
- For accepted Road/Track preview with real skipped tiles, set existing warning tone and add concise counts (`Not enough money, 11 tiles skipped` / `2 tiles blocked`). Keep the actual charged cost shown, not an all-tiles quote. For mixed or unknown causes do not invent a specific reason.
- Keep existing route impact text (broken before rerouted); combine without creating another overlay or strip notification. Preserve pending/stale-generation behavior so a warning from a prior stroke cannot persist as current.

**Gate:** Cursor tests for Track/Stop/Station/building prices, Creative/Standard, one partial-budget warning, one blocked warning, and no-op existing road. Update old test expecting an accepted preview with a skipped tile to have no warning: the new warning is intentional.

## 4. Contextual rejection and small UI corrections

**Files:** `crates/caelum-core/src/transit.rs` + `rejection.rs` (new narrow rejection code); `src/domain/types.ts`, `src/runtime/rejectionMessages.ts`; `src/components/hud/panels/BuildPanel.svelte` and applicable CSS; `src/runtime/createGameRuntime.ts` (roundabout refresh); `tests/runtime/rejectionMessages.test.ts` / existing equivalent; `tests/ui/buildPanel.test.ts` and runtime preview tests.

- Return the new stop-on-road rejection only when a Bus Stop placement actually targets a road. Map it to "Place stops beside a road, not on it." Do not globally replace `blockedTile` for buildings or footprints.
- Delete `pad2(index + 1)` and the ordinal element, associated obsolete styling/import/tests; keep genuine shortcut chips. Render `buildingRotation` with the degree symbol while preserving the current accessible button name.
- Upon successful `placeRoundabout`, request a fresh preview for the *current* armed tool/hover against the committed new snapshot, even if the cursor has not moved. Reuse the existing request generation and ignore stale results; do not refresh after a rejected placement or if the user changed tools.
- Add focused UI/runtime regression for the settled label immediately after roundabout placement.

**Gate:** Existing build panel accessibility and keyboard behavior remains intact; no new component.

## 5. One focused player-flow and verification

**File:** extend `tests/e2e/commandShelf.spec.ts` or existing build-tool Playwright scenario (no new test suite).

Walk through: arm 1-Lane, click existing horizontal road (no change); arm One-Way, click same road (only E/W); hover/drag Track and read cost; inspect a budget-limited stroke warning; place a roundabout and confirm the label settles without another move. Reuse fixtures and browser setup; do not require new art.

Run the repository commands after code changes (do not mark as passed until executed):

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

Also confirm browser/WASM and Tauri call the same existing preview contract, with no save-schema update. Do a quick manual pointer/cost look if available.

## Review checklist

- [ ] Rust road headings stay on connected axis; mixed/structure road no-op
- [ ] Both road-click entry points + hover respect selected preset and queued execution order
- [ ] Track preview uses Rust, not a new TS cost simulator; skip reasons are evidence-based
- [ ] Stop/station/building listed prices reuse current catalogs; Creative labels say Free
- [ ] An accepted partial stroke shows warning + actual charge; no stale preview
- [ ] Bus Stop on road has specific copy; generic blocked error unchanged elsewhere
- [ ] No fake ordinal shortcuts; degree suffix and post-roundabout hover refresh verified
- [ ] Focused core/UI/Playwright checks pass; update docs on **this same PR**
- [ ] No unrelated UAT items, migrations, new host operations, or new assets

**Out of scope:** roundabout centring/grass prerequisites, demolish colour meanings, map edge-scroll, undo direction changes, favicon repair. Handle those only if separately prioritized.

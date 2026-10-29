# HPA-180 — Cursor build feedback and shortcut hints — Implementation plan

**Issue:** https://linear.app/cwchanap/issue/HPA-180/show-build-cost-and-shortcuts-at-the-cursor  
**Design:** [2026-10-28-hpa-180-cursor-feedback-shortcuts-design.md](../specs/2026-10-28-hpa-180-cursor-feedback-shortcuts-design.md)  
**PR policy:** **one ticket = one PR**. Continue implementation and review in this draft; do not create a second implementation PR.

## Scope gate and current reuse

- `selectMapTextOverlayItems` already derives a separate cursor badge and road-preview item; `MapTextOverlay.svelte` owns board-projected DOM text and vertical flipping. Do not add a new renderer or state owner.
- `buildRoadMutationPreview` already provides generation-checked Rust responses for **road, roundabout and remove**, but not track or area. `setHoverTile` already clears stale previews.
- `selectActionFeedback` holds ephemeral preview branches plus actual-result branches; `ShellState.roadMutationPreview` is not used by a production component once strip previews go away. Keep `UiState.roadMutationPreview` for the map/GPU.
- Real key handling lives in `App.svelte`; Build/Select/Demolish are on the command shelf, Track is a Build leaf, Rotate is enabled conditionally, and numbered road presets already have ordinal labels.

Reuse these seams; no new Rust pricing, preview API, keyboard dispatcher, framework or second implementation PR.

## Step 1 — Consolidate cursor feedback in existing map-text derivation

**Files:** `src/render/mapTextOverlay.ts`, `src/components/MapTextOverlay.svelte`, `src/styles.css`

- Build one `cursorBadge` at `ui.drag.current ?? ui.hoverTile` whenever the cursor has a useful **generation-matched** preview, independent of tool: **road, roundabout, remove**. Add a small `tone` field for rejected-preview styling. Delete the distinct `roadPreview` union kind, `roadPreviewAnchor` and its separate push; drop the unused `placement` field and its fixtures.
- Keep tool name and compact Rust cost/impact on accepted previews. When Rust rejects, show `rejectionMessage(preview.rejection)`, a warning tone and `⊘` **instead of the nominal cost**. This includes roundabout rejection (which otherwise loses its reason when Step 2 removes the strip branch).
- Reuse the existing pending-state fallback: once a matching Rust response exists, **only its rejection** determines `⊘`/warning, not the TypeScript single-tile road-validity heuristic. That prevents a skipped endpoint being displayed as rejected when Rust accepted the line. For no matching response, retain ordinary badges and the pending roundabout glyph.
- For **idle remove hover**, suppress empty-ground `blockedTile`/other rejection previews and leave `⦿ Demolish`; show rejection details during an actual remove drag. Keep useful accepted removal preview and real dispatch failure unchanged.
- For Creative economy show `Free` rather than a misleading nominal build charge; this is a simple display check of `state.rules.economyPreset`, not a TypeScript cost engine.
- Keep DOM overlay noninteractive. Mirror vertical flip with a lightweight **horizontal side flip** based on anchor x versus measured board width (left third/right third/centre). Use a CSS class and ensure combined horizontal/vertical transforms work. Do **not** implement measured-width clamping or speculative max-width/long-text styles. Examine a real browser if a long message still overflows.

**Focused tests:** update existing `tests/render/mapTextOverlay.test.ts` and `tests/ui/mapTextOverlay.test.ts` for the merged label, Rust verdict over old glyph, **roundabout rejection reason**, removal hover suppression versus drag, and one side-flip class assertion using the existing mocked board dimensions. Adapt old `roadPreview` and `placement` expectations. Reuse existing stale/generation checks; do not duplicate coverage purely for branch count.

## Step 2 — Remove transient feedback-strip duplication

**Files:** `src/runtime/runtimeSelectors.ts`, `src/runtime/types.ts`, impacted selector/feedback tests

- Delete `roadImpact`/`roadRejection` branches and their `ShellActionFeedback.source` variants. Remove the now-unused `roadPreview` parameter from `selectActionFeedback` and its call; remove `ShellState.roadMutationPreview` and the extra `selectShellState` assignment.
- Do not remove the underlying `UiState.roadMutationPreview` or `buildRoadMutationPreview`, still used by DOM/WebGPU map presentation.
- Preserve **real** `rejection`, `roadDirection` and `roadHostError` feedback, ordering, accessibility and route-editor ownership.

**Focused tests:** update `tests/runtime/runtimeSelectors.test.ts` to prove preview-only hover does not populate the strip; preserve the existing actual rejection and host-error cases. Delete/update the obsolete shell-preview assertion (formerly around line 1583). Remove the dead `roadImpact` fixture/assertions from `tests/ui/actionFeedback.test.ts` instead of rebuilding those tests.

## Step 3 — Define small shared shortcut constants and hints

**Files:** `src/ui/shortcuts.ts`, `src/App.svelte`, `src/components/hud/panels/BuildPanel.svelte`, `src/components/hud/CommandShelf.svelte`

- Define plain `B/R/T/D/V/1/2/3` key constants and use them in corresponding `App.svelte` comparisons. Do **not** create a context-aware hint lookup, keyboard registry or new dispatch mechanism. Leave undo/redo, Delete/Backspace, pan, Escape and camera keys App-local.
- Visible `aria-hidden="true"` chips appear **only where click matches the key action**: shelf Build **B**, Select **V**, Demolish **D**; Track leaf **T**; conditionally enabled Rotate button **R**. Do not show an R-for-Road chip (no matching button).
- Road preset `1/2/3` keys appear **only in the preset leaf `title` and `aria-keyshortcuts` while the Road tool is armed**. Existing 01/02/03 ordinals remain unchanged; add no duplicated visible chip. Without an armed Road tool, show no active preset shortcut claim.
- Use native `aria-keyshortcuts` and `title` on chip buttons too (`Select (V)`); keep chips hidden from the accessible name and leave `aria-label`/text names unchanged. Honor current disabled-state and route-draft guards.

**Focused tests:** add chip rendering, native shortcut attributes and unchanged accessible-name assertions to current `tests/ui/buildPanel.test.ts` and `tests/ui/commandShelf.test.ts` (or closest existing shelf tests). **Do not** re-test existing keyboard action behavior in `appShell.test.ts`; it already covers the matching key dispatch. Only modify those tests if an existing assertion breaks legitimately.

## Step 4 — Focused browser journey and review

**File:** `tests/e2e/commandShelf.spec.ts`

- Rewrite the existing road-preview `roadImpact` strip assertion to inspect the **single map-local** road cost label (on hover/drag, anchored to current tile).
- Extend that same focused journey to prove a rejected preview gives its warning **at the cursor but not the strip**, while a genuine failed commit still produces the dismissible strip feedback.
- Keep a manual browser look at unusual long/edge messages before adding CSS. Do not add separate E2E coverage for unchanged `pointer-events: none`, edge class flipping or already-tested keyboard behavior.
- Run `bun run check`, `bun run test:unit`, `bun run lint:svelte`, `bun run lint:css`, `bun run format:check`, and the repository's focused Playwright command. Record actual results. CI remains the merge gate.

## Implementation boundaries and review questions

- **Tool coverage:** Use Rust generation-matched previews for road, **roundabout** and remove. Never invent a track/area preview price or add a generic host contract.
- **Verdict precedence:** Once Rust responds, don't mix its accepted multi-tile result with TS single-tile `⊘`. The roundabout rejection reason must survive the strip cleanup; remove hover on empty ground should remain quiet.
- **One feedback owner:** Temporary preview belongs to the cursor, actual dispatch failures and host errors stay in the strip. Delete the unconsumed `ShellState.roadMutationPreview` projection.
- **UI discoverability:** Show chips only for real matching actions; preserve accessible button names; don't turn road preset ordinals into duplicated keys.
- **YAGNI:** No generic keymap, no width-measurement utility, no extended verification matrix, no new art or SFX. If assets are requested later, scope them separately. Design and implementation stay on this single PR.

## Done when

There is one truthful current-tile map label for road/roundabout/remove, with Rust-owned acceptance, quiet demolition hover and correct Creative/free wording; real outcomes remain in the strip; stale shell-preview data is deleted; visible chips match clickable actions without changing their accessible names; focused tests and a short actual validation record are included. No Rust save/schema/host changes, new frontend architecture or second PR.

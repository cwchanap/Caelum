# HPA-180 — Cursor build feedback and shortcut hints — Design

**Linear:** https://linear.app/cwchanap/issue/HPA-180/show-build-cost-and-shortcuts-at-the-cursor  
**Repository:** cwchanap/Caelum  
**Baseline:** current `main`, inspected 2026-10-28 (GitHub code index at `4b9d69e`)  
**Delivery:** design, plan and eventual implementation on this **single draft PR**.

## Player outcome

When building roads or demolishing, the player reads the current, authoritative preview cost / route impact / rejected placement near the current map tile rather than searching the bottom-right feedback strip. Build controls also reveal the keyboard shortcuts that actually work in the current mode.

No new preview protocol, gameplay economy, input framework, art or audio.

## Existing seams (verified)

- `src/render/mapTextOverlay.ts` already derives a `cursorBadge` anchored at `ui.drag.current ?? ui.hoverTile` and a **second** `roadPreview` anchored at the first authored/changed tile. Their labels can be separate and drift apart visually.
- `src/components/MapTextOverlay.svelte` already converts map-space anchors using `getBoardTransform`; it and `src/styles.css` own the noninteractive DOM text above WebGPU.
- `buildRoadMutationPreview` in `src/runtime/runtimeSelectors.ts` generation-checks Rust-owned cost, route impacts and rejection, and maps line IDs to names.
- `src/runtime/createGameRuntime.ts` requests `previewRoadMutation` for road and **remove** drags (also road/roundabout/remove hover); track and area drags do **not** have an equivalent authoritative preview. Generation invalidation prevents late responses becoming the current preview.
- `selectActionFeedback` currently presents `roadImpact` / `roadRejection` in the strip *as well as* road-preview text on the map; real dispatched rejections, road preview host errors and road-direction-change notices have distinct meaning.
- `src/App.svelte` owns keyboard dispatch. `BuildPanel.svelte` and `CommandShelf.svelte` render discoverable controls. The **chip-bearing** bindings for this task are B, R, T, D, V and road-only 1/2/3; **R rotates a selected building instead of arming Road**. Other existing branches handle route-draft undo/redo (Ctrl/Cmd+Z/Y), waypoint Delete/Backspace, arrow pans, Escape and map +/-/0, and are not part of the shared chip keymap.

## Decision 1 — One map-local preview label, not a new overlay

Extend the existing cursor badge/preview derivation rather than creating a second component or state owner.

- Use a **single cursor-attached** label for road/remove hover and drag whenever an eligible Rust preview is available, instead of simultaneously rendering a cursor badge and separately anchored road-preview label. Anchor to `ui.drag.current` for active drags; otherwise `ui.hoverTile`. Preserve the existing no-preview / no-cursor behavior.
- Show the tool label and the authoritative cost when meaningful. For accepted road previews, summarize impacts compactly (e.g. `$500 · Line 3 breaks`, `2 lines reroute`), prioritizing broken-route warnings over reroute counts. An explicit rejected road preview shows the existing `rejectionMessage` in a warning-toned cursor label, **not a misleading cost**.
- Keep the current preview generation check and do not create independent TS price, routing or validity calculations. Do not label a stale preview as current during rapid movement. Preserve click-only roundabout preview information, road direction feedback and route waypoint/failure labels.
- For track and zone drags the label still identifies the active tool, but **does not invent a monetary preview**: neither has a Rust preview response today. Removal uses its existing Rust preview where it provides useful information. This is an explicit limit on the issue's broader wording, not permission to introduce a second pricing engine.
- Reuse current DOM text overlay and positioning; keep it `pointer-events: none`, clipped to the board, and add narrowly scoped warning/long-text styles plus horizontal edge clamping so the label stays legible near viewport edges. The merged label must drop the existing **unused** `cursorBadge.placement: "aboveOrBelow"` field; `MapTextOverlay.svelte` already owns the vertical flip by item kind. Avoid a toast clone or a large persistent panel.

## Decision 2 — Keep the feedback strip for actual outcomes

In `src/runtime/runtimeSelectors.ts`, stop returning `roadImpact` and `roadRejection` from `selectActionFeedback`, and remove those two unused variants from `ShellActionFeedback.source`.

Preserve:
- `rejection`: actual accepted/failed gameplay dispatch, dismissible and announced.
- `roadDirection`: a committed road-direction change and any routes it broke, dismissible and announced.
- `roadHostError`: recoverable preview-host failure, visible even when no authoritative cursor preview is available.

Do not turn transient pointer movement into a live-region announcement. Reuse the existing error/feedback presentation path; do not affect route-editor-owned rejections.

## Decision 3 — Share shortcut definitions without rewriting the input system

Add one tiny `src/ui/shortcuts.ts` holding key/label constants **only for visible shortcut-chip actions** (B/R/T/D/V and road-only 1/2/3) and the smallest necessary context-sensitive hint lookup. Use those constants in the corresponding `App.svelte` key comparisons and render labels in `BuildPanel.svelte` / `CommandShelf.svelte`. Leave undo/redo (Z/Y), Delete/Backspace waypoint removal, arrow pans, Escape and camera +/-/0 comparisons App-local: they have no new chip surface in this task. Add the applicable hint in title/accessible label text and a small visual chip.

- Build B, Road R (unless a building is armed), Track T, Demolish D, Select V; on an armed Road tool, presets 1/2/3. A selected building uses R for Rotate, with that **context made explicit**.
- Do **not** add Escape/camera navigation hint chips or extend the shared module for those keys. **Do not pretend** every Build leaf has a shortcut; omit the chip for actions without a direct key.
- Preserve target/input guards, route-draft keyboard handling and all current RuntimeController calls. Keep route draft lock behavior; labels must not suggest that a disabled action can be triggered.
- Treat numeric `tool-num` labels in BuildPanel as **ordinal positions**, not keyboard shortcuts. Do not silently rebrand them as keys.

## Acceptance / verification

1. Road hover/drag with nonzero Rust cost shows exactly one map-local label near the current pointer tile; moving the drag moves the label. Current route damage is summarized there.
2. Rust preview rejection appears in warning tone by the cursor, not in the feedback strip; stale previews are never shown as fresh.
3. Road/removal preview host errors, committed direction notices and **actual** dispatch rejections keep their existing strip behavior and announcement rules.
4. Track and area drags still show truthful active-tool feedback without fabricated cost. Zero-cost removal is not advertised as a refund.
5. Shortcut chips reflect B/R/T/D/V, road-only 1/2/3 and the contextual R rotation behavior, sharing constants with precisely those key comparisons; unhinted undo/delete/pan/navigation and input focus/route draft behavior remain unchanged.
6. A unit-level DOM overlay test verifies a long cursor warning is horizontally clamped at a board edge; the removed `placement` field does not survive the merged label.
7. Existing map-text / selector / BuildPanel / shelf and focused browser tests pass after obsolete dual-preview/strip assertions are updated.

## Explicit non-goals

No Rust or host contract/schema changes; no new generic preview pipeline for track or zones; no estimated pricing in TypeScript; no configurability for keybindings; no keymap registry, event bus, or additional management panel; no new art/SFX; no unrelated toast layout repair (#68).

The first implementation should validate the cursor placement and wording in a real browser rather than expanding speculative edge-case or accessibility machinery.

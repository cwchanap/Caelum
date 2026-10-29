# HPA-180 — Cursor build feedback and shortcut hints — Design

**Linear:** https://linear.app/cwchanap/issue/HPA-180/show-build-cost-and-shortcuts-at-the-cursor  
**Repository:** cwchanap/Caelum  
**Baseline:** current `main`, inspected 2026-10-28 (GitHub code index at `4b9d69e`)  
**Delivery:** design, plan and eventual implementation on this **single draft PR**.

## Player outcome

When building roads or demolishing, the player reads the current, authoritative preview cost / route impact / rejected placement near the current map tile rather than searching the bottom-right feedback strip. Build controls also reveal the keyboard shortcuts that actually work in the current mode.

No new preview protocol, gameplay economy, input framework, art or audio.

## Existing seams (verified)

- `src/render/mapTextOverlay.ts` already creates a `cursorBadge` at `ui.drag.current ?? ui.hoverTile` plus a separately anchored `roadPreview`. The cursor badge's `placement` member is unused.
- `MapTextOverlay.svelte` projects these labels using `getBoardTransform`. CSS positions the map text over WebGPU with `pointer-events: none`.
- `buildRoadMutationPreview` generation-checks Rust-owned cost, route impacts and rejection. The runtime calls the same preview path for road, **roundabout** and remove; neither track nor area has this authoritative preview. Rust can return nominal cost even on rejected roundabouts.
- `cursorBadgeText` currently uses a simple TypeScript road-tile check that can disagree with Rust for a multi-tile stroke (skipped endpoints or budget failures); Rust must win once a matching preview arrives.
- `selectActionFeedback` currently duplicates temporary `roadImpact`/`roadRejection` in the strip. The strip must still carry actual dispatched rejections, committed road-direction warnings and preview-host errors. `ShellState.roadMutationPreview` has no remaining production reader once the strip branches go away.
- `App.svelte` owns keys B/R/T/D/V and road-only 1/2/3, plus unhinted route editing, Escape and camera keys. The shelf owns Build, Select and Demolish buttons; BuildPanel owns a Track leaf and a conditional Rotate button. The road-preset leaves already show ordinal labels 01/02/03.

## Decision 1 — One map-local preview label, not a new overlay

Extend the existing `cursorBadge` derivation, using one generation-matched Rust preview **regardless of whether the active mutation is road, roundabout or remove**. No new component or preview request is needed.

- At `ui.drag.current ?? ui.hoverTile`, render **one** cursor item (kind `cursorBadge`, with a small `tone` property) combining the tool name with useful current-preview information. Delete the separate `roadPreview` kind, `roadPreviewAnchor`, and its push from `selectMapTextOverlayItems`. Drop unused `cursorBadge.placement` and update its fixtures.
- Accepted previews can show Rust-supplied cost and succinct route impact (broken lines first, otherwise reroutes). For **rejected** previews, show the existing `rejectionMessage`, warning tone and `⊘`; never display a rejected nominal cost as if chargeable. **Include rejected roundabouts**, so removing the strip branch cannot hide their rejection reason.
- Once a matching Rust preview exists, its `rejection` is the **only validity verdict** (including the `⊘` glyph): do not combine it with the older `isValidRoadPlacement` heuristic. Keep the TypeScript road glyph only while a matching preview is pending. Retain ordinary tool/track/area badges, roundabout-pending text and route waypoint/failure labels.
- For remove *hover*, suppress preview rejections such as `blockedTile` on empty ground: show only `⦿ Demolish` unless there is a useful accepted preview. For remove *drag*, show real Rust rejection reasons. Actual failed commits remain visible as dispatch rejections in the feedback strip.
- For Creative sandbox, where Rust does not deduct nominal construction costs, show a clear `Free` label instead of a misleading nominal price. This is a display-only economy-mode check; do not calculate prices in TypeScript.
- Preserve preview-generation checks and clearing. Track and area drags still show truthful tool badges without fabricated cost; no new Rust/host API.
- Position the label with the existing vertical flip and a **simple horizontal side flip** according to the tile's x-position relative to the measured board (left third align to the right, right third align to the left, centre unchanged). Expose a CSS class, mirror the existing vertical flip, and test that class with the current mocked board width. Avoid measuring label width in jsdom or adding max-width/long-text styling unless a real browser check demonstrates a need. Keep `pointer-events: none`.

## Decision 2 — Keep the feedback strip for actual outcomes

In `src/runtime/runtimeSelectors.ts`, remove the `roadImpact` and `roadRejection` branches and the now-unused `roadPreview` argument to `selectActionFeedback`. Drop those two variants from `ShellActionFeedback.source` **and** remove the dead `ShellState.roadMutationPreview` field, its `selectShellState` assignment and obsolete tests. Keep the underlying `UiState.roadMutationPreview`: the map and WebGPU still consume it.

Preserve the strip precedence and behavior of:
- `rejection`: an actual failed gameplay dispatch, dismissible and announced;
- `roadDirection`: committed direction changes and newly broken routes, dismissible and announced;
- `roadHostError`: preview host failure, not a transient pointer rejection.

Do not announce pointer previews via a live region or alter route-editor rejection ownership.

## Decision 3 — Share shortcut definitions without rewriting the input system

Add a tiny `src/ui/shortcuts.ts` with **plain key constants**, consumed by the corresponding `App.svelte` comparisons. Do not create a key-dispatch registry or context-sensitive hint lookup; the component's actual button state determines whether the hint applies.

- Render visible key chips **only where clicking the control performs the same action**: Build **B**, Select **V**, Demolish **D** (CommandShelf); Track **T** (Build leaf); Rotate **R** (BuildPanel's Rotate button, enabled only for an armed building). Never show an R-to-Road chip: there is no matching Road button, and R rotates while a building is armed.
- Road-preset keys **1/2/3** remain constants used by App. Do not add duplicate chips beside the existing 01/02/03 ordinals. Expose shortcut via `title` / `aria-keyshortcuts` **only while Road is armed**; outside Road mode do not falsely advertise an active preset shortcut.
- Chips have `aria-hidden="true"`. Use native `aria-keyshortcuts` and a `title` such as `Select (V)`, without changing the controls' existing accessible names or adding keys to `aria-label`. Keep disabled/route-draft semantics accurate.
- Existing unhinted undo/redo (Z/Y), Delete/Backspace, arrow pan, Escape and zoom/fit keys stay App-local and unchanged. Preserve modifiers, input guards, route-draft locks and runtime calls. Numeric `tool-num` labels remain ordinals.

## Acceptance / verification

1. Hover/drag road and roundabout cost/impact shows **one** current-tile label, with Rust deciding acceptance. A rejected roundabout shows its actual reason and no misleading price. Stale previews never override the pending badge.
2. Empty Demolish hover does not spam `blockedTile`; removal drag rejection is shown by the cursor. Actual failed dispatch, direction change and preview-host error remain in the strip with their existing announcement behavior.
3. Accepted line previews do not receive contradictory TypeScript `⊘` glyphs. Creative mode never implies a nonzero charge for a free action.
4. Track/area badges remain truthful; no TS price derivation is added.
5. A mocked-board UI test covers horizontal side-flip, in addition to existing vertical flip; no text-width measurement machinery is introduced.
6. Visible chips are restricted to matching control actions (B/V/D/T/R); 1/2/3 are conditional title/accessibility hints only, while other shortcuts stay unaffected. Accessible button names do not change.
7. Update affected unit/UI and the existing focused Playwright road-preview/rejection journey; no new generic suite, renderer feature or additional PR.

## Explicit non-goals

No Rust or host contract/schema changes; no new generic preview pipeline for track or zones; no numeric pricing in TypeScript; no configurable shortcuts, keymap registry, event bus or additional management panel; no new art/SFX; no unrelated toast layout repair (#68).

The first implementation should validate the cursor placement and wording in a real browser rather than expanding speculative edge-case or accessibility machinery.

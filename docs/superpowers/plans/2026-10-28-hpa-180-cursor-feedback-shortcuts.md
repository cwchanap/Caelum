# HPA-180 — Cursor build feedback and shortcut hints — Implementation plan

**Issue:** https://linear.app/cwchanap/issue/HPA-180/show-build-cost-and-shortcuts-at-the-cursor  
**Design:** [2026-10-28-hpa-180-cursor-feedback-shortcuts-design.md](../specs/2026-10-28-hpa-180-cursor-feedback-shortcuts-design.md)  
**PR policy:** **one ticket = one PR**. Continue implementation and review in this draft; do not create a second implementation PR.

## Scope gate and current reuse

Before changing production code, confirm the inspected seams still apply to the implementation base:

- `selectMapTextOverlayItems` derives existing cursor and road-preview labels; `MapTextOverlay.svelte` uses `getBoardTransform` for display; `styles.css` already has `.map-text-item` variants.
- `buildRoadMutationPreview` and runtime generation checking are the authoritative source of road/remove preview results. `roadMutationForUi` currently handles road/remove gestures plus road/roundabout/remove hover, **not track or area**.
- `selectActionFeedback` owns strip precedence; `ShellActionFeedback` has two ephemeral sources to remove.
- `App.svelte` has the real window-keyboard branches; `BuildPanel.svelte` and `CommandShelf.svelte` are the relevant hint surfaces.

If a prior change already delivered a behavior, reuse it and delete the redundant planned edit. No speculative Rust preview expansion solely to satisfy a generic wording in the ticket.

## Step 1 — Consolidate cursor feedback in existing map-text derivation

**Files:** `src/render/mapTextOverlay.ts`, `src/components/MapTextOverlay.svelte`, `src/styles.css`

- Merge the tool badge and road-preview text into one label at `ui.drag.current ?? ui.hoverTile` when there is an eligible generation-matched Rust preview. Prefer one concise warning over concatenating multiple incompatible messages.
- Keep compact cost and route-impact descriptions: single affected line may use its name; multiple lines use counts; broken impacts are more important than reroutes.
- Rejection uses the existing formatted `rejectionMessage` and warning styling. Avoid displaying a valid-looking cost for a rejected mutation.
- Preserve roundabout hover, route waypoint/failure labels, normal tool badges and their tests. Remove the obsolete separately anchored `roadPreview` item/positioning path only if it has no remaining distinct use. Drop the unused `cursorBadge.placement` field in the merged item type and constructors (the DOM overlay already handles the vertical flip).
- Keep DOM overlay noninteractive, clamp/flip text within the board when near an edge, and use a restrained maximum width rather than introducing a tooltip framework. Do not perform a second Rust preview call.

**Unit tests:** update `tests/render/mapTextOverlay.test.ts` and `tests/ui/mapTextOverlay.test.ts` for (a) current-tile anchor and single label, (b) cost/impact, (c) rejected-warning styling, (d) stale/absent preview, and **(e) one horizontal edge-clamp assertion** for the longer label using a controlled board width; preserve the existing vertical flip. Update/remove fixtures asserting the dead `placement` field. Reuse existing fixtures.

## Step 2 — Remove transient feedback-strip duplication

**Files:** `src/runtime/runtimeSelectors.ts`, `src/runtime/types.ts`, dependent feedback tests

- Drop `roadImpact` and `roadRejection` selector branches, plus only their now-unused source types.
- Preserve precedence and semantics of actual gameplay `rejection`, committed `roadDirection`, and `roadHostError`; leave route-editor ownership, dismiss logic and screen-reader announcement untouched.
- Keep existing `buildRoadMutationPreview` generation gating; no second selector for preview prices.

**Tests:** update `tests/runtime/runtimeSelectors.test.ts` and `tests/ui/actionFeedback.test.ts`; assert a preview-only result does **not** generate strip feedback, while committed rejection, direction-change and host error still do.

## Step 3 — Define small shared shortcut constants and hints

**Files:** new `src/ui/shortcuts.ts`, `src/App.svelte`, `src/components/hud/panels/BuildPanel.svelte`, `src/components/hud/CommandShelf.svelte`

- Declare **only chip-bearing key labels** (B/R/T/D/V and road-only 1/2/3, with contextual R rotation) in one module and use the same constants in the corresponding App window-keydown comparisons. Leave Z/Y undo/redo, Delete/Backspace waypoint removal, arrow-key pan, Escape and camera +/-/0 comparisons App-local: this task gives them no new hint surface. Avoid a generic commands/registry/dispatch engine.
- Build B; Road R when no building is armed; Track T; Demolish D; Select V; 1/2/3 road presets only while the road tool is armed; R for Rotate while a building is armed. Display no key chip for unbound Build leaves or the existing Escape/camera navigation keys; those bindings remain supported without refactoring.
- Add small chip and tooltip/accessible text to applicable shelf buttons and Build leaf controls. Clarify the context-sensitive R/1–3 behavior rather than implying impossible actions. Existing Build leaf ordinals are not shortcut keys.
- Keep existing input, modifier, route-draft and map-focus guards exactly as they work today. A shared definition must not accidentally expand where a key fires.

**Tests:** update `tests/ui/buildPanel.test.ts`, shelf/component tests, and relevant `tests/ui/appShell.test.ts` keyboard assertions; verify hints and actual bindings agree in the contextual cases.

## Step 4 — Focused browser journey and review

**Files:** `tests/e2e/commandShelf.spec.ts` and only other impacted E2E tests.

- Replace the existing `roadImpact` strip assertion with one map-local preview assertion at a road hover/drag with cost.
- Exercise a genuine rejected road preview: map warning is visible and the strip remains empty until an actual failed dispatch, which still produces its original dismissible strip feedback.
- Verify the label follows the drag current tile and does not block canvas pointer input. Check a warning at the top/edge of the map for clipping, and one shortcut hint against the actual key behavior.
- Run `bun run check`, `bun run test:unit`, `bun run lint:svelte`, `bun run lint:css`, `bun run format:check`, and focused Playwright `bun run test:e2e` (or the repository's focused command). Report concrete results; CI remains the merge gate.

## Implementation boundaries and review questions

- **Authoritative preview scope:** Rust currently previews road/remove mutations, not track/area. Do not invent their prices in TypeScript or create a generic preview protocol as part of cursor-text work. If full track/area price previews are deemed essential, explicitly revise the scope with evidence before coding instead of sneaking in a new cross-host API.
- **UI ownership:** do not duplicate Road preview results in the shell strip after this change; keep actual rejections and host errors visible.
- **Shortcut context:** R is overloaded with building rotation; 1/2/3 only switch presets in Road mode. Labels must not falsely promise unconditional shortcuts.
- **No follow-up PR:** planning docs and implementation should live in this same PR. Avoid splitting tests or cleanup into a separate task.
- **No new art or SFX** required; if requested later, plan them in a separate ticket.

## Done when

There is one truthful, legible current-tile map label per preview (including horizontal edge handling); committed outcome feedback survives; **chip-bearing** shortcut labels share their actual key constants while unhinted keys stay App-local; UI/browser tests cover the player flow; and the PR includes a short actual validation record. No Rust save/schema/host changes or new frontend architecture.

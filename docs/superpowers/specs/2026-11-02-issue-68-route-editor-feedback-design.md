# Issue #68 — Prevent stale action feedback from covering the route editor — Design

> **Issue:** [Caelum #68](https://github.com/cwchanap/Caelum/issues/68)  
> **Implementation plan:** [2026-11-02-issue-68-route-editor-feedback.md](../plans/2026-11-02-issue-68-route-editor-feedback.md)  
> **PR policy:** Design, implementation, tests, and review live in **one PR**. This initial draft is planning only, not a claim that the fix is shipped.

## Problem and current evidence

Issue #68 reports a rejection toast intercepting the route editor's Cancel/Save interactions. Its 1280×800 headless Chromium measurements place a roughly 254×288 toast at (1009, 412) and the Cancel button at (1003, 564). These are issue-reported coordinates, not a fresh browser run in this planning pass.

Reviewed against `main` at `691cc0b`:

- `src/App.svelte` always renders `ActionFeedback` from `snapshot.shell.actionFeedback`, independently of the Lines panel.
- `src/styles.css` anchors `.action-feedback` at `right: 16px`, `bottom: calc(var(--command-shelf-height) + 8px)`, `z-index: 25`. The `.command-panel` is `z-index: 20`; a tall feedback can therefore intercept pointer events. The 56px feedback slot is not a maximum toast height.
- Between 1200 and 1399px, `.command-panel[data-command-panel="lines"].command-panel--pinned` moves the active editor to the bottom-right, where the toast already sits. Other supported desktop widths use a different panel position.
- `src/runtime/runtimeSelectors.ts::selectActionFeedback` intentionally keeps unrelated `rejection` feedback visible, while editor-owned route errors use the editor. The shared strip can also show `roadDirectionNotice` and road-preview host errors.
- `src/runtime/createGameRuntime.ts::setTool("busRoute" | "metroLine")` starts a new route draft but does not acknowledge an earlier global gameplay rejection/road-direction notice. `openRouteEdit(routeId)` only clears one matching `routeChangedWhileEditing` rejection. This explains the persistence across opening the editor.
- `src/components/hud/panels/RouteEditor.svelte` already has its own preview/error text plus Save/Cancel controls; changing gameplay rejection contracts is unnecessary.

**Verdict:** Still reproducible by code inspection; no existing fix is present on the reviewed main revision. No Rust, persistence, WASM/Tauri, renderer, or schema change is required.

## Player-facing contract

1. Outside a route draft, an actual gameplay rejection or road-direction notice continues to appear in the existing dismissible feedback strip with its current accessible announcement behavior.
2. **Successfully opening** a new Bus or Metro draft, or editing an existing Bus/Metro line, acknowledges and clears *previous* global gameplay rejection and road-direction feedback. The old toast vanishes **before** the route editor becomes actionable, so it cannot cover Save, Cancel, or Reload.
3. Clearing is real runtime state, **not temporary CSS hiding**: Cancel/Save must not resurrect an irrelevant earlier rejection.
4. Only valid transitions clear feedback. Opening the Lines **list**, selecting a different destination without entering a draft, a rejected/busy attempt, and an unknown route ID must not silently erase an existing notice.
5. A route's own preview, missing-node, stale-revision, validation, or save failure remains visible through the editor's existing feedback path. New gameplay failures after leaving the editor retain normal global feedback behavior.
6. Keep the `ActionFeedback` component and stable polite live region mounted; clearing the selected feedback naturally empties its announcement text. Keyboard navigation, focus, and Escape precedence are unchanged.

## Minimal design

**Ownership:** `createGameRuntime.ts` owns the previous-action feedback lifecycle; `App.svelte` and `ActionFeedback.svelte` remain dumb renderers. No new prop, global store, toast timer, layout observer, or generic notification manager.

- In `setTool`, once the existing dead/busy/active-draft guards have passed and a Bus/Metro draft is actually being created, set private `rejection = null` and `next.roadDirectionNotice = null` before publishing the new UI. Do not change the cleanup behavior of other tools.
- In `openRouteEdit`, resolve the target Bus/Metro line and pass the busy guard **first**. When the edit draft will open, clear the previous `rejection` (superseding the narrower same-route stale-revision special case) and put `roadDirectionNotice: null` in the new immutable UI. Keep preview invalidation, route-editor construction, selection, and queued preview behavior unchanged.
- Reuse existing `invalidateRoadPreview` and `roadMutationPreviewError: null` on draft entry to dispose of stale road-host preview errors; do not introduce a second cleanup mechanism.
- Do **not** clear `routePreviewError` produced later by the active route editor. The existing selector already routes editor-owned rejection to local guidance.

This is the issue's suggested **auto-dismiss on editor entry** option. Moving the feedback by breakpoint is brittle across 1024/1280/1440 desktop layouts, reducing its z-index makes the text disappear behind the editor, and clipping to the nominal feedback slot truncates potentially useful diagnostics. None is needed for stale feedback from the workflow being left.

## Acceptance and regression scope

- From an actual failed placement, open Lines, then New Bus. Confirm the rejection is visible **before** entry and absent after draft entry; click Cancel with a real Playwright pointer click and verify the draft closes. Test at 1280×800, the reported overlap width.
- Runtime cases: Bus draft, Metro draft, existing-line edit; clear global rejection and road-direction notice only on successful entry. Cover no-op/unknown-route and guard cases without clearing. After Cancel, old notice stays gone; later genuine rejections still surface.
- Do not break route-local preview/rejection messages. Preserve the dismiss button and stable live-region test for feedback outside a draft.
- Existing 1024×768 and 1440×900 desktop layout tests remain green; add viewport variants only if the primary pointer test reveals another layout issue.

**Not doing:** CSS breakpoint offset tables; z-index escalation; click-through overlays; timeouts; dismissal on merely opening Lines; backend/rejection-code changes; migration/backward compatibility; new image art or SFX. Keep the implementation and tests on this same PR.

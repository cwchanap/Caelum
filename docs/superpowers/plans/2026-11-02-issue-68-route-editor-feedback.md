# Issue #68 — Route-editor feedback overlap — Implementation plan

> **Design:** [2026-11-02-issue-68-route-editor-feedback-design.md](../specs/2026-11-02-issue-68-route-editor-feedback-design.md)  
> **GitHub issue:** [#68 — Rejection toast can overlap route-editor action buttons](https://github.com/cwchanap/Caelum/issues/68)  
> **PR policy:** Implement, test, review, and merge in **this one draft PR**. No separate implementation PR.

## Outcome and constraints

Starting a **valid** new Bus/Metro route draft or editing an existing route dismisses feedback from the *previous* gameplay interaction, before the editor is shown. The Cancel/Save buttons cannot be covered by that old toast, and Cancel does not revive it. A new route-specific error still uses the existing local editor preview/rejection path.

The issue was verified by reading current `main` (`691cc0b`). `.action-feedback` is absolutely positioned at bottom-right with `z-index: 25`; the Lines panel sits at `z-index: 20` and is pinned right at 1200–1399px. Current draft-entry methods retain unrelated private `rejection` and `ui.roadDirectionNotice`. No engine or host change is justified.

## 1. Reproduce with focused runtime tests first

**Edit:** `tests/runtime/gameRuntime.test.ts` and, if the existing fixture is easier, `tests/runtime/roadDirectionFeedback.test.ts`.

- Seed an actual rejected dispatch through the existing fake backend (its `rejectNextDispatch` and `TEST_REJECTION` helpers); assert `getSnapshot().shell.actionFeedback?.source === "rejection"` before navigating.
- Open a new Bus draft with `setTool("busRoute")`. Assert the route draft exists, `ui.activeCommandDestination === "lines"`, `snapshot.rejection === null` and `shell.actionFeedback === null`. Cancel it and verify the old error stays gone.
- Cover new Metro draft and `startRouteEdit("route-001")` using existing route fixtures. Keep this small (table or focused assertions); the code paths share the same contract.
- Reuse existing road-direction notice setup to prove an earlier notice also clears when the draft opens. Do not mock the feedback component's behavior as a substitute for runtime assertions.
- Assert an **unknown route ID** and existing busy/active-draft guards do **not** clear an unrelated error or mutate the UI. Existing guard coverage can be extended rather than duplicated.
- Preserve the route-local `routePreviewError` / `routePreviewHostError` test cases, especially `routeChangedWhileEditing` Save/Cancel/Reload. New rejections after leaving the editor must still show normally.

Run these tests **before production edits** to confirm they fail for the missing dismissal.

## 2. Implement the minimal runtime feedback handoff

**Edit:** `src/runtime/createGameRuntime.ts` only.

1. In `setTool(tool)`, retain existing dead/busy/active-draft guards, route preview invalidation, and `nextToolUiState` construction. Inside the branch that **actually creates** a Bus/Metro draft, clear the existing private `rejection` and set `next.roadDirectionNotice = null` alongside the existing route-draft fields. Do not dismiss feedback on a generic tool change or `setCommandDestination("lines")`.
2. In `openRouteEdit(routeId)`, keep the busy check and Bus/Metro lookup before mutating feedback. Once an existing route is found, clear `rejection` unconditionally, replacing the special-case same-route `routeChangedWhileEditing` cleanup. Add `roadDirectionNotice: null` to the immutable UI passed to `commit`. Keep all existing preview, route draft generation, pinned Lines, selection, and focus behavior.
3. Reuse the existing `invalidateRoadPreview` and cleared `roadMutationPreviewError` on edit entry. Do not change `selectActionFeedback`, `ActionFeedback.svelte`, the route editor, or the gameplay rejection contract.

**Review focus:** Clearing must happen only on a successful transition; the editor's own *later* validation and save errors are not dropped. No extra subscriber publish, UI state owner, timer, or route editor CSS is needed.

## 3. Add a real browser pointer regression

**Edit:** `tests/e2e/commandShelf.spec.ts`.

Add one focused Playwright case adjacent to the existing action-feedback and pinned Lines tests:

1. Use the current `createDefaultCity` and `selectBuildLeaf` / `clickMapTile` helpers to cause a real failed placement (a Bus Stop without road access, or a zero-budget build). Assert `[data-testid="action-feedback"]` is visible and the runtime reports a genuine rejection **before** opening the route editor.
2. At **1280×800**, open Lines → New Bus. Assert `[data-testid="route-draft"]` is visible, the stale `action-feedback` is absent, and the editor's `Cancel` button accepts a **normal pointer click** (not `force: true`).
3. Assert the editor closes and the old feedback does not return. Reopen another draft and verify the normal Save/Cancel control remains available; do not add an artificial CSS-only test fixture.
4. Keep existing feedback-dismiss/live-region tests green. The feedback component still stays mounted even when no visible toast exists.

If this test exposes a second issue at the minimum desktop width, parameterize the same regression for **1024×768** and/or **1440×900**; avoid a large viewport/error-type matrix up front.

## 4. Verification and completion

Run from the repository root after the implementation is added to **this PR**:

```sh
bunx vitest run tests/runtime/gameRuntime.test.ts tests/runtime/roadDirectionFeedback.test.ts
bun run check
bun run test:unit
bun run lint:svelte
bun run lint:css
bun run format:check
bun run wasm:build:release  # only if the ignored local browser/WASM output is missing/stale
bunx playwright test tests/e2e/commandShelf.spec.ts
```

The Rust/core and Tauri surfaces are unchanged, so no additional Rust-specific test matrix is necessary for this UI-lifecycle-only fix. Hosted CI remains the merge gate. Verify the PR's base has not drifted before moving it out of draft.

### Done when

- [ ] Existing gameplay rejection or road-direction feedback disappears on valid new Bus and Metro draft entry.
- [ ] The same behavior applies when editing an existing Bus/Metro line.
- [ ] Invalid, blocked, or list-only navigation does not erase feedback.
- [ ] Old feedback does not return on Cancel; current route preview/save errors remain visible in the editor.
- [ ] At the 1280×800 reproduction viewport, physical pointer click on Cancel works after a prior rejection.
- [ ] Existing accessible feedback and focused frontend/Playwright checks pass.
- [ ] Implementation and tests remain on **this same PR**; update PR body to reference `Fixes #68` only once the fix is implemented.

**Explicitly deferred:** toast repositioning by viewport, changes to stack ordering/other HUD panels, new animations, timers, global notification infrastructure, backend changes, migrations, new art/SFX, and a second PR.

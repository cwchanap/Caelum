# Issue #68 — Prevent stale action feedback from covering the route editor — Design

> **Issue:** [Caelum #68](https://github.com/cwchanap/Caelum/issues/68)  
> **Implementation plan:** [2026-11-02-issue-68-route-editor-feedback.md](../plans/2026-11-02-issue-68-route-editor-feedback.md)  
> **Reviews:** [Initial design review](https://github.com/cwchanap/Caelum/pull/77#issuecomment-6597186117) and [follow-up review (delayed dispatch and obsolete test)](https://github.com/cwchanap/Caelum/pull/77#pullrequestreview-5748520001)  
> **PR policy:** Design, implementation, tests and review stay in **one PR**. This draft currently contains planning only.

## Problem and corrected evidence

Issue #68 was filed on 2026-10-23, before later action-feedback styling changes. Its reported **254×288** rejection toast overlapping the editor's Cancel button no longer describes the **single-line placement rejection** on current `main` (`691cc0b`). The PR reviewer measured the following in headless Chromium using a real Bus Stop/no-road-access rejection and the current UI/CSS:

| Viewport | Single-line toast | Panel bottom edge | Buttons covered |
| --- | --- | --- | --- |
| 1024×768 | 323×70, top y=598 | y=604 | 0 |
| 1280×800 | 323×70, top y=630 | y=636 (pinned editor) | 0 of 12 editor buttons |
| 1440×900 | 323×70, top y=730 | y=736 | 0 |

These are **reviewer-reported measurements**, not new browser executions for this documentation revision. `.command-panel` reserves `--feedback-slot-height: 56px` plus margin below its bottom edge. The current 70px single-line toast therefore does **not** intercept an editor button center at the reviewed widths. The original one-line Playwright reproduction would pass without a fix and must not be used as a regression test.

**Remaining overlap:** the feedback can grow taller than its reserved slot. At **1280×800**, the reviewer appended detail rows to the live `action-feedback-details` element (real CSS, **not** a real four-route gameplay setup):

- Three detail rows: 108px tall; no covered editor controls.
- **Four detail rows: 126px tall; Save & run and Cancel are covered** in the right-pinned Lines editor.
- Eight detail rows also obstruct a Build panel button.

A real `roadDirectionNotice` renders one detail line per previously connected route newly broken by a road direction change (`src/runtime/createGameRuntime.ts::commitDispatchResult` and `src/runtime/runtimeSelectors.ts::selectActionFeedback`). Thus **a direction change that breaks four or more routes** provides a plausible remaining gameplay path to the overlapping multi-line feedback. We do not claim the four-route world setup was executed.

## Why it happens

- `src/App.svelte` renders `ActionFeedback` from `snapshot.shell.actionFeedback` independently of the Lines editor.
- `src/styles.css` places `.action-feedback` bottom-right (`right: 16px`; `bottom: calc(var(--command-shelf-height) + 8px)`) at `z-index: 25`, above `.command-panel` at `z-index: 20`. At 1200–1399px, a draft pins the Lines editor to the right.
- `setTool("busRoute" | "metroLine")` creates a draft without clearing the previous global `rejection` or `ui.roadDirectionNotice`. `openRouteEdit(routeId)` clears only a same-route `routeChangedWhileEditing` rejection.
- Opening the Lines list **does not** replace these notices; `RouteEditor.svelte` already supplies its own route-specific feedback once a draft is active.
- **There is also a delayed-reply path:** `dispatchNow` awaits the backend and then resolves its `nextUi` against the *current* `ui`. `commitDispatchResult` currently constructs a `cycleRoadDirection` notice even when that `nextUi.routeDraft` is active. A road click already in flight can therefore repopulate a notice **after** draft entry; road-preview invalidation does not cancel a gameplay dispatch. The follow-up reviewer reproduced this timing using the production runtime plus an in-memory delayed backend (not a fresh browser/four-route game setup).

**Verdict:** The original *short-rejection* obstruction has already been fixed by the current layout, but the *multi-line notification* overlap still needs a minimal runtime lifecycle handoff. No Rust, persistence, WASM/Tauri, renderer, or save-schema work is needed.

## Player-facing contract

1. Outside a route draft, genuine gameplay rejection and road-direction feedback retain their current visible, dismissible and accessible behavior.
2. On a **valid transition into** a new Bus/Metro route draft or an existing Bus/Metro line edit, acknowledge the *previous* global gameplay rejection and road-direction notice **before** committing the draft UI. This removes the stale toast and avoids an obstruction of Save, Cancel and Reload. A **road-direction dispatch that finishes after entry** must likewise leave the active editor free of that global notice while still committing its gameplay update normally.
3. Clearing is **runtime state**, not temporary CSS hiding. Cancel/Save do not resurrect the earlier notice.
4. Opening the Lines **list** or an unrelated panel does **not** dismiss the notice; nor do an unknown edit ID or a blocked transition. The existing guards and route lookup already enforce this.
5. Subsequent route-local preview, revision, missing-node and save errors continue to appear in the editor using its existing feedback pathway. New gameplay failures after leaving the editor remain actionable.
6. Keep the existing feedback component and its stable polite live region mounted; preserve current Escape and focus behavior.

## Narrow implementation

**One owner:** `src/runtime/createGameRuntime.ts`. Keep `App.svelte`, `ActionFeedback.svelte`, the selector and CSS unchanged.

- In `setTool`, after the current dead/busy/active-draft guards, **only inside** the Bus/Metro draft creation branch, set `rejection = null` and `next.roadDirectionNotice = null`. Retain existing preview invalidation and `commitWithRoadPreview`.
- In `openRouteEdit(routeId)`, keep the busy and route-existence checks before mutation. On a successful lookup, replace the special-case same-route stale rejection cleanup with unconditional `rejection = null`, and add `roadDirectionNotice: null` to the immutable `commit` UI. Preserve route-draft initialization, preview request and pinned Lines behavior.
- In the existing `commitDispatchResult` notice construction, require **`nextUi.routeDraft === null`** in addition to the current accepted `cycleRoadDirection` predicate. For an already-open route editor, still apply and publish the actual gameplay update (including any resulting route changes); suppress only the obsolete global road-direction message. This guards the backend/IPC completion boundary without adding queues, generation tokens or new state.
- Because `reloadRouteDraft` already calls `openRouteEdit` for a valid route, remove its now-duplicated `if (globalStale) rejection = null;`; retain the `globalStale` predicate for its own early-return guard. An invalid/missing edit route does not trigger the draft-entry dismissal contract.
- Reuse existing `invalidateRoadPreview` and `roadMutationPreviewError: null` for stale road-preview host feedback. Do not add new state or a second dismissal mechanism.

This is the issue's suggested **dismiss on entering the editor** solution. Do **not** change stacking order, clip detail text, add a toast timeout or build CSS breakpoint offset tables. Those are unnecessary for this handoff.

## Focused acceptance

- **Runtime test 1:** **Replace** the existing `gameRuntime.test.ts` test named `Cancel preserves an unrelated earlier rejection` with one parameterized test for New Bus, New Metro and editing an existing route. Seed prior feedback (actual rejection and, using existing fixtures, a road-direction notice); verify entry clears both underlying feedback and `shell.actionFeedback`, and Cancel does not resurrect it. Do not leave the obsolete opposite assertion in place.
- **Runtime test 2:** A prior notice is **preserved** by `setCommandDestination("lines")` without entering a draft.
- **Runtime test 3:** Use the existing deferred-backend pattern to leave a road-direction dispatch in flight, open a Bus route draft, release an accepted result, and verify the draft stays active, the gameplay update is accepted, and `shell.actionFeedback` stays absent. A four-route map fixture is not needed to exercise the completion-time suppression.
- Existing route-preview/save rejection, Reload/Cancel, feedback announcement, and command-layout tests continue to pass. Do not replicate existing busy/unknown-route guards in a test matrix.
- **No new E2E:** the old one-line reproduction is already green on `main`; an authentic multi-route browser setup would add substantial fixture cost for a small runtime-state contract.

**Explicitly deferred:** If an **eight-or-more-detail** toast starts blocking the Build panel, consider a separate targeted CSS height/scroll limit only when demonstrated with real gameplay. No new image art or SFX; no additional implementation PR.

# Issue #68 — Route-editor feedback overlap — Implementation plan

> **Design:** [2026-11-02-issue-68-route-editor-feedback-design.md](../specs/2026-11-02-issue-68-route-editor-feedback-design.md)  
> **GitHub issue:** [#68](https://github.com/cwchanap/Caelum/issues/68)  
> **Review disposition:** [PR #77 design review](https://github.com/cwchanap/Caelum/pull/77#issuecomment-6597186117) — all three actionable points incorporated.  
> **PR policy:** Implement, test and review in **this one draft PR**. Do not open a separate implementation PR.

## Scope and corrected reproduction

The current `main` (`691cc0b`) already keeps an ordinary **single-line** placement rejection below the editor buttons. The earlier issue's 254×288 dimensions are obsolete: the reviewer measured a current 323×70 rejection toast with **zero covered buttons** at 1024×768, 1280×800 and 1440×900.

The remaining obstruction is a **tall, multi-line notice**. At 1280×800 the reviewer tested real CSS with injected detail rows and observed that **four** broken-route-style detail rows grow the toast to 126px and obstruct the pinned editor's Save/Cancel buttons. A real committed road direction change emits one detail per newly broken route; the review did **not** build four broken routes to reproduce it end to end.

**Goal:** When a valid Bus/Metro draft or existing-line edit opens, clear previous gameplay rejection and road-direction notice in the existing runtime. Do not dismiss on merely opening Lines. Route-specific feedback stays in the editor. No CSS, engine, host, schema, timer, or notification manager changes.

## 1. Two focused runtime tests — write before implementation

**File:** `tests/runtime/gameRuntime.test.ts`, reusing its `backendSpy`/`rejectNextDispatch` and route fixtures; `tests/runtime/roadDirectionFeedback.test.ts` already has real-core helpers for `roadDirectionNotice` if needed.

1. **Valid entry table:** one parameterized `it.each` covering `setTool("busRoute")`, `setTool("metroLine")` and `startRouteEdit("route-001")`. Produce prior visible feedback before each transition, covering both global `rejection` and `roadDirectionNotice` over the three rows with the cheapest existing fixtures. Assert the notice exists before entry; then assert the new `ui.routeDraft` is active in Lines and `shell.actionFeedback === null`. Call `cancelRouteDraft()` and assert it stays cleared.
2. **Representative non-entry:** produce a prior notice, call `setCommandDestination("lines")` without entering the editor, and assert `shell.actionFeedback` remains present.

These must demonstrate failure against the **current pre-fix** runtime state (the stale feedback survives valid draft entry). Do **not** add separate tests for unknown IDs, busy state or an already active draft: those pre-existing guards return before the changed lines. Existing `routeChangedWhileEditing` Save/Cancel/Reload coverage stays green; don't duplicate it.

## 2. Small production change in the runtime

**File:** `src/runtime/createGameRuntime.ts` only.

1. `setTool(tool)`: keep all existing guard, road-preview invalidation and next-UI logic. Inside `if (tool === "busRoute" || tool === "metroLine")`, after valid draft creation, add `rejection = null` and `next.roadDirectionNotice = null`. Commit the existing next UI as before.
2. `openRouteEdit(routeId)`: keep the busy guard and both route/line lookups; do nothing if no matching line exists. After successful lookup, replace the narrow `routeChangedWhileEditing` check with `rejection = null` and include `roadDirectionNotice: null` in its current immutable UI object. Keep draft generation, `invalidateRoadPreview`, `requestRoutePreview`, focus and selection behavior unchanged.
3. `reloadRouteDraft()`: remove the redundant `if (globalStale) rejection = null;` statement, since a successful `openRouteEdit` now clears it. **Keep** `globalStale` and `localStale` in the guard: both still determine whether Reload is actionable. A missing route that fails lookup must not silently dismiss prior feedback.

Do not touch `ActionFeedback.svelte`, `App.svelte`, `runtimeSelectors.ts`, `styles.css`, `RouteEditor.svelte` or gameplay/WASM/Tauri code.

**Review focus:** Clearing happens only when the editor truly opens; Cancel does not restore previous notices. Editor-owned preview and save errors still render through the existing `routePreviewError`/`routePreviewHostError` path.

## 3. Verification on this same PR

Run from the repository root after adding the implementation:

```sh
bunx vitest run tests/runtime/gameRuntime.test.ts tests/runtime/roadDirectionFeedback.test.ts
bun run check
bun run lint
bun run format:check
```

Let repository CI execute its normal remaining checks, including Playwright. No new browser fixture is justified: a one-line error test already passes without a fix, while creating four actually broken services just to test this lifecycle handoff is disproportionate. There is no manual WASM rebuild step in this plan; the standard scripts handle their prerequisites.

## Done when

- [ ] One parameterized runtime test checks New Bus, New Metro and existing-line edit, with previous feedback cleared on valid entry and still gone after Cancel.
- [ ] One runtime test ensures opening the Lines **list** does not clear the previous notice.
- [ ] `setTool` and `openRouteEdit` clear stale `rejection` and `roadDirectionNotice` at the validated draft-entry boundary.
- [ ] `reloadRouteDraft` has no duplicate rejection-clear branch, while retaining its stale-error guard.
- [ ] Existing editor-local error / Reload semantics and feedback accessibility remain intact.
- [ ] Focused tests, type check, lint and format checks pass; this PR remains the sole implementation PR.
- [ ] Replace `Tracks #68` with `Fixes #68` in the PR body **only after the actual fix** is committed and verified.

**Deferred:** Toast overflow over Build controls from very large detail lists (e.g. eight rows) can be handled separately if observed in real gameplay. No speculative CSS fallback, viewport test matrix, new image art/SFX, general notification architecture, or duplicate implementation PR.

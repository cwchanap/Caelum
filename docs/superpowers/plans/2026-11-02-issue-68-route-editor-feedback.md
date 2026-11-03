# Issue #68 — Route-editor feedback overlap — Implementation plan

> **Design:** [2026-11-02-issue-68-route-editor-feedback-design.md](../specs/2026-11-02-issue-68-route-editor-feedback-design.md)  
> **GitHub issue:** [#68](https://github.com/cwchanap/Caelum/issues/68)  
> **Review disposition:** [Initial design review](https://github.com/cwchanap/Caelum/pull/77#issuecomment-6597186117) and [follow-up review](https://github.com/cwchanap/Caelum/pull/77#pullrequestreview-5748520001) — findings from both incorporated.  
> **PR policy:** Implement, test and review in **this one draft PR**. Do not open a separate implementation PR.

## Scope and corrected reproduction

The current `main` (`691cc0b`) already keeps an ordinary **single-line** placement rejection below the editor buttons. The earlier issue's 254×288 dimensions are obsolete: the reviewer measured a current 323×70 rejection toast with **zero covered buttons** at 1024×768, 1280×800 and 1440×900.

The remaining obstruction is a **tall, multi-line notice**. At 1280×800 the reviewer tested real CSS with injected detail rows and observed that **four** broken-route-style detail rows grow the toast to 126px and obstruct the pinned editor's Save/Cancel buttons. A real committed road direction change emits one detail per newly broken route; the review did **not** build four broken routes to reproduce it end to end.

**Goal:** When a valid Bus/Metro draft or existing-line edit opens, clear previous gameplay rejection and road-direction notice in the existing runtime; also **suppress a road-direction notice returned by a gameplay dispatch already in flight** while that draft is open. The gameplay result must still apply. Do not dismiss on merely opening Lines. Route-specific feedback stays in the editor. No CSS, engine, host, schema, timer, or notification manager changes.

## 1. Three focused runtime regressions — write before implementation

**File:** `tests/runtime/gameRuntime.test.ts`, reusing `backendSpy` / `rejectNextDispatch`, route fixtures and `deferredDispatchBackend`. `tests/runtime/roadDirectionFeedback.test.ts` already has real-core notice setup if that is cheaper than new fixture code.

1. **Replace the obsolete Cancel contract:** At approximately line 5127, the existing `it("Cancel preserves an unrelated earlier rejection", …)` demands the **opposite** of the new behavior and would fail for the right reason. **Replace or parameterize that exact test**, rather than leaving it or adding a duplicate. Cover `setTool("busRoute")`, `setTool("metroLine")` and `startRouteEdit("route-001")` in one `it.each`. Before entry, seed a visible previous rejection/road-direction notice with existing helpers (both feedback types need coverage but not a Cartesian matrix). After entry, assert `ui.routeDraft` exists in Lines, `rejection === null`, `ui.roadDirectionNotice === null` and `shell.actionFeedback === null`; after Cancel all remain cleared.
2. **Representative non-entry:** with feedback visible, call `setCommandDestination("lines")` without starting a draft. Assert `shell.actionFeedback` persists, because list navigation is not an acknowledgement.
3. **Delayed road-direction reply:** reuse `deferredDispatchBackend` and its `resolveNext()` helper (around line 923). Start a direction-changing gameplay dispatch and leave the backend reply pending; open a Bus draft **before** resolving it. Then release an **applied** result representing a direction change that breaks a route (a small typed mock is enough; do not create a four-route real-core fixture). Assert the current draft remains active, the real gameplay result updates state, and `ui.roadDirectionNotice`/`shell.actionFeedback` are **still null** after completion. This test should fail on pre-fix `commitDispatchResult` even if entry-clearing code is already in place.

Do not duplicate existing busy/unknown-ID/active-draft guard tests; those return before the modified lines. Keep existing editor-owned `routeChangedWhileEditing` Save/Cancel/Reload tests, including the distinct `Cancel clears a current create-route Save rejection owned by the editor`, unchanged.

## 2. Small production change in the runtime

**File:** `src/runtime/createGameRuntime.ts` only.

1. `setTool(tool)`: keep all existing guard, road-preview invalidation and next-UI logic. Inside `if (tool === "busRoute" || tool === "metroLine")`, after valid draft creation, add `rejection = null` and `next.roadDirectionNotice = null`. Commit the existing next UI as before.
2. `openRouteEdit(routeId)`: keep the busy guard and both route/line lookups; do nothing if no matching line exists. After successful lookup, replace the narrow `routeChangedWhileEditing` check with `rejection = null` and include `roadDirectionNotice: null` in its current immutable UI object. Keep draft generation, `invalidateRoadPreview`, `requestRoutePreview`, focus and selection behavior unchanged.
3. `reloadRouteDraft()`: remove the redundant `if (globalStale) rejection = null;` statement, since a successful `openRouteEdit` now clears it. **Keep** `globalStale` and `localStale` in the guard: both still determine whether Reload is actionable. A missing route that fails lookup must not silently dismiss prior feedback.
4. `commitDispatchResult(result, nextUi, intent)`: in the existing `notice` construction predicate require `nextUi.routeDraft === null` alongside `result.applied && intent.type === "cycleRoadDirection"`. This is **completion-time** suppression of the stale road-direction banner, not cancellation of the already-accepted gameplay update; `commit(nextState, nextUi)` still proceeds normally. `dispatchNow` already resolves the current `ui` after awaiting the backend, so no new epoch, lock or queue layer is needed. Do **not** suppress editor-local route save errors.

Do not touch `ActionFeedback.svelte`, `App.svelte`, `runtimeSelectors.ts`, `styles.css`, `RouteEditor.svelte` or gameplay/WASM/Tauri code.

**Review focus:** Clearing happens only when the editor truly opens; Cancel does not restore previous notices. A previously enqueued road-direction operation can still update the world but cannot reintroduce its notice while the editor is open. Editor-owned preview and save errors still render through the existing `routePreviewError`/`routePreviewHostError` path.

## 3. Verification on this same PR

Run from the repository root after adding the implementation:

```sh
bun run test -- tests/runtime/gameRuntime.test.ts tests/runtime/roadDirectionFeedback.test.ts
bun run check
bun run lint
bun run format:check
```

Use `bun run test -- …` instead of calling `bunx vitest` directly so that the repo's `pretest` script runs `ensure-wasm`. Let normal CI execute its remaining checks, including Playwright. No new browser fixture is justified: a one-line error test already passes without a fix, while creating four actually broken services to test this lifecycle handoff is disproportionate. No manual WASM rebuild is required.

## Done when

- [ ] Replace the obsolete `Cancel preserves an unrelated earlier rejection` test with a parameterized runtime entry-and-Cancel test for New Bus, New Metro and existing-line edit.
- [ ] One runtime test ensures opening the Lines **list** does not clear the previous notice.
- [ ] One delayed-dispatch test proves a road-direction reply accepted **after** draft entry cannot repopulate the banner and still updates gameplay state.
- [ ] `setTool` and `openRouteEdit` clear stale `rejection` and `roadDirectionNotice` at the validated draft-entry boundary.
- [ ] `commitDispatchResult` suppresses road-direction **notices** while `nextUi.routeDraft !== null`, not the gameplay update.
- [ ] `reloadRouteDraft` has no duplicate rejection-clear branch, while retaining its stale-error guard.
- [ ] Existing editor-local error / Reload semantics and feedback accessibility remain intact.
- [ ] Focused tests, type check, lint and format checks pass; this PR remains the sole implementation PR.
- [ ] Replace `Tracks #68` with `Fixes #68` in the PR body **only after the actual fix** is committed and verified.

**Deferred:** Toast overflow over Build controls from very large detail lists (e.g. eight rows) can be handled separately if observed in real gameplay. No speculative CSS fallback, viewport test matrix, new image art/SFX, general notification architecture, or duplicate implementation PR.

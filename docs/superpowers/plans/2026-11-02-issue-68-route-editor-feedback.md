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

**Files:** `src/runtime/createGameRuntime.ts` and `src/runtime/runtimeSelectors.ts`. (The follow-up review superseded the earlier "runtime only" boundary: it asked for the no-feedback-over-a-draft rule to live once in the selectors rather than be repeated at every entry point.)

1. `selectShellState` gates `shell.actionFeedback` on `draftActive` — one place for the "no gameplay feedback over an open draft" rule. Feedback that lands while a draft is open is recorded (`rejection`, `ui.roadDirectionNotice`, `ui.roadMutationPreviewError`) but deferred; it surfaces when the draft closes. The now-dead `editorOwnsRejection` path was removed.
2. `clearGameplayFeedback(nextUi)` retires the pending rejection and road-direction notice together; `setTool`, `openRouteEdit` and `dismissRejection` share it so the clearing logic cannot drift. Clearing still happens only when a valid draft actually opens — opening the Lines list alone is not an acknowledgement.
3. `commitDispatchResult` records the road-direction notice unconditionally (no `routeDraft` gate) so a late `cycleRoadDirection` result's broken-route detail is not lost; the selector keeps it hidden until the draft closes. While the strip is hidden, a later non-cycle result no longer clears the recorded notice, and `dispatchNow` likewise keeps a hidden `rejection` on unrelated successes (e.g. `setSpeed`, `setPaused`) — deferred feedback genuinely surfaces on close instead of being silently discarded first. A successful Save retires only a rejection the editor owned (`isEditorOwnedRejection`, shared with `cancelRouteDraft`); unrelated deferred feedback is preserved. The gameplay update still applies.
4. `commitDispatchResult` also re-requests the open draft's preview when a scene-carrying dispatch lands (excluding the frame-only intents `setPaused`/`setSpeed`/`setBudget`, which cannot change what a preview reads). The refresh clears the held preview together with setting `previewPending` — a preview accepted against the pre-change world cannot keep `canSave` armed while "Checking route…" shows, so Save cannot submit a stale `expectedRevision`. A queued direction change that re-broke the edited route surfaces `routeChangedWhileEditing` in-editor (Reload enabled, Save disabled); a deleted route surfaces `routeNotFound`. The superseded-save path now relies on this generic refresh.
5. `reloadRouteDraft()` honours all three places `selectRouteEditorView`'s `canReload` reads a `routeChangedWhileEditing` rejection (global `rejection`, `ui.routePreviewError`, `draft.preview.rejection`) — previously a preview-only stale flag enabled Reload but the guard ignored it and the click did nothing. When the edited route no longer exists, Reload retires that route's matching stale markers instead of staying enabled forever; unrelated feedback is preserved. A missing route still does not clear unrelated feedback.

Do not touch `ActionFeedback.svelte`, `App.svelte`, `styles.css`, `RouteEditor.svelte` or gameplay/WASM/Tauri code.

**Review focus:** Clearing happens only when the editor truly opens; Cancel does not restore earlier feedback because entry clearing already retired it, while feedback that lands *during* the draft is deferred rather than re-shown over the editor. A previously enqueued road-direction operation still updates the world, keeps its notice recorded for after the draft closes, and refreshes the open draft's preview. Editor-owned preview and save errors still render through the existing `routePreviewError`/`routePreviewHostError` path.

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

- [x] Replace the obsolete `Cancel preserves an unrelated earlier rejection` test with a parameterized runtime entry-and-Cancel test for New Bus, New Metro and existing-line edit — each row asserting `shell.actionFeedback?.source` for its seeded feedback type.
- [x] One runtime test ensures opening the Lines **list** does not clear the previous notice.
- [x] One delayed-dispatch test proves a road-direction reply accepted **after** draft entry stays hidden while the draft is open, still updates gameplay state, and surfaces after Cancel.
- [x] A delayed rejection landing after draft entry is deferred likewise (hidden while open, shown on close).
- [x] A scene-carrying dispatch lands while a draft is open re-requests the draft preview so a bumped revision surfaces `routeChangedWhileEditing` in-editor.
- [x] `setTool`, `openRouteEdit` and `dismissRejection` clear stale `rejection` and `roadDirectionNotice` through one shared helper at the validated boundary.
- [x] `commitDispatchResult` records road-direction notices unconditionally and refreshes an open draft's preview on scene-carrying dispatches (frame-only intents excluded) — never suppressing the gameplay update itself.
- [x] `selectShellState` holds the single "no gameplay feedback over an open draft" rule via `draftActive`; `editorOwnsRejection` removed.
- [x] `reloadRouteDraft` honours all three stale-rejection sources (`rejection`, `routePreviewError`, `draft.preview.rejection`) and retires matching markers when the edited route is gone, so Reload can no longer be enabled-but-inert.
- [x] Deferred feedback survives an intervening successful `setSpeed`/`togglePause` while hidden — both delayed-feedback regressions assert it still surfaces after Cancel.
- [x] The scene-triggered preview refresh clears the held preview, so `canSave === false` while "Checking route…" is in flight (asserted before the replacement resolves).
- [x] Existing editor-local error / Reload semantics and feedback accessibility remain intact.
- [x] Focused tests, type check, lint and format checks pass; this PR remains the sole implementation PR.
- [ ] Replace `Tracks #68` with `Fixes #68` in the PR body **only after the actual fix** is committed and verified.

**Deferred:** Toast overflow over Build controls from very large detail lists (e.g. eight rows) can be handled separately if observed in real gameplay. No speculative CSS fallback, viewport test matrix, new image art/SFX, general notification architecture, or duplicate implementation PR.

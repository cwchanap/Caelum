# Route Editing Frontend and Presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose roadside stop access and typed route failures in the UI while adding generation-safe route-draft duplicate suppression, undo/redo, shortcuts, shared hit testing, and actionable guidance.

**Architecture:** Execute `docs/superpowers/plans/2026-07-22-roadside-stop-core-routing.md` first. TypeScript structurally mirrors Rust wire types, while `createGameRuntime` owns immutable draft history and preview generation. Reducers remain pure; selectors derive one typed failure/guidance view used by RouteEditor, ManagePanel, and canvas overlays.

**Tech Stack:** TypeScript, Svelte 5 runes, Bun, Vitest (`ui`/`runtime` projects), Canvas 2D, Playwright, WASM/Tauri backend adapters.

## Global Constraints

- Rust is authoritative for stop access, routing, path steps, failure reasons, and gameplay rejections.
- Keep `SNAPSHOT_SCHEMA_VERSION = 2`; normalize omitted Rust `Option` fields to nullable/optional TS values.
- `Stop.position` is the passenger/render anchor; `Stop.roadAccess.roadPoint` is the bus road coordinate.
- Svelte renders runtime snapshots and emits intents; it never owns gameplay state.
- Duplicate no-ops must preserve draft identity, generation, history, and backend preview count.
- Selection-only changes never create history entries.
- Undo/redo restores only topology checkpoints, increments generation, clears preview, and requests a fresh Rust preview.
- Keyboard shortcuts never steal native behavior from focused inputs/textareas.
- Right-click undo applies only while a route draft is active and suppresses the browser menu only then.
- Preserve the established HUD visual language; no unrelated redesign.

---

## File Map

- Modify `src/domain/types.ts`: stop access/failure wire types.
- Modify `src/runtime/backend/types.ts`, `shared.ts`, `wasmBackend.ts`, `tauriBackend.ts`: normalize wire fields and expose non-initial snapshot load boundary if consumed.
- Modify `src/runtime/snapshotView.ts`: default optional wire fields without deriving gameplay access in TS.
- Modify `src/render/placementValidation.ts`: roadside stop hover rule.
- Modify `src/render/transitRenderer.ts`, `overlayRenderer.ts`: access indicator and typed route guidance.
- Modify `src/ui/routeDraft.ts`: pure mutation result and duplicate behavior.
- Modify `src/ui/uiState.ts`: history/notice state.
- Modify `src/runtime/createGameRuntime.ts`: sole history owner; undo/redo; preview scheduling.
- Modify `src/runtime/types.ts`, `runtimeSelectors.ts`: controller/view types, typed failures.
- Modify `src/App.svelte`, `createCanvasHost.ts`: shortcuts/context menu.
- Modify `RouteEditor.svelte`, `RoutesPanel.svelte`, `HudDrawer.svelte`, `ManagePanel.svelte`: controls and guidance.
- Extend existing Vitest files; update `tests/e2e/routes.spec.ts`.

---

### Task 1: TypeScript Wire Contract and Host Normalization

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/runtime/backend/types.ts`
- Modify: `src/runtime/backend/shared.ts`
- Modify: `src/runtime/snapshotView.ts`
- Modify: `src/runtime/backend/wasmBackend.ts`
- Modify: `src/runtime/backend/tauriBackend.ts`
- Test: `tests/runtime/backendContract.test.ts`
- Test: `tests/runtime/tauriBackend.test.ts`
- Test: `tests/fixtures/rustSnapshot.ts`

**Interfaces:**
- Consumes: Rust wire types from core plan Task 1.
- Produces:

```typescript
export interface StopRoadAccess {
  roadPoint: Point;
  preferredHeading?: Heading;
}

export type LegFailureReason =
  | "noRoadAccess"
  | "networkDisconnected"
  | "noLegalEntryHeading"
  | "noLegalExitHeading"
  | "noLegalTurnaround";
```

- [ ] **Step 1: Write failing backend-normalization tests**

```typescript
it("normalizes omitted optional route fields", () => {
  const leg = normalizeRouteLegPath(legacyLeg as RouteLegPath);
  expect(leg.currentPath).toBeNull();
  expect(leg.lastValidPath).toBeNull();
  expect(leg.estimatedSeconds).toBeNull();
  expect(leg.failureReason).toBeNull();
});

it("preserves stop road access", () => {
  const state = normalizeRustSnapshot(snapshotWithRoadAccess);
  expect(state.transit.stops[0].roadAccess).toEqual({
    roadPoint: { x: 4, y: 5 },
    preferredHeading: "east",
  });
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `bunx vitest run --project runtime tests/runtime/backendContract.test.ts tests/runtime/tauriBackend.test.ts`

Expected: type/expectation failure because fields do not exist.

- [ ] **Step 3: Add TS wire types and optional defaults**

Extend `Stop`, `RouteLegPath`, and `RejectionCode`:

```typescript
export interface Stop {
  id: string;
  kind: StopKind;
  status: TransitNodeStatus;
  position: Point;
  roadAccess?: StopRoadAccess;
  platforms: Platform[];
}

export interface RouteLegPath {
  // existing fields
  failureReason: LegFailureReason | null;
}
```

Normalize `failureReason: leg.failureReason ?? null`; do not derive road access from adjacent roads in TS.

- [ ] **Step 4: Wire the non-initial snapshot load method only at the backend boundary**

If the Rust wrappers from the core plan expose load/replace methods, add:

```typescript
interface GameBackend {
  loadSnapshot?(snapshot: RustGameSnapshot): Promise<RustGameSnapshot>;
}
```

Implement structural serialization in WASM/Tauri adapters and contract tests. Do not add save/load UI or call this method from normal startup when no saved snapshot exists.

- [ ] **Step 5: Update fixtures and run tests**

Run: `bunx vitest run --project runtime tests/runtime/backendContract.test.ts tests/runtime/tauriBackend.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/types.ts src/runtime/backend/types.ts src/runtime/backend/shared.ts src/runtime/snapshotView.ts src/runtime/backend/wasmBackend.ts src/runtime/backend/tauriBackend.ts tests/runtime/backendContract.test.ts tests/runtime/tauriBackend.test.ts tests/fixtures/rustSnapshot.ts
git commit -m "feat(runtime): add stop access and route failure wire contracts"
```

---

### Task 2: Roadside Placement Feedback, Access Indicator, and Hit Testing

**Files:**
- Modify: `src/render/placementValidation.ts`
- Modify: `src/render/transitRenderer.ts`
- Modify: `src/render/overlayRenderer.ts`
- Modify: `src/ui/routeDraft.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Test: `tests/render/placementValidation.test.ts`
- Test: `tests/render/overlayRenderer.test.ts`
- Test: `tests/runtime/gameRuntime.test.ts`

**Interfaces:**
- Consumes: `Stop.roadAccess` from Task 1.
- Produces: one footprint-aware `resolveStopAtTile` path for add/select/inspect.

- [ ] **Step 1: Write failing placement and rendering tests**

```typescript
it("accepts a bus stop anchor beside a road, not on it", () => {
  expect(canPlaceBusStop(state, { x: 4, y: 4 })).toBe(true);
  expect(canPlaceBusStop(state, { x: 4, y: 5 })).toBe(false); // road tile
});

it("draws access from passenger anchor to road point", () => {
  renderOverlay(stateWithAccess);
  expect(lineCalls()).toContainEqual([
    tileCenter({ x: 4, y: 4 }),
    tileCenter({ x: 4, y: 5 }),
  ]);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `bunx vitest run --project ui tests/render/placementValidation.test.ts tests/render/overlayRenderer.test.ts`

Expected: current on-road validation/renderer behavior fails.

- [ ] **Step 3: Flip optimistic bus-stop validation**

Add a dedicated read-only helper:

```typescript
export function canPlaceBusStop(state: GameState, anchor: Point): boolean {
  const offsets: Point[] = [
    { x: 0, y: -1 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
  ];
  const tile = getTile(state.map, anchor);
  return tile?.kind === "empty"
    && tile.roadStructureId === undefined
    && !isBuildingOccupied(state, anchor)
    && !isTransitNodeAt(state, anchor)
    && offsets.some((offset) => {
      const road = getTile(state.map, {
        x: anchor.x + offset.x,
        y: anchor.y + offset.y,
      });
      return road?.kind === "road" && road.roadStructureId === undefined;
    });
}
```

Keep Rust authoritative for reciprocal usability.

- [ ] **Step 4: Render the access indicator**

For each present stop with `roadAccess`, draw a short high-contrast connector/arrow from `stop.position` to `roadAccess.roadPoint`. Render after buildings but before route preview handles. Vehicles/routes continue to use Rust path geometry; never draw buses onto the passenger anchor.

- [ ] **Step 5: Share node hit testing across interactions**

Use `resolveStopAtTile` for route add, inspect, and existing-handle selection. Replace exact-anchor handle lookup so a click anywhere in a terminal building's `occupiedTiles` resolves its stop id/index.

- [ ] **Step 6: Run focused tests**

Run:

```bash
bunx vitest run --project ui tests/render/placementValidation.test.ts tests/render/overlayRenderer.test.ts
bunx vitest run --project runtime tests/runtime/gameRuntime.test.ts -t "route handle"
```

- [ ] **Step 7: Commit**

```bash
git add src/render/placementValidation.ts src/render/transitRenderer.ts src/render/overlayRenderer.ts src/ui/routeDraft.ts src/runtime/createGameRuntime.ts tests/render/placementValidation.test.ts tests/render/overlayRenderer.test.ts tests/runtime/gameRuntime.test.ts
git commit -m "feat(ui): render and select roadside stop access"
```

---

### Task 3: Pure Duplicate-Safe Route Draft Reducers

**Files:**
- Modify: `src/ui/routeDraft.ts`
- Test: `tests/ui/routeDraft.test.ts`

**Interfaces:**
- Produces:

```typescript
export interface RouteDraftMutation {
  draft: RouteDraft;
  notice?: { kind: "alreadyOnRoute"; waypointId: string };
  previewRequested: boolean;
}
```

- [ ] **Step 1: Write failing duplicate tests**

```typescript
it("does not mutate or preview when appending the last stop again", () => {
  const result = applyNodeClick(draftWith("stop-001"), "stop-001");
  expect(result.draft).toBe(draft);
  expect(result.previewRequested).toBe(false);
});

it("selects an existing waypoint instead of appending it", () => {
  const result = applyNodeClick(draftWith("a", "b"), "a");
  expect(result.draft.waypointIds).toEqual(["a", "b"]);
  expect(result.draft.selectedIndex).toBe(0);
  expect(result.previewRequested).toBe(false);
});

it("notices an insert duplicate without mutation", () => {
  const result = applyNodeClick(insertAfterDraft, "a");
  expect(result.draft).toBe(insertAfterDraft);
  expect(result.notice).toEqual({ kind: "alreadyOnRoute", waypointId: "a" });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `bunx vitest run --project ui tests/ui/routeDraft.test.ts`

Expected: current reducers append duplicates and return `RouteDraft`, not `RouteDraftMutation`.

- [ ] **Step 3: Implement the mutation contract**

Return strict same-reference no-ops. Rules:

```typescript
if (interaction === "append" && waypointIds.at(-1) === nodeId) return noChange(draft);
const existing = waypointIds.indexOf(nodeId);
if (interaction === "append" && existing >= 0) {
  return { draft: selectWaypoint(draft, existing, interaction), previewRequested: false };
}
if (interaction === "insertAfter" && existing >= 0) {
  return { draft, notice: { kind: "alreadyOnRoute", waypointId: nodeId }, previewRequested: false };
}
if (interaction === "replace" && waypointIds[selectedIndex!] === nodeId) return noChange(draft);
if (interaction === "replace" && existing >= 0) {
  return { draft: selectWaypoint(draft, existing, interaction), previewRequested: false };
}
```

Set `previewRequested: true` only when `changed(...)` increments generation.

- [ ] **Step 4: Update `applyRouteNodeClick` rejection shape**

Return the mutation plus the existing rejection:

```typescript
export interface RouteDraftClickResult extends RouteDraftMutation {
  rejection: GameplayRejection | null;
}
```

- [ ] **Step 5: Run tests and typecheck the file**

Run: `bunx vitest run --project ui tests/ui/routeDraft.test.ts && bun run check`

- [ ] **Step 6: Commit**

```bash
git add src/ui/routeDraft.ts tests/ui/routeDraft.test.ts
git commit -m "fix(ui): suppress duplicate route waypoints"
```

---

### Task 4: Runtime-Owned Draft History and Preview Refresh

**Files:**
- Modify: `src/ui/uiState.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `src/runtime/types.ts`
- Test: `tests/runtime/gameRuntime.test.ts`
- Test: `tests/ui/routeDraft.test.ts`

**Interfaces:**
- Consumes: Task 3 `RouteDraftMutation`.
- Produces: `RouteDraftCheckpoint`, `RouteDraftHistory`, `undoRouteDraft`, `redoRouteDraft`.

- [ ] **Step 1: Write failing runtime-history tests**

Assert append/remove/reorder/reverse/pattern change push exactly one checkpoint; selection pushes none; duplicate no-op preserves history and preview call count; cancel/save/start-edit/mode-switch clear history.

```typescript
expect(runtime.getSnapshot().ui.routeDraftHistory.past).toHaveLength(1);
expect(backend.previewRoute).toHaveBeenCalledTimes(1);
runtime.undoRouteDraft();
expect(runtime.getSnapshot().ui.routeDraft?.generation).toBe(2);
expect(runtime.getSnapshot().ui.routeDraft?.preview).toBeNull();
expect(backend.previewRoute).toHaveBeenCalledTimes(2);
```

- [ ] **Step 2: Run and verify failure**

Run: `bunx vitest run --project runtime tests/runtime/gameRuntime.test.ts -t "route draft history"`

- [ ] **Step 3: Add checkpoint/history state**

```typescript
export type RouteDraftCheckpoint = Pick<
  RouteDraft,
  "waypointIds" | "pattern" | "selectedIndex" | "interaction" | "mode" | "source"
>;

export interface RouteDraftHistory {
  past: RouteDraftCheckpoint[];
  future: RouteDraftCheckpoint[];
}
```

Add `routeDraftHistory` and `routeDraftNotice` to `UiState`; initialize/clear them with the draft lifecycle.

- [ ] **Step 4: Make the runtime the sole history recorder**

Before a meaningful reducer action, push `checkpoint(current)` to `past`, cap at 100, clear `future`, then apply the mutation. Do not push if `mutation.draft === current` or `previewRequested === false` for a topology no-op. Selection-only controller methods bypass history.

- [ ] **Step 5: Implement undo/redo restoration**

Restore checkpoint fields into the current draft while preserving `instanceId`, then set:

```typescript
generation: current.generation + 1,
previewPending: true,
preview: null,
```

Move current checkpoint to the opposite stack, clear notice, commit, and call `requestRoutePreview` once.

- [ ] **Step 6: Expose controller methods and selector state**

Add `undoRouteDraft()`/`redoRouteDraft()` to `RuntimeController`; later selectors expose `canUndo`, `canRedo`, and notice.

- [ ] **Step 7: Run runtime tests**

Run: `bunx vitest run --project runtime tests/runtime/gameRuntime.test.ts`

- [ ] **Step 8: Commit**

```bash
git add src/ui/uiState.ts src/runtime/createGameRuntime.ts src/runtime/types.ts tests/runtime/gameRuntime.test.ts tests/ui/routeDraft.test.ts
git commit -m "feat(runtime): add route draft undo and redo history"
```

---

### Task 5: Route Editor Controls, Keyboard Shortcuts, and Context Menu

**Files:**
- Modify: `src/App.svelte`
- Modify: `src/runtime/createCanvasHost.ts`
- Modify: `src/components/hud/panels/RouteEditor.svelte`
- Modify: `src/components/hud/panels/RoutesPanel.svelte`
- Modify: `src/components/hud/HudDrawer.svelte`
- Test: `tests/ui/appShell.test.ts`
- Test: `tests/render/canvasHost.test.ts`
- Test: `tests/ui/hudPanels.test.ts`

**Interfaces:**
- Consumes: Task 4 controller/view state.
- Produces: user-visible Undo/Redo, right-click undo, Cmd/Ctrl shortcuts, Delete/Backspace removal.

- [ ] **Step 1: Write failing UI/keyboard tests**

Test Cmd/Ctrl+Z, Shift+Z/Y, Delete/Backspace, focused input bypass, and button disabled states. Test canvas `contextmenu` calls undo only with an active route draft and calls `preventDefault()` only then.

- [ ] **Step 2: Run tests and verify failure**

Run: `bunx vitest run --project ui tests/ui/appShell.test.ts tests/ui/hudPanels.test.ts tests/render/canvasHost.test.ts`

- [ ] **Step 3: Add key branches before the existing modifier early-return**

```typescript
const targetIsInput = isTextInput(event.target);
if (!targetIsInput && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
  event.preventDefault();
  setSnapshot(event.shiftKey ? runtime.redoRouteDraft() : runtime.undoRouteDraft());
  return;
}
if (!targetIsInput && (event.key === "Delete" || event.key === "Backspace")) {
  event.preventDefault();
  setSnapshot(runtime.removeRouteWaypoint());
  return;
}
```

Add Ctrl/Cmd+Y redo without disturbing Escape/build shortcuts.

- [ ] **Step 4: Add canvas context-menu handling**

Inject an `onRouteDraftContextMenu` callback into `createCanvasHost`; when it returns true, prevent the browser menu and call runtime undo. Outside route mode, return false and preserve the browser menu.

- [ ] **Step 5: Add Undo/Redo/notice UI**

Thread callbacks through `HudDrawer`/`RoutesPanel`. In `RouteEditor`, add buttons disabled by `editor.canUndo`/`editor.canRedo`, render the transient notice with `aria-live="polite"`, and keep Save/Cancel/Reload behavior unchanged.

- [ ] **Step 6: Run focused UI tests**

Run: `bunx vitest run --project ui tests/ui/appShell.test.ts tests/ui/hudPanels.test.ts tests/render/canvasHost.test.ts`

- [ ] **Step 7: Commit**

```bash
git add src/App.svelte src/runtime/createCanvasHost.ts src/components/hud/HudDrawer.svelte src/components/hud/panels/RoutesPanel.svelte src/components/hud/panels/RouteEditor.svelte tests/ui/appShell.test.ts tests/ui/hudPanels.test.ts tests/render/canvasHost.test.ts
git commit -m "feat(ui): add route draft undo shortcuts and controls"
```

---

### Task 6: Typed Failure Selectors and Shared Guidance

**Files:**
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/runtimeSelectors.ts`
- Modify: `src/components/hud/panels/RouteEditor.svelte`
- Modify: `src/components/hud/panels/ManagePanel.svelte`
- Modify: `src/render/overlayRenderer.ts`
- Modify: `src/runtime/rejectionMessages.ts`
- Test: `tests/runtime/runtimeSelectors.test.ts`
- Test: `tests/ui/managePanel.test.ts`
- Test: `tests/ui/hudPanels.test.ts`
- Test: `tests/render/overlayRenderer.test.ts`

**Interfaces:**
- Produces:

```typescript
export interface RouteFailureRow {
  legIndex: number;
  fromWaypointId: string;
  toWaypointId: string;
  fromLabel: string;
  toLabel: string;
  reason: "missingNode" | LegFailureReason;
  legKind: RouteLegKind;
  isLoopClosing: boolean;
  guidance: string;
  missingNodeKind?: "stop" | "station";
}
```

- [ ] **Step 1: Write failing selector tests**

Assert `failureReason` survives normalization and selector projection; Loop closing is `pattern === "loop" && leg.toWaypointId === waypointIds[0]`; terminal reversal is `leg.kind === "terminalReversal"`. Assert the same guidance string appears in route-draft and persisted-route views.

- [ ] **Step 2: Run tests and verify failure**

Run: `bunx vitest run --project runtime tests/runtime/runtimeSelectors.test.ts`

- [ ] **Step 3: Add one shared guidance function**

```typescript
export function routeFailureGuidance(
  reason: RouteFailureRow["reason"],
  context: { isLoopClosing: boolean; legKind: RouteLegKind },
): string {
  if (reason === "noLegalTurnaround") return "No legal U-turn here; add a junction or roundabout.";
  if (reason === "networkDisconnected" && context.isLoopClosing) return "Loop can't close here; switch to Shuttle or repair the road.";
  if (reason === "noRoadAccess") return "Stop has no usable adjacent road.";
  if (reason === "noLegalEntryHeading" || reason === "noLegalExitHeading") return "Road direction doesn't allow serving this stop here.";
  if (reason === "missingNode") return "Restore the missing node at its former location.";
  return "Repair the road connection between these stops.";
}
```

- [ ] **Step 4: Thread typed rows through selectors**

Add `failures` to `RouteEditorView`; extend persisted `RouteFailureRow`; keep `previewMessage` as the coarse summary. Normalize old legs with no reason to `networkDisconnected` when coarse status is disconnected.

- [ ] **Step 5: Replace component-local generic messages**

Remove `ManagePanel.failureReason`; render `failure.guidance` in ManagePanel, RouteEditor, and overlay. Add `noRoadAccess` to placement rejection copy.

- [ ] **Step 6: Run selector/UI/render tests**

Run:

```bash
bunx vitest run --project runtime tests/runtime/runtimeSelectors.test.ts
bunx vitest run --project ui tests/ui/managePanel.test.ts tests/ui/hudPanels.test.ts tests/render/overlayRenderer.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add src/runtime/types.ts src/runtime/runtimeSelectors.ts src/components/hud/panels/RouteEditor.svelte src/components/hud/panels/ManagePanel.svelte src/render/overlayRenderer.ts src/runtime/rejectionMessages.ts tests/runtime/runtimeSelectors.test.ts tests/ui/managePanel.test.ts tests/ui/hudPanels.test.ts tests/render/overlayRenderer.test.ts
git commit -m "feat(ui): show typed route failure guidance"
```

---

### Task 7: Runtime/E2E Integration Regression

**Files:**
- Modify: `tests/runtime/gameRuntime.test.ts`
- Modify: `tests/e2e/routes.spec.ts`
- Modify: `tests/helpers/gameState.ts`
- Modify: `tests/fixtures/rustSnapshot.ts`

**Interfaces:**
- Consumes: all prior tasks and the completed Rust core plan.
- Produces: browser/runtime proof of HPA-309 workflow.

- [ ] **Step 1: Add a runtime no-preview duplicate assertion**

Click the same stop repeatedly through `handleTileClick`; assert waypoint ids/history/generation unchanged and `backend.previewRoute` call count unchanged.

- [ ] **Step 2: Add preview/commit structural equality through the backend**

Create a route, capture preview legs, save, and compare leg keys/status/failure reason/path steps/travel seconds to the committed snapshot.

- [ ] **Step 3: Update Playwright stop placement**

The route e2e road runs on `y=4`; place stops on `y=3` or `y=5` roadside cells and assert rendered stop anchors are not road tiles. Update exact movement expectations only where the Rust path changed; keep turn/direction assertions strict.

- [ ] **Step 4: Add browser undo workflow**

Create a route draft, add two stops, right-click to undo one, re-add, Cmd/Ctrl+Z, then use visible Redo. Assert the preview refreshes and Save remains disabled while pending.

- [ ] **Step 5: Run runtime and e2e tests**

Run:

```bash
bunx vitest run --project runtime tests/runtime/gameRuntime.test.ts
bun run test:e2e -- tests/e2e/routes.spec.ts
```

Expected: both pass; the Playwright page starts with rebuilt WASM.

- [ ] **Step 6: Commit**

```bash
git add tests/runtime/gameRuntime.test.ts tests/e2e/routes.spec.ts tests/helpers/gameState.ts tests/fixtures/rustSnapshot.ts
git commit -m "test(e2e): cover roadside route editing workflow"
```

---

### Task 8: Full Frontend and Production Verification

**Files:**
- Verify only; modify source/tests only for observed failures.

**Interfaces:**
- Consumes: both implementation plans.
- Produces: CI-ready HPA-309 change set.

- [ ] **Step 1: Run TypeScript/Svelte checks**

Run: `bun run check`

Expected: exit 0.

- [ ] **Step 2: Run lint**

Run: `bun run lint`

Expected: ESLint and `cargo clippy -D warnings` exit 0.

- [ ] **Step 3: Run formatting check**

Run: `bun run format:check`

Expected: Prettier and Rust fmt checks pass.

- [ ] **Step 4: Run all unit tests**

Run: `bun run test`

Expected: UI and runtime projects pass with current WASM.

- [ ] **Step 5: Run Playwright**

Run: `bun run test:e2e`

Expected: all browser tests pass.

- [ ] **Step 6: Run the production build**

Run: `bun run build`

Expected: Svelte check, TypeScript, release WASM build, and Vite production build pass.

- [ ] **Step 7: Inspect final worktree and diff**

Run: `git status --short && git diff --check && git diff --stat`

Expected: only HPA-309 files changed; generated WASM files remain ignored.

- [ ] **Step 8: Finish with a clean verification state**

If Steps 1–7 required a source change, return to that source file's owning task, rerun its focused test/commit step, and then repeat Steps 1–7. Do not create a catch-all verification commit.

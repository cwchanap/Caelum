# HPA-345 Minimal Multi-City New City Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let browser players create a named Standard/Creative Blank Grid/Crossroads city through the existing working-save runtime, persist the real Rust/WASM snapshot in IndexedDB before activation, and keep the Tauri host playable with non-durable in-memory storage until HPA-344 lands.

**Architecture:** Reuse `RuntimePersistenceController.createCity` and the existing six-operation `CitySaveStore`. Narrow the player request using existing domain unions, wire browser IndexedDB plus a temporary Tauri memory store before introducing the no-city gate, centralize persistence error copy under `src/runtime/`, then land the pre-game Svelte screen and the mandatory e2e bootstrap migration together so every implementation commit remains playable and green.

**Tech Stack:** TypeScript 5.8, Svelte 5, Vitest + Testing Library, Playwright/Chromium, Rust/WASM `caelum-core`, browser IndexedDB, existing in-memory `CitySaveStore`, Tauri 2.

## Global Constraints

- Reuse `EconomyPreset`, `SandboxTemplateId`, and `MoveInRateSelection` from `src/domain/types.ts`; do not add duplicate New City preset/template aliases.
- The player form collects only city name, Standard/Creative, and Blank Grid/Crossroads.
- Hidden sandbox values remain `120_000`, `1`, and `"paused"` at the current strict host request boundary.
- Do **not** change Rust `None` handling for `starting_capital` / `demand_multiplier`; current tests intentionally classify missing/null values as typed errors.
- The real Chromium proof must compare the created city's hidden settings with the pre-game Rust-owned canonical snapshot so TS/Rust default drift is observable.
- UI invokes only `runtime.persistence.createCity`; it never builds snapshots or accesses a store directly.
- Preserve build candidate -> create record -> restore candidate -> install gameplay. Do not add rollback, pending/finalize, reconciliation, retry loops, or recovery state.
- Browser uses `createIndexedDbCitySaveStore()`.
- Tauri uses `createMemoryCitySaveStore()` only as a temporary non-durable bridge; HPA-344 replaces that branch with the native adapter.
- Do not use IndexedDB on Tauri.
- Do not add Continue/Load, city library, Save Now, Rename, or Delete UI; HPA-346 owns those.
- No migration/backward-compatibility overload for `{ name, sandbox }`.
- No generic form abstraction, repository/service layer, state machine, DI container, registry, or new dependency.
- `createDefaultCity(page)` is mandatory for existing gameplay e2e specs and waits assertively for the pre-game screen; no one-shot `isVisible()` shortcut.

---

## Task 1: Narrow the runtime request and migrate every caller

**Files:**
- Modify: `src/runtime/workingSaveRuntime.ts`
- Modify: `tests/runtime/workingSaveRuntime.test.ts`
- Modify: `tests/runtime/citySaveRuntime.test.ts`
- Modify: `tests/runtime/gameRuntime.test.ts` only if the required scan finds an old-shape call

**Interfaces:**

Consumes existing domain types:

```ts
import type {
  EconomyPreset,
  MoveInRateSelection,
  SandboxTemplateId,
} from "../domain/types";
```

Produces:

```ts
export interface NewCityRequest {
  name: string;
  economyPreset: EconomyPreset;
  templateId: SandboxTemplateId;
}
```

Keeps:

```ts
RuntimePersistenceController.createCity(
  request: NewCityRequest,
): Promise<WorkingSaveResult<CitySummary>>;
```

### Steps

- [ ] **Step 1: Replace the test request fixture with the player shape**

In `tests/runtime/workingSaveRuntime.test.ts` use:

```ts
const NEW_CITY_REQUEST = {
  name: "New City",
  economyPreset: "standard",
  templateId: "blankGrid",
} as const;
```

Keep `SandboxCreationRequest` only for the backend test double that records translated host requests.

- [ ] **Step 2: Record host sandbox requests in the existing backend double**

Extend `TestBackend`:

```ts
interface TestBackend extends GameBackend {
  calls: string[];
  sandboxRequests: SandboxCreationRequest[];
  setSnapshotForSaveOutcome(outcome: SnapshotResult | Error | null): void;
  setRestoreOutcome(outcome: SnapshotResult | Error | null): void;
  setSandboxOutcome(outcome: SandboxCreationResult | Error | null): void;
}
```

Inside `createTestBackend` add:

```ts
const sandboxRequests: SandboxCreationRequest[] = [];
```

and record the request before returning the candidate:

```ts
async buildSandboxSnapshot(request: SandboxCreationRequest) {
  calls.push("buildSandboxSnapshot");
  events?.push("buildSandboxSnapshot");
  sandboxRequests.push(request);
  if (sandboxOutcome instanceof Error) throw sandboxOutcome;
  return (
    sandboxOutcome ?? {
      ok: true,
      snapshot: createRustSnapshot({ budget: request.startingCapital }),
    }
  );
},
```

Expose `sandboxRequests` on the returned test backend.

- [ ] **Step 3: Write the failing translation characterization**

Add:

```ts
it("translates player New City choices to the current hidden settings", async () => {
  const fixture = createRuntimeFixture({ initialCity: null });

  await fixture.runtime.controller.createCity({
    name: "Creative Grid",
    economyPreset: "creative",
    templateId: "blankGrid",
  });

  expect(fixture.backend.sandboxRequests).toEqual([
    {
      templateId: "blankGrid",
      economyPreset: "creative",
      startingCapital: 120_000,
      demandMultiplier: 1,
      moveInRate: "paused",
    },
  ]);
});
```

This test characterizes the TypeScript translation only. It is **not** the Rust-default drift proof; Task 4 owns that with real WASM.

- [ ] **Step 4: Run the focused test red**

```bash
bun run test -- tests/runtime/workingSaveRuntime.test.ts
```

Expected: FAIL because `createCity` still expects `{ name, sandbox }`.

- [ ] **Step 5: Reuse the existing domain unions**

In `src/runtime/workingSaveRuntime.ts` add:

```ts
import type {
  EconomyPreset,
  MoveInRateSelection,
  SandboxTemplateId,
} from "../domain/types";
```

Replace the request interface with:

```ts
export interface NewCityRequest {
  name: string;
  economyPreset: EconomyPreset;
  templateId: SandboxTemplateId;
}
```

Do not add local aliases for those unions.

- [ ] **Step 6: Keep the current strict host request and type the fixed move-in value**

Add beside `NewCityRequest`:

```ts
// Mirror the current hidden values from `canonical_default_request()` in
// crates/caelum-core/src/sandbox.rs. Real-WASM parity is checked by HPA-345's
// Chromium New City smoke; Rust's strict missing/null validation remains intact.
const NEW_CITY_STARTING_CAPITAL = 120_000;
const NEW_CITY_DEMAND_MULTIPLIER = 1;
const NEW_CITY_MOVE_IN_RATE: MoveInRateSelection = "paused";
```

Do not make `SandboxCreationRequest.startingCapital` or `demandMultiplier` optional in this ticket.

- [ ] **Step 7: Translate immediately before candidate construction**

Replace the old `request.sandbox` call with:

```ts
const candidate = await host.backend.buildSandboxSnapshot({
  templateId: request.templateId,
  economyPreset: request.economyPreset,
  startingCapital: NEW_CITY_STARTING_CAPITAL,
  demandMultiplier: NEW_CITY_DEMAND_MULTIPLIER,
  moveInRate: NEW_CITY_MOVE_IN_RATE,
});
```

Do not alter the later create -> restore -> install order.

- [ ] **Step 8: Migrate every `workingSaveRuntime.test.ts` New City call**

Replace calls shaped like:

```ts
fixture.runtime.controller.createCity({
  name: "New City",
  sandbox: SANDBOX_REQUEST,
})
```

with:

```ts
fixture.runtime.controller.createCity(NEW_CITY_REQUEST)
```

For a non-default player choice use:

```ts
fixture.runtime.controller.createCity({
  ...NEW_CITY_REQUEST,
  economyPreset: "creative",
})
```

Update sandbox error expectations to reference `NEW_CITY_REQUEST.templateId`.

- [ ] **Step 9: Migrate `citySaveRuntime.test.ts` in the same change**

Replace every old request:

```ts
{
  name: "...",
  sandbox: SANDBOX_REQUEST,
}
```

with the player shape:

```ts
{
  name: "...",
  economyPreset: "standard",
  templateId: "crossroads",
}
```

Remove the old backend-shaped fixture if nothing else uses it.

Existing test doubles that derive the candidate budget from `request.startingCapital` now observe `120_000` rather than old fixture values such as `150_000`; update only assertions that intentionally checked that fixture-derived value.

- [ ] **Step 10: Scan and migrate every other current runtime caller**

```bash
rg -n 'createCity\(|sandbox:' src tests/runtime
```

Inspect every `createCity` call. Update `tests/runtime/gameRuntime.test.ts` if it still passes `{ name, sandbox }`.

Expected: no current production/runtime test caller passes `sandbox` to `RuntimePersistenceController.createCity`.

- [ ] **Step 11: Run affected tests**

```bash
bun run test -- \
  tests/runtime/workingSaveRuntime.test.ts \
  tests/runtime/citySaveRuntime.test.ts \
  tests/runtime/gameRuntime.test.ts
```

Expected: PASS.

- [ ] **Step 12: Run the complete frontend contract gate**

```bash
bun run check
bun run test:unit
```

Expected: PASS.

- [ ] **Step 13: Commit the complete request cutover**

```bash
git add \
  src/runtime/workingSaveRuntime.ts \
  tests/runtime/workingSaveRuntime.test.ts \
  tests/runtime/citySaveRuntime.test.ts
git add tests/runtime/gameRuntime.test.ts 2>/dev/null || true
git commit -m "feat: narrow new city runtime request"
```

Only stage `gameRuntime.test.ts` when it actually changed.

---

## Task 2: Wire a usable city store for both current hosts before gating the UI

**Files:**
- Modify: `src/main.ts`

**Interfaces:**

```text
browser/WASM -> createIndexedDbCitySaveStore()
native Tauri -> createMemoryCitySaveStore()  // temporary until HPA-344
```

No UI behavior changes in this task; the existing anonymous game shell remains visible, so the wiring is inert from the player's perspective and the commit stays playable.

### Steps

- [ ] **Step 1: Add explicit host/store imports**

In `src/main.ts` import:

```ts
import {
  createBackend,
  isTauriRuntime,
  type GameBackend,
} from "./runtime/backend";
import { createIndexedDbCitySaveStore } from "./persistence/indexedDbCitySaveStore";
import { createMemoryCitySaveStore } from "./persistence/memoryCitySaveStore";
```

- [ ] **Step 2: Resolve the host once in `mountApp`**

At the top of `mountApp()` add:

```ts
const nativeTauri = isTauriRuntime();
```

Keep `createBackend()` as the gameplay-host selector.

- [ ] **Step 3: Choose the store explicitly and pass it to the runtime**

Replace:

```ts
const runtime: RuntimeController = await createGameRuntime({ backend });
```

with:

```ts
const saveStore = nativeTauri
  ? createMemoryCitySaveStore() // HPA-344 replaces this with native persistence.
  : createIndexedDbCitySaveStore();
const runtime: RuntimeController = await createGameRuntime({
  backend,
  saveStore,
});
```

Do not introduce an IndexedDB Tauri branch or a generic host-store registry.

- [ ] **Step 4: Type/build verify the inert bootstrap wiring**

```bash
bun run check
bun run build
```

Expected: PASS.

- [ ] **Step 5: Verify the native bundle still compiles with the memory branch**

```bash
bun run tauri:build
```

Expected: PASS. This proves the production Tauri bootstrap can include the existing memory store; HPA-344 still owns durability.

- [ ] **Step 6: Commit the store wiring**

```bash
git add src/main.ts
git commit -m "feat: wire city stores at bootstrap"
```

---

## Task 3: Centralize WorkingSaveError player copy under the runtime layer

**Files:**
- Modify: `src/runtime/rejectionMessages.ts`
- Modify: `tests/runtime/rejectionMessages.test.ts`

**Interfaces:**

Produces:

```ts
export function workingSaveErrorMessage(error: WorkingSaveError): string;
```

The function returns concise player copy only; adapter/backend diagnostics never appear in the returned string.

### Steps

- [ ] **Step 1: Write runtime message tests first**

In `tests/runtime/rejectionMessages.test.ts` import:

```ts
import { workingSaveErrorMessage } from "../../src/runtime/rejectionMessages";
```

Add one table covering the closed `WorkingSaveError.kind` union:

```ts
it.each([
  [{ kind: "busy" } as const, "Another city action is already in progress."],
  [{ kind: "unavailable" } as const, "City storage is unavailable."],
  [{ kind: "noActiveCity" } as const, "No city is active."],
  [
    {
      kind: "sandbox",
      error: { code: "unknownTemplateId", context: {} },
    } as const,
    "Could not create that city setup.",
  ],
  [
    { kind: "backend", error: { code: "hostFailure" } } as const,
    "Could not apply the city state.",
  ],
])("maps working-save error %o to player copy", (error, message) => {
  expect(workingSaveErrorMessage(error)).toBe(message);
});
```

Add a create-store diagnostic regression:

```ts
it("maps create-store failure without exposing diagnostics", () => {
  const message = workingSaveErrorMessage({
    kind: "store",
    error: {
      operation: "createCity",
      code: "failed",
      diagnostic: "QuotaExceededError: private browser detail",
    },
  });

  expect(message).toBe("Could not save the new city.");
  expect(message).not.toContain("QuotaExceededError");
});
```

Add a table for the existing six store operations:

```ts
it.each([
  ["listCities", "Could not load the city list."],
  ["readCity", "Could not load that city."],
  ["createCity", "Could not save the new city."],
  ["updateCity", "Could not save the city."],
  ["renameCity", "Could not rename the city."],
  ["deleteCity", "Could not delete the city."],
] as const)("maps %s store errors", (operation, expected) => {
  expect(
    workingSaveErrorMessage({
      kind: "store",
      error: { operation, code: "failed" },
    }),
  ).toBe(expected);
});
```

- [ ] **Step 2: Run the runtime message test red**

```bash
bun run test -- tests/runtime/rejectionMessages.test.ts
```

Expected: FAIL because `workingSaveErrorMessage` does not exist.

- [ ] **Step 3: Generalize the existing DEV-loud `assertNever` label**

In `src/runtime/rejectionMessages.ts` change the helper to:

```ts
function assertNever(value: never, label: string): string {
  if (import.meta.env.DEV) {
    throw new Error(`Unhandled ${label}: ${String(value)}`);
  }
  return "This action could not be completed.";
}
```

Update existing defaults to call it with a meaningful label:

```ts
return assertNever(code, "rejection code");
```

and:

```ts
return assertNever(code, "warning code");
```

- [ ] **Step 4: Add operation-specific store copy**

Import:

```ts
import type { CitySaveStoreOperation } from "../persistence/citySaveStore";
import type { WorkingSaveError } from "./workingSaveRuntime";
```

Add:

```ts
function cityStoreOperationMessage(operation: CitySaveStoreOperation): string {
  switch (operation) {
    case "listCities":
      return "Could not load the city list.";
    case "readCity":
      return "Could not load that city.";
    case "createCity":
      return "Could not save the new city.";
    case "updateCity":
      return "Could not save the city.";
    case "renameCity":
      return "Could not rename the city.";
    case "deleteCity":
      return "Could not delete the city.";
    default:
      return assertNever(operation, "city save operation");
  }
}
```

- [ ] **Step 5: Add the exhaustive working-save mapper**

```ts
export function workingSaveErrorMessage(error: WorkingSaveError): string {
  switch (error.kind) {
    case "busy":
      return "Another city action is already in progress.";
    case "unavailable":
      return "City storage is unavailable.";
    case "noActiveCity":
      return "No city is active.";
    case "sandbox":
      return "Could not create that city setup.";
    case "backend":
      return "Could not apply the city state.";
    case "store":
      return cityStoreOperationMessage(error.error.operation);
    default:
      return assertNever(error, "working-save error");
  }
}
```

Do not include `diagnostic`, backend error internals, IndexedDB names, or filesystem details in the copy.

- [ ] **Step 6: Run the focused and full runtime tests**

```bash
bun run test -- tests/runtime/rejectionMessages.test.ts
bun run test:unit
```

Expected: PASS.

- [ ] **Step 7: Commit the reusable message mapping**

```bash
git add src/runtime/rejectionMessages.ts tests/runtime/rejectionMessages.test.ts
git commit -m "feat: map working save errors to player copy"
```

---

## Task 4: Land the pre-game UI and migrate the full gameplay e2e bootstrap atomically

**Files:**
- Create: `src/components/NewCityScreen.svelte`
- Modify: `src/App.svelte`
- Modify: `src/styles.css`
- Modify: `tests/ui/appShell.test.ts`
- Modify: `tests/e2e/helpers.ts`
- Create: `tests/e2e/newCity.spec.ts`
- Modify: `tests/e2e/smoke.spec.ts`
- Modify: `tests/e2e/commandShelf.spec.ts`
- Modify: `tests/e2e/topbarViewport.spec.ts`
- Modify: `tests/e2e/routes.spec.ts`
- Modify: `tests/e2e/roundabouts.spec.ts`

This task is one commit because the no-city gate and the e2e bootstrap migration must land together. The browser store was already wired in Task 2, so Create is functional as soon as the UI appears.

### Step group A — Svelte behavior

- [ ] **Step 1: Make App-test persistence state mutable**

In `tests/ui/appShell.test.ts` extend `createRuntimeHarness` options with:

```ts
persistence?: Partial<RuntimeSnapshot["persistence"]>;
```

Replace the fixed persistence object with:

```ts
let persistence: RuntimeSnapshot["persistence"] = {
  activeCity: {
    id: "city-1",
    name: "Harbour City",
    createdAt: "2026-01-01T00:00:00.000Z",
    savedAt: "2026-01-01T00:00:00.000Z",
  },
  busy: false,
  dirty: false,
  error: null,
  ...options.persistence,
};
```

Return a helper:

```ts
setPersistence(next: Partial<RuntimeSnapshot["persistence"]>) {
  persistence = { ...persistence, ...next };
  return publish();
},
```

- [ ] **Step 2: Add the focused no-active-city test**

```ts
it("shows New City instead of game chrome when no city is active", () => {
  const { runtime } = createRuntimeHarness({
    persistence: { activeCity: null },
  });

  render(App, { props: { runtime } });

  expect(screen.getByTestId("new-city-screen")).toBeVisible();
  expect(screen.queryByTestId("game-canvas-host")).toBeNull();
  expect(screen.queryByTestId("command-shelf")).toBeNull();
  expect(screen.queryByTestId("topbar")).toBeNull();
});
```

Do not add a separate test trying to observe `snapshot === null` before Svelte flushes the initial `$effect`.

- [ ] **Step 3: Add the request-shape test**

```ts
it("submits only trimmed name, economy, and template", async () => {
  const { runtime } = createRuntimeHarness({
    persistence: { activeCity: null },
  });
  render(App, { props: { runtime } });

  const create = screen.getByRole("button", { name: "Create City" });
  expect(create).toBeDisabled();

  await fireEvent.input(screen.getByLabelText("City name"), {
    target: { value: "  Maple Junction  " },
  });
  await fireEvent.change(screen.getByLabelText("Economy"), {
    target: { value: "creative" },
  });
  await fireEvent.change(screen.getByLabelText("Template"), {
    target: { value: "blankGrid" },
  });
  await fireEvent.click(create);

  expect(runtime.persistence.createCity).toHaveBeenCalledWith({
    name: "Maple Junction",
    economyPreset: "creative",
    templateId: "blankGrid",
  });
});
```

- [ ] **Step 4: Add busy, error-copy, and active-city transition tests**

```ts
it("disables repeat New City submission while persistence is busy", async () => {
  const harness = createRuntimeHarness({
    persistence: { activeCity: null },
  });
  render(App, { props: { runtime: harness.runtime } });

  await fireEvent.input(screen.getByLabelText("City name"), {
    target: { value: "Busy City" },
  });
  harness.setPersistence({ busy: true });

  expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
});

it("shows runtime-mapped persistence copy without diagnostics", () => {
  const harness = createRuntimeHarness({
    persistence: { activeCity: null },
  });
  render(App, { props: { runtime: harness.runtime } });

  harness.setPersistence({
    error: {
      kind: "store",
      error: {
        operation: "createCity",
        code: "failed",
        diagnostic: "QuotaExceededError: private browser detail",
      },
    },
  });

  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not save the new city.",
  );
  expect(screen.getByRole("alert")).not.toHaveTextContent("QuotaExceededError");
});

it("returns to the normal game shell after a city becomes active", () => {
  const harness = createRuntimeHarness({
    persistence: { activeCity: null },
  });
  render(App, { props: { runtime: harness.runtime } });

  harness.setPersistence({
    activeCity: {
      id: "city-new",
      name: "Maple Junction",
      createdAt: "2026-08-10T17:00:00.000Z",
      savedAt: "2026-08-10T17:00:00.000Z",
    },
    busy: false,
    dirty: false,
    error: null,
  });

  expect(screen.queryByTestId("new-city-screen")).toBeNull();
  expect(screen.getByTestId("game-canvas-host")).toBeVisible();
  expect(screen.getByTestId("command-shelf")).toBeVisible();
});
```

- [ ] **Step 5: Run App tests red**

```bash
bun run test -- tests/ui/appShell.test.ts
```

Expected: FAIL because the pre-game component/gate do not exist.

- [ ] **Step 6: Create `NewCityScreen.svelte`**

Create `src/components/NewCityScreen.svelte`:

```svelte
<script lang="ts">
  import type {
    EconomyPreset,
    SandboxTemplateId,
  } from "../domain/types";
  import type { NewCityRequest } from "../runtime/workingSaveRuntime";

  interface Props {
    busy: boolean;
    error: string | null;
    onCreate: (request: NewCityRequest) => void;
  }

  let { busy, error, onCreate }: Props = $props();
  let name = $state("");
  let economyPreset = $state<EconomyPreset>("standard");
  let templateId = $state<SandboxTemplateId>("crossroads");
  const canCreate = $derived(!busy && name.trim().length > 0);

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    const trimmedName = name.trim();
    if (busy || trimmedName.length === 0) return;
    onCreate({ name: trimmedName, economyPreset, templateId });
  }
</script>

<main class="new-city-screen" data-testid="new-city-screen">
  <form class="new-city-card" onsubmit={submit}>
    <p class="new-city-kicker">CAELUM // LOCAL CITY</p>
    <h1>New City</h1>

    <label>
      <span>City name</span>
      <input bind:value={name} autocomplete="off" />
    </label>

    <label>
      <span>Economy</span>
      <select bind:value={economyPreset}>
        <option value="standard">Standard</option>
        <option value="creative">Creative</option>
      </select>
    </label>

    <label>
      <span>Template</span>
      <select bind:value={templateId}>
        <option value="crossroads">Crossroads</option>
        <option value="blankGrid">Blank Grid</option>
      </select>
    </label>

    {#if error !== null}
      <p class="new-city-error" role="alert">{error}</p>
    {/if}

    <button type="submit" disabled={!canCreate}>
      {busy ? "Creating…" : "Create City"}
    </button>
  </form>
</main>
```

Do not import `WorkingSaveError`, a store, or a backend into this component.

- [ ] **Step 7: Add the App handler and runtime message import**

In `src/App.svelte` import:

```ts
import NewCityScreen from "./components/NewCityScreen.svelte";
import { workingSaveErrorMessage } from "./runtime/rejectionMessages";
import type { NewCityRequest } from "./runtime/workingSaveRuntime";
```

Add:

```ts
function handleCreateCity(request: NewCityRequest): void {
  if (runtime === null) return;
  void runtime.persistence.createCity(request);
}
```

The working-save runtime publishes busy/error/active-city state through the existing subscription; do not create a second App persistence state machine.

- [ ] **Step 8: Add the nullish no-active-city branch**

Keep the existing fatal shell branch first, then use:

```svelte
{:else if snapshot?.persistence.activeCity == null}
  <NewCityScreen
    busy={snapshot?.persistence.busy ?? false}
    error={snapshot?.persistence.error == null
      ? null
      : workingSaveErrorMessage(snapshot.persistence.error)}
    onCreate={handleCreateCity}
  />
{:else}
  <!-- existing active game shell unchanged -->
{/if}
```

Do not add a dedicated test for a pre-effect `snapshot === null` frame; the `activeCity: null` test is the required branch proof.

- [ ] **Step 9: Add minimal Signal Console-compatible New City styles**

In `src/styles.css` add only the layout needed for the focused screen, for example:

```css
.new-city-screen {
  display: grid;
  place-items: center;
  width: 100vw;
  height: 100vh;
  padding: 48px;
  background: var(--bg-deep);
}

.new-city-card {
  display: grid;
  gap: 18px;
  width: min(520px, 100%);
  padding: 32px;
  border: 1px solid var(--line-strong);
  background: var(--surface);
}

.new-city-card label {
  display: grid;
  gap: 8px;
}

.new-city-card input,
.new-city-card select,
.new-city-card button {
  min-height: 44px;
}

.new-city-error {
  color: var(--red);
}
```

Reuse existing CSS variables and global typography; do not create a new design system.

- [ ] **Step 10: Run focused UI tests green**

```bash
bun run test -- tests/ui/appShell.test.ts
```

Expected: PASS.

### Step group B — Mandatory e2e bootstrap migration

- [ ] **Step 11: Add an unconditional `createDefaultCity` helper**

In `tests/e2e/helpers.ts` add:

```ts
export async function createDefaultCity(
  page: Page,
  name = "E2E City",
): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("new-city-screen")).toBeVisible();
  await page.getByLabel("City name").fill(name);
  await page.getByRole("button", { name: "Create City" }).click();
  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
}
```

Do not use:

```ts
if (await page.getByTestId("new-city-screen").isVisible())
```

WASM initialization can complete after `page.goto()` resolves; the retrying `expect(...).toBeVisible()` is required.

- [ ] **Step 12: Migrate every existing gameplay root navigation**

In these files, import `createDefaultCity` and replace each gameplay setup:

```ts
await page.goto("/");
```

with:

```ts
await createDefaultCity(page);
```

Files:

```text
tests/e2e/smoke.spec.ts
tests/e2e/commandShelf.spec.ts
tests/e2e/topbarViewport.spec.ts
tests/e2e/routes.spec.ts
tests/e2e/roundabouts.spec.ts
```

Preserve any `page.setViewportSize(...)` or `page.addInitScript(...)` calls that intentionally happen before navigation; call `createDefaultCity(page)` after those setup calls.

- [ ] **Step 13: Add the dedicated real-WASM/real-IndexedDB New City smoke**

Create `tests/e2e/newCity.spec.ts` with this shape:

```ts
import { expect, test } from "@playwright/test";
import { runtimeSnapshot } from "./helpers";

test("creates a default city through real WASM and IndexedDB", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("new-city-screen")).toBeVisible();

  const before = await runtimeSnapshot(page);
  expect(before.persistence.activeCity).toBeNull();
  const rustDefaults = {
    budget: before.state.budget,
    startingCapital: before.state.rules.sandbox.startingCapital,
    demandMultiplier: before.state.rules.sandbox.demandMultiplier,
    moveInRate: before.state.rules.sandbox.moveInRate,
  };

  const cityName = "IndexedDB Smoke";
  await page.getByLabel("City name").fill(cityName);
  await page.getByRole("button", { name: "Create City" }).click();
  await expect(page.getByTestId("game-canvas-host")).toBeVisible();

  const after = await runtimeSnapshot(page);
  expect(after.persistence.activeCity).toMatchObject({ name: cityName });
  expect(after.persistence.busy).toBe(false);
  expect(after.persistence.dirty).toBe(false);
  expect(after.state.paused).toBe(true);
  expect({
    budget: after.state.budget,
    startingCapital: after.state.rules.sandbox.startingCapital,
    demandMultiplier: after.state.rules.sandbox.demandMultiplier,
    moveInRate: after.state.rules.sandbox.moveInRate,
  }).toEqual(rustDefaults);

  const cityId = after.persistence.activeCity!.id;
  const stored = await page.evaluate(
    async ({ cityId, cityName }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("caelum-city-saves-v1", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const records = await new Promise<any[]>((resolve, reject) => {
        const transaction = database.transaction("cities", "readonly");
        const request = transaction.objectStore("cities").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      database.close();
      return (
        records.find(
          (record) =>
            record?.city?.id === cityId && record?.city?.name === cityName,
        ) ?? null
      );
    },
    { cityId, cityName },
  );

  expect(stored).not.toBeNull();
  expect(stored.city).toMatchObject({ id: cityId, name: cityName });
  expect(stored.snapshot.budget).toBe(after.state.budget);
  expect(stored.snapshot.schemaVersion).toBe(after.state.schemaVersion);
});
```

The important drift check is `after hidden settings === before Rust-owned hidden settings`, not a TypeScript literal compared with another TypeScript literal.

- [ ] **Step 14: Scan for accidental direct gameplay navigation**

```bash
rg -n 'page\.goto\("/"\)' tests/e2e
```

Expected matches after migration:

- `tests/e2e/helpers.ts` inside `createDefaultCity`;
- `tests/e2e/newCity.spec.ts` for the dedicated pre-game proof.

Any other match must be inspected and either migrated or explicitly justified as a pre-game test.

- [ ] **Step 15: Run the full e2e suite before committing the gate**

```bash
bun run test:e2e
```

Expected: PASS. Task 4 is not green if only `newCity.spec.ts` passes.

- [ ] **Step 16: Run frontend quality gates**

```bash
bun run test:unit
bun run check
bun run lint:svelte
bun run lint:css
bun run format:check
```

Expected: PASS.

- [ ] **Step 17: Commit the UI and e2e migration atomically**

```bash
git add \
  src/App.svelte \
  src/components/NewCityScreen.svelte \
  src/styles.css \
  tests/ui/appShell.test.ts \
  tests/e2e/helpers.ts \
  tests/e2e/newCity.spec.ts \
  tests/e2e/smoke.spec.ts \
  tests/e2e/commandShelf.spec.ts \
  tests/e2e/topbarViewport.spec.ts \
  tests/e2e/routes.spec.ts \
  tests/e2e/roundabouts.spec.ts
git commit -m "feat: add browser new city entry flow"
```

---

## Task 5: Align architecture docs and run the final verification gate

**Files:**
- Modify: `docs/architecture.md`
- Review: `docs/superpowers/specs/2026-08-10-new-city-flow-design.md`
- Review: `docs/superpowers/plans/2026-08-10-new-city-flow.md`

### Steps

- [ ] **Step 1: Update the architecture document with the new startup boundary**

Document exactly:

```text
Browser/WASM startup:
  createWasmBackend
  -> createIndexedDbCitySaveStore
  -> createGameRuntime(activeCity = null)
  -> NewCityScreen
  -> createCity
  -> active game shell

Tauri startup until HPA-344:
  createTauriBackend
  -> createMemoryCitySaveStore (non-durable temporary bridge)
  -> same NewCityScreen/createCity/runtime flow

HPA-344:
  replaces only the Tauri memory-store branch with native application-data persistence
```

Keep HPA-346 ownership of library/Save/Load/Rename/Delete explicit.

- [ ] **Step 2: Run absence/scope scans**

```bash
rg -n 'NewCityEconomyPreset|NewCityTemplateId' src tests
rg -n 'createCity\([\s\S]*sandbox:|sandbox:\s*SANDBOX_REQUEST' src tests/runtime
rg -n 'page\.goto\("/"\)' tests/e2e
```

Expected:

- no duplicate New City domain aliases;
- no current runtime caller using `{ name, sandbox }`;
- e2e root navigation only in the shared bootstrap helper and the dedicated pre-game New City spec.

- [ ] **Step 3: Run full frontend verification**

```bash
bun run test:unit
bun run check
bun run lint
bun run format:check
bun run build
bun run test:e2e
```

Expected: PASS.

- [ ] **Step 4: Run Rust verification**

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
```

Expected: PASS. No Rust production code should have changed in HPA-345.

- [ ] **Step 5: Run native packaging verification**

```bash
bun run tauri:build
```

Expected: PASS with the temporary memory-store bootstrap branch.

- [ ] **Step 6: Self-review the final diff for scope**

Confirm the final implementation contains only:

```text
request narrowing + caller migration
host city-store bootstrap wiring
runtime WorkingSaveError copy
NewCityScreen + App no-city gate
mandatory e2e city bootstrap + one real IndexedDB proof
architecture documentation
```

Reject any added city library, Save/Load, native file store, migration, retry/recovery, or generic persistence/form framework.

- [ ] **Step 7: Commit documentation**

```bash
git add docs/architecture.md
git commit -m "docs: document new city bootstrap flow"
```

## Final implementation review checklist

- [ ] Browser New City uses the real IndexedDB adapter.
- [ ] Tauri New City uses the existing memory store and remains playable within the session; restart durability is intentionally deferred to HPA-344.
- [ ] No IndexedDB-on-Tauri fallback exists.
- [ ] `NewCityRequest` reuses domain unions and contains only player choices.
- [ ] Rust's strict missing/null sandbox-request behavior is unchanged.
- [ ] The real-WASM e2e test compares hidden settings to the pre-game Rust-owned defaults and would fail on TS/Rust drift.
- [ ] `workingSaveErrorMessage` is runtime-owned and diagnostics never reach Svelte copy.
- [ ] The no-city gate and all existing gameplay e2e bootstrap changes land in the same commit.
- [ ] `createDefaultCity` waits unconditionally for the pre-game screen.
- [ ] The dedicated New City smoke reads real IndexedDB by city name/ID.
- [ ] HPA-344 and HPA-346 remain separate.

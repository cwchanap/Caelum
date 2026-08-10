# HPA-345 Minimal Multi-City New City Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a browser player create a named Standard/Creative Blank Grid/Crossroads city through the existing working-save runtime, persist the real Rust/WASM snapshot in IndexedDB before activation, and enter the normal paused game shell.

**Architecture:** Reuse `RuntimePersistenceController.createCity` and the merged IndexedDB `CitySaveStore`; do not add another persistence layer. Narrow `NewCityRequest` to the three player-facing values using existing domain unions, render a dedicated no-city screen from `App.svelte`, wire the browser store in `main.ts`, and make explicit city bootstrap mandatory for every existing gameplay e2e spec. Native Tauri persistence remains HPA-344 rather than using a temporary IndexedDB fallback.

**Tech Stack:** TypeScript 5.8, Svelte 5, Vitest + Testing Library, Playwright/Chromium, Rust/WASM `caelum-core`, browser IndexedDB.

## Global Constraints

- Reuse `EconomyPreset`, `SandboxTemplateId`, and `MoveInRateSelection` from `src/domain/types.ts`; do not declare duplicate New City preset/template aliases.
- The Svelte form collects only city name, Standard/Creative, and Blank Grid/Crossroads.
- Hidden sandbox settings use the current Rust canonical defaults: starting capital `120_000`, demand multiplier `1`, move-in rate `"paused"`.
- UI invokes only `runtime.persistence.createCity`; it never builds snapshots or accesses IndexedDB.
- Preserve storage-first create then candidate-first activation; do not add rollback, pending/finalize, reconciliation, retry loops, or recovery state.
- Do not add Continue/Load, city library, Save Now, Rename, or Delete UI; HPA-346 owns those.
- Do not add native storage or an IndexedDB-on-Tauri fallback; HPA-344 owns native persistence.
- No migrations or backward-compatibility overloads for the old `{ name, sandbox }` internal request.
- No sanitization/security framework; trim and require a non-empty name, then rely on normal Svelte escaping.
- No generic form abstraction, repository/service layer, state machine, DI container, registry, or new dependency.
- The shared e2e `createDefaultCity(page)` bootstrap is required work because existing gameplay specs currently navigate directly to `/` and assume an active game.
- Prefer one non-default economy/template characterization over a full option matrix.

---

## Task 1: Narrow the runtime New City request and migrate every caller

**Files:**
- Modify: `src/runtime/workingSaveRuntime.ts`
- Modify: `tests/runtime/workingSaveRuntime.test.ts`
- Modify: `tests/runtime/citySaveRuntime.test.ts`
- Modify: `tests/runtime/gameRuntime.test.ts` if its current `createCity` setup still uses `{ sandbox }`

**Interfaces:**
- Consumes existing domain types:

```ts
import type {
  EconomyPreset,
  MoveInRateSelection,
  SandboxTemplateId,
} from "../domain/types";
```

- Produces:

```ts
export interface NewCityRequest {
  name: string;
  economyPreset: EconomyPreset;
  templateId: SandboxTemplateId;
}
```

- Keeps:

```ts
RuntimePersistenceController.createCity(
  request: NewCityRequest,
): Promise<WorkingSaveResult<CitySummary>>;
```

- Keeps the existing backend/storage sequence unchanged after request translation.

- [ ] **Step 1: Replace the working-save test request fixture with the player-facing shape**

In `tests/runtime/workingSaveRuntime.test.ts`, replace the backend-shaped New City fixture with:

```ts
const NEW_CITY_REQUEST = {
  name: "New City",
  economyPreset: "standard",
  templateId: "blankGrid",
} as const;
```

Keep `SandboxCreationRequest` imported only for the backend test double that records the translated request.

- [ ] **Step 2: Record translated sandbox requests in the existing backend test double**

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

Inside `createTestBackend`, add:

```ts
const sandboxRequests: SandboxCreationRequest[] = [];
```

Return that array on the test backend, and record requests:

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

- [ ] **Step 3: Write the failing canonical-default translation test**

Add to `working save runtime new cities`:

```ts
it("maps player New City choices to the canonical hidden defaults", async () => {
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

- [ ] **Step 4: Run the focused runtime test and verify the new test fails**

Run:

```bash
bun run test -- tests/runtime/workingSaveRuntime.test.ts
```

Expected: FAIL because `createCity` still expects `{ name, sandbox }` and does not derive the hidden defaults.

- [ ] **Step 5: Reuse the existing domain unions in `workingSaveRuntime.ts`**

Add the type import:

```ts
import type {
  EconomyPreset,
  MoveInRateSelection,
  SandboxTemplateId,
} from "../domain/types";
```

Replace the old request interface with:

```ts
export interface NewCityRequest {
  name: string;
  economyPreset: EconomyPreset;
  templateId: SandboxTemplateId;
}
```

Do not add `NewCityEconomyPreset` or `NewCityTemplateId` aliases.

- [ ] **Step 6: Add typed canonical hidden defaults beside the runtime action**

Immediately after the request interface, add:

```ts
// Mirror `canonical_default_request()` in crates/caelum-core/src/sandbox.rs.
// HPA-345 exposes only economy + template; hidden sandbox tuning stays fixed.
const NEW_CITY_STARTING_CAPITAL = 120_000;
const NEW_CITY_DEMAND_MULTIPLIER = 1;
const NEW_CITY_MOVE_IN_RATE: MoveInRateSelection = "paused";
```

Do not create a settings/config module for these three values.

- [ ] **Step 7: Translate the player request immediately before candidate construction**

Replace:

```ts
const candidate = await host.backend.buildSandboxSnapshot(request.sandbox);
```

with:

```ts
const candidate = await host.backend.buildSandboxSnapshot({
  templateId: request.templateId,
  economyPreset: request.economyPreset,
  startingCapital: NEW_CITY_STARTING_CAPITAL,
  demandMultiplier: NEW_CITY_DEMAND_MULTIPLIER,
  moveInRate: NEW_CITY_MOVE_IN_RATE,
});
```

Do not change the later build -> create -> restore -> install order.

- [ ] **Step 8: Update every working-save New City call to the narrowed request**

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

For a non-default case, spread the player fixture:

```ts
fixture.runtime.controller.createCity({
  ...NEW_CITY_REQUEST,
  economyPreset: "creative",
})
```

Update expected sandbox error context to reference `NEW_CITY_REQUEST.templateId`.

- [ ] **Step 9: Migrate `citySaveRuntime.test.ts` in the same contract-change task**

Find every old call in `tests/runtime/citySaveRuntime.test.ts` and replace the old backend-shaped request:

```ts
{
  name: "...",
  sandbox: SANDBOX_REQUEST,
}
```

with the player-facing form:

```ts
{
  name: "...",
  economyPreset: "standard",
  templateId: "crossroads",
}
```

Preserve each test's existing lifecycle intent; only change request construction unless a specific test characterizes template/economy.

Remove the old `SANDBOX_REQUEST` fixture/import when no longer used.

- [ ] **Step 10: Migrate other current runtime callers before committing**

Run:

```bash
rg -n 'createCity\(|sandbox:' src tests/runtime
```

Inspect every `createCity` call. In particular, update `tests/runtime/gameRuntime.test.ts` if it still passes `{ name, sandbox }`.

Expected after edits: no production/test New City caller passes a `sandbox` field to `RuntimePersistenceController.createCity`.

Do not edit historical docs in this task just to erase examples of superseded designs.

- [ ] **Step 11: Run all directly affected runtime test files**

Run:

```bash
bun run test -- \
  tests/runtime/workingSaveRuntime.test.ts \
  tests/runtime/citySaveRuntime.test.ts \
  tests/runtime/gameRuntime.test.ts
```

Expected: PASS.

- [ ] **Step 12: Run the complete frontend type/unit gate**

Run:

```bash
bun run check
bun run test:unit
```

Expected: PASS. A green `workingSaveRuntime.test.ts` alone is not sufficient for this breaking internal request change.

- [ ] **Step 13: Commit the complete request-contract slice**

```bash
git add \
  src/runtime/workingSaveRuntime.ts \
  tests/runtime/workingSaveRuntime.test.ts \
  tests/runtime/citySaveRuntime.test.ts \
  tests/runtime/gameRuntime.test.ts
git commit -m "feat: narrow new city runtime request"
```

If `tests/runtime/gameRuntime.test.ts` required no edit after the scan, omit it from `git add` rather than touching it unnecessarily.

---

## Task 2: Render the no-city entry screen without an empty-shell flash

**Files:**
- Create: `src/components/NewCityScreen.svelte`
- Modify: `src/App.svelte`
- Modify: `src/styles.css`
- Modify: `tests/ui/appShell.test.ts`

**Interfaces:**
- `NewCityScreen.svelte` consumes:

```ts
interface Props {
  busy: boolean;
  error: WorkingSaveError | null;
  onCreate: (request: NewCityRequest) => void;
}
```

- Local form state reuses:

```ts
EconomyPreset
SandboxTemplateId
```

- App calls only:

```ts
runtime.persistence.createCity(request)
```

- [ ] **Step 1: Make the App test harness persistence state mutable**

In `tests/ui/appShell.test.ts`, extend `createRuntimeHarness` options:

```ts
options: {
  state?: ReturnType<typeof createTestGameState>;
  ui?: ReturnType<typeof createUiState>;
  rejection?: GameplayRejection | null;
  persistence?: Partial<RuntimeSnapshot["persistence"]>;
} = {},
```

Replace the fixed persistence value with:

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

Extend the harness return with:

```ts
setPersistence(next: Partial<RuntimeSnapshot["persistence"]>) {
  persistence = { ...persistence, ...next };
  return publish();
},
```

- [ ] **Step 2: Write the failing initial-null pre-game test**

The component initializes `snapshot` to `null`, so test the initial render explicitly rather than only `activeCity: null`:

```ts
it("treats the unset initial snapshot as pre-game", () => {
  const { runtime } = createRuntimeHarness();

  render(App, { props: { runtime } });

  expect(screen.getByTestId("new-city-screen")).toBeVisible();
  expect(screen.queryByTestId("game-canvas-host")).toBeNull();
  expect(screen.queryByTestId("command-shelf")).toBeNull();
});
```

Because Svelte effects may run during the test renderer lifecycle, if the harness immediately seeds an active snapshot before this assertion, use a focused component/harness variant whose first `getSnapshot()` returns a no-city snapshot. The required behavior remains: `snapshot === null` must select the pre-game branch, never an empty active shell.

- [ ] **Step 3: Write the failing no-active-city shell test**

Add:

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

- [ ] **Step 4: Write the failing form request test**

Add:

```ts
it("submits only name, economy, and template for New City", async () => {
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

- [ ] **Step 5: Write the failing busy/error/transition tests**

Add:

```ts
it("disables New City submission while persistence is busy", async () => {
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

it("shows concise New City errors without adapter diagnostics", () => {
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

it("enters the game shell after the runtime publishes an active city", () => {
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

- [ ] **Step 6: Run the focused App tests and verify the New City cases fail**

Run:

```bash
bun run test -- tests/ui/appShell.test.ts
```

Expected: FAIL because App has no no-city gate or New City screen yet.

- [ ] **Step 7: Create `NewCityScreen.svelte` using existing domain types**

Create `src/components/NewCityScreen.svelte`:

```svelte
<script lang="ts">
  import type {
    EconomyPreset,
    SandboxTemplateId,
  } from "../domain/types";
  import type {
    NewCityRequest,
    WorkingSaveError,
  } from "../runtime/workingSaveRuntime";

  interface Props {
    busy: boolean;
    error: WorkingSaveError | null;
    onCreate: (request: NewCityRequest) => void;
  }

  let { busy, error, onCreate }: Props = $props();
  let name = $state("");
  let economyPreset = $state<EconomyPreset>("standard");
  let templateId = $state<SandboxTemplateId>("crossroads");
  const canCreate = $derived(!busy && name.trim().length > 0);

  function errorMessage(value: WorkingSaveError): string {
    switch (value.kind) {
      case "busy":
        return "City creation is already in progress.";
      case "unavailable":
        return "City storage is unavailable.";
      case "store":
        return "Could not save the new city.";
      case "sandbox":
      case "backend":
        return "Could not create that city setup.";
      case "noActiveCity":
        return "Could not create the new city.";
    }
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    const trimmedName = name.trim();
    if (busy || trimmedName.length === 0) return;
    onCreate({ name: trimmedName, economyPreset, templateId });
  }
</script>

<main class="new-city" data-testid="new-city-screen">
  <form class="new-city__card" onsubmit={submit}>
    <p class="new-city__eyebrow">New City</p>
    <h1>Start a sandbox</h1>

    <label>
      <span>City name</span>
      <input aria-label="City name" bind:value={name} disabled={busy} />
    </label>

    <label>
      <span>Economy</span>
      <select aria-label="Economy" bind:value={economyPreset} disabled={busy}>
        <option value="standard">Standard</option>
        <option value="creative">Creative</option>
      </select>
    </label>

    <label>
      <span>Template</span>
      <select aria-label="Template" bind:value={templateId} disabled={busy}>
        <option value="crossroads">Crossroads</option>
        <option value="blankGrid">Blank Grid</option>
      </select>
    </label>

    {#if error !== null}
      <p class="new-city__error" role="alert">{errorMessage(error)}</p>
    {/if}

    <button type="submit" disabled={!canCreate}>
      {busy ? "Creating…" : "Create City"}
    </button>
  </form>
</main>
```

Keep the markup small. Adjust classes only as needed to follow existing accessibility/lint rules.

- [ ] **Step 8: Add one App handler for the persistence action**

In `src/App.svelte`, import `NewCityScreen` and `NewCityRequest`.

Add:

```ts
async function handleCreateCity(request: NewCityRequest): Promise<void> {
  if (runtime === null) return;
  try {
    await runtime.persistence.createCity(request);
  } catch (err) {
    shellError =
      err instanceof Error ? err.message : "New City command failed";
  }
}
```

Do not access the backend or save store here.

- [ ] **Step 9: Gate both unset snapshot and null active city into pre-game**

Keep the existing fatal error branch first. Inside the live-runtime branch, use the nullish active-city gate:

```svelte
{:else if snapshot?.persistence.activeCity == null}
  <NewCityScreen
    busy={snapshot?.persistence.busy ?? false}
    error={snapshot?.persistence.error ?? null}
    onCreate={(request) => void handleCreateCity(request)}
  />
{:else}
  <main
    class="shell"
    data-testid="game-shell"
    data-command-destination={snapshot.ui.activeCommandDestination ?? "none"}
  >
    <!-- existing active-game shell -->
  </main>
{/if}
```

Do not use `snapshot?.persistence.activeCity === null`; it is false when `snapshot` is still `null` and would select an empty active-game branch on initial render.

After this branch, `snapshot` is non-null by construction; simplify nested `snapshot !== null` guards only when TypeScript/Svelte narrowing permits it cleanly. Do not broadly restructure App.

- [ ] **Step 10: Add minimal Signal Console styling**

In `src/styles.css`, add only the classes used by `NewCityScreen`:

```css
.new-city {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 32px;
  background: var(--bg-deep);
}

.new-city__card {
  width: min(480px, 100%);
  display: grid;
  gap: 20px;
  padding: 28px;
  background: var(--surface);
  border: 1px solid var(--line-strong);
}

.new-city__card label {
  display: grid;
  gap: 8px;
}

.new-city__card input,
.new-city__card select,
.new-city__card button {
  min-height: 44px;
}

.new-city__error {
  color: var(--red);
}
```

Reuse existing typography/button/input rules where available instead of duplicating them. Do not add animations or a new component theme.

- [ ] **Step 11: Run focused UI tests**

Run:

```bash
bun run test -- tests/ui/appShell.test.ts
```

Expected: PASS.

- [ ] **Step 12: Run type/lint/style checks for the new Svelte surface**

Run:

```bash
bun run check
bun run lint:svelte
bun run lint:css
bun run format:check
```

Expected: PASS.

- [ ] **Step 13: Commit the pre-game UI slice**

```bash
git add \
  src/components/NewCityScreen.svelte \
  src/App.svelte \
  src/styles.css \
  tests/ui/appShell.test.ts
git commit -m "feat: add new city entry screen"
```

---

## Task 3: Wire real browser IndexedDB and make city bootstrap mandatory for e2e

**Files:**
- Modify: `src/main.ts`
- Modify: `tests/e2e/helpers.ts`
- Create: `tests/e2e/newCity.spec.ts`
- Modify: `tests/e2e/smoke.spec.ts`
- Modify: `tests/e2e/commandShelf.spec.ts`
- Modify: `tests/e2e/topbarViewport.spec.ts`
- Modify: `tests/e2e/routes.spec.ts`
- Modify: `tests/e2e/roundabouts.spec.ts`

**Interfaces:**
- Browser startup uses:

```ts
createIndexedDbCitySaveStore(): CitySaveStore
```

- Runtime detection reuses:

```ts
isTauriRuntime(): boolean
```

- Required e2e helper:

```ts
export async function createDefaultCity(
  page: Page,
  name?: string,
): Promise<void>;
```

- [ ] **Step 1: Write a failing browser startup/New City e2e test before wiring the store**

Create `tests/e2e/newCity.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { SNAPSHOT_SCHEMA_VERSION } from "../../src/domain/types";
import { runtimeSnapshot } from "./helpers";

test("creates and activates a real Rust/WASM city through browser IndexedDB", async ({
  page,
}) => {
  const cityName = "IndexedDB Junction";
  await page.goto("/");

  await expect(page.getByTestId("new-city-screen")).toBeVisible();
  await page.getByLabel("City name").fill(cityName);
  await page.getByRole("button", { name: "Create City" }).click();

  await expect(page.getByTestId("game-canvas-host")).toBeVisible();

  const runtime = await runtimeSnapshot(page);
  expect(runtime.persistence.activeCity?.name).toBe(cityName);
  expect(runtime.persistence.dirty).toBe(false);
  expect(runtime.persistence.busy).toBe(false);
  const activeId = runtime.persistence.activeCity?.id;
  expect(activeId).toBeDefined();

  const matching = await page.evaluate(
    async ({ expectedName, expectedId }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("caelum-city-saves-v1", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const records = await new Promise<unknown[]>((resolve, reject) => {
        const transaction = database.transaction("cities", "readonly");
        const request = transaction.objectStore("cities").getAll();
        request.onsuccess = () => resolve(request.result as unknown[]);
        request.onerror = () => reject(request.error);
      });
      database.close();

      return records.find((candidate) => {
        const record = candidate as {
          city?: { id?: string; name?: string };
          snapshot?: { schemaVersion?: number };
        };
        return (
          record.city?.name === expectedName && record.city?.id === expectedId
        );
      }) as
        | {
            city?: { id?: string; name?: string };
            snapshot?: { schemaVersion?: number };
          }
        | undefined;
    },
    { expectedName: cityName, expectedId: activeId },
  );

  expect(matching).toBeDefined();
  expect(matching?.snapshot?.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
});
```

This intentionally asserts by matching name/ID rather than `records.length === 1`.

- [ ] **Step 2: Run only the New City e2e and verify it fails before browser store wiring**

Run:

```bash
bunx playwright test tests/e2e/newCity.spec.ts
```

Expected: FAIL because browser startup currently creates the runtime without a `CitySaveStore`, so creation reports storage unavailable.

- [ ] **Step 3: Wire IndexedDB only on the browser/WASM startup path**

In `src/main.ts`, add:

```ts
import { createIndexedDbCitySaveStore } from "./persistence/indexedDbCitySaveStore";
import {
  createBackend,
  isTauriRuntime,
  type GameBackend,
} from "./runtime/backend";
```

Inside `mountApp`, keep backend creation unchanged and add the store boundary:

```ts
const nativeTauri = isTauriRuntime();
let backend = await createBackend();
if (import.meta.env.DEV) {
  backend = installDeferredRoutePreviewHarness(backend);
}

const runtime: RuntimeController = await createGameRuntime({
  backend,
  ...(nativeTauri ? {} : { saveStore: createIndexedDbCitySaveStore() }),
});
```

Do not instantiate IndexedDB on Tauri in this ticket.

- [ ] **Step 4: Re-run the focused real-browser New City proof**

Run:

```bash
bunx playwright test tests/e2e/newCity.spec.ts
```

Expected: PASS. This is the required real Chromium/WASM/IndexedDB integration proof; `fake-indexeddb` is not the evidence for this step.

- [ ] **Step 5: Add the required `createDefaultCity` e2e helper**

In `tests/e2e/helpers.ts`, add:

```ts
export async function createDefaultCity(
  page: Page,
  name = "E2E Default City",
): Promise<void> {
  await page.goto("/");

  const newCity = page.getByTestId("new-city-screen");
  if (await newCity.isVisible()) {
    await page.getByLabel("City name").fill(name);
    await page.getByRole("button", { name: "Create City" }).click();
  }

  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
}
```

The helper includes navigation so existing gameplay tests replace `page.goto("/")` with one call rather than remembering a two-step bootstrap sequence.

Do not call this helper from `newCity.spec.ts`; that test must prove the pre-game screen itself.

- [ ] **Step 6: Replace every current gameplay-start `page.goto("/")` in `smoke.spec.ts`**

Import `createDefaultCity` from `./helpers` and replace:

```ts
await page.goto("/");
```

with:

```ts
await createDefaultCity(page);
```

Leave all gameplay assertions unchanged.

- [ ] **Step 7: Replace every current gameplay-start `page.goto("/")` in `commandShelf.spec.ts`**

Add `createDefaultCity` to the existing helper import and replace every direct root navigation that expects command/game chrome with:

```ts
await createDefaultCity(page);
```

Preserve viewport setup before the helper when a test calls `page.setViewportSize(...)` first.

- [ ] **Step 8: Migrate the remaining current gameplay e2e specs**

Apply the same required bootstrap to:

```text
tests/e2e/topbarViewport.spec.ts
tests/e2e/routes.spec.ts
tests/e2e/roundabouts.spec.ts
```

Each test that expects active gameplay after root navigation must call `createDefaultCity(page)` instead of direct `page.goto("/")`.

- [ ] **Step 9: Scan for remaining direct root navigations and classify every one**

Run:

```bash
rg -n 'page\.goto\("/"\)' tests/e2e
```

Expected: the dedicated `tests/e2e/newCity.spec.ts` direct navigation remains. Any other match must either:

1. be converted to `createDefaultCity(page)` because the test expects gameplay; or
2. explicitly test the pre-game/New City state and therefore remain direct.

Do not leave an active-game test depending on the old anonymous bootstrap.

- [ ] **Step 10: Run the affected gameplay e2e files together**

Run:

```bash
bunx playwright test \
  tests/e2e/newCity.spec.ts \
  tests/e2e/smoke.spec.ts \
  tests/e2e/commandShelf.spec.ts \
  tests/e2e/topbarViewport.spec.ts \
  tests/e2e/routes.spec.ts \
  tests/e2e/roundabouts.spec.ts
```

Expected: PASS.

- [ ] **Step 11: Run the complete e2e suite before calling Task 3 green**

Run:

```bash
bun run test:e2e
```

Expected: PASS. The Task 3 e2e bootstrap work is mandatory; do not defer helper/call-site migration after the new test passes.

- [ ] **Step 12: Run browser build/type checks after bootstrap wiring**

Run:

```bash
bun run check
bun run build
```

Expected: PASS.

- [ ] **Step 13: Commit the browser integration plus complete e2e bootstrap migration**

```bash
git add \
  src/main.ts \
  tests/e2e/helpers.ts \
  tests/e2e/newCity.spec.ts \
  tests/e2e/smoke.spec.ts \
  tests/e2e/commandShelf.spec.ts \
  tests/e2e/topbarViewport.spec.ts \
  tests/e2e/routes.spec.ts \
  tests/e2e/roundabouts.spec.ts
git commit -m "feat: wire browser new city persistence"
```

---

## Task 4: Align architecture docs and run the full verification gate

**Files:**
- Modify: `docs/architecture.md`
- Verify: all Task 1-3 files

**Interfaces:** None. This task records the delivered boundary and proves the branch as a whole.

- [ ] **Step 1: Update architecture documentation with the delivered New City boundary**

Add a concise HPA-345 section to `docs/architecture.md` covering exactly:

```text
No active city
  -> NewCityScreen
  -> RuntimePersistenceController.createCity({ name, economyPreset, templateId })
  -> GameBackend.buildSandboxSnapshot(canonical hidden defaults)
  -> browser CitySaveStore.createCity(record)
  -> GameBackend.restoreSnapshot(candidate)
  -> runtime installs gameplay and publishes activeCity
```

Record that browser startup uses `IndexedDbCitySaveStore` while native storage still belongs to HPA-344.

Record that existing gameplay e2e tests explicitly create a default city before interacting with the game shell.

Do not document HPA-346 city-library UI as implemented.

- [ ] **Step 2: Run a stale request-shape scan**

Run:

```bash
rg -n 'createCity\(|sandbox:' src tests/runtime
```

Expected: no current `RuntimePersistenceController.createCity` call passes a `sandbox` property. Backend `SandboxCreationRequest` usage is still valid and must not be removed.

- [ ] **Step 3: Run the e2e bootstrap scan**

Run:

```bash
rg -n 'page\.goto\("/"\)' tests/e2e
```

Expected: only tests intentionally proving pre-game state use direct root navigation; all active-game specs bootstrap through `createDefaultCity(page)`.

- [ ] **Step 4: Run full frontend unit tests**

Run:

```bash
bun run test:unit
```

Expected: PASS.

- [ ] **Step 5: Run Rust tests to protect the canonical sandbox/backend boundary**

Run:

```bash
cargo test --workspace
```

Expected: PASS.

- [ ] **Step 6: Run static verification**

Run:

```bash
bun run check
bun run lint
bun run format:check
```

Expected: PASS.

- [ ] **Step 7: Run production build**

Run:

```bash
bun run build
```

Expected: PASS.

- [ ] **Step 8: Run the complete Chromium suite one final time**

Run:

```bash
bun run test:e2e
```

Expected: PASS, including the real browser New City/IndexedDB proof and every existing gameplay spec using explicit city bootstrap.

- [ ] **Step 9: Review the final diff for scope**

Run:

```bash
git diff --stat main...HEAD
git diff main...HEAD -- \
  src/runtime/workingSaveRuntime.ts \
  src/components/NewCityScreen.svelte \
  src/App.svelte \
  src/main.ts \
  tests/runtime \
  tests/ui/appShell.test.ts \
  tests/e2e \
  docs/architecture.md
```

Confirm the branch does not add:

```text
city library / Continue / Load UI
Save Now / Rename / Delete UI
Tauri filesystem persistence
IndexedDB-on-Tauri fallback
retry/recovery/reconciliation
migrations or legacy readers
new security framework
new persistence/form/service abstraction
new dependency
```

- [ ] **Step 10: Commit architecture documentation**

```bash
git add docs/architecture.md
git commit -m "docs: document new city browser flow"
```

---

## Final self-review checklist

Before implementation is considered complete:

- [ ] `NewCityRequest` reuses `EconomyPreset` and `SandboxTemplateId` from `src/domain/types.ts`.
- [ ] The fixed move-in default is typed as `MoveInRateSelection`.
- [ ] `tests/runtime/workingSaveRuntime.test.ts`, `tests/runtime/citySaveRuntime.test.ts`, and every other old-shape runtime caller were migrated in Task 1.
- [ ] No compatibility overload preserves `{ name, sandbox }`.
- [ ] `snapshot === null` cannot select an empty active-game shell.
- [ ] `activeCity === null` renders `NewCityScreen`.
- [ ] New City form exposes only name/economy/template.
- [ ] Hidden values are `120_000`, `1`, and `"paused"`.
- [ ] Browser startup uses `createIndexedDbCitySaveStore()`.
- [ ] Tauri does not receive IndexedDB storage.
- [ ] `tests/e2e/helpers.ts` contains required `createDefaultCity(page)`.
- [ ] Every existing gameplay e2e root navigation uses the shared city bootstrap.
- [ ] The dedicated New City e2e proves a matching named/ID record exists in real browser IndexedDB and contains the current snapshot schema.
- [ ] Full unit, Rust, type, lint, format, build, and e2e gates pass.
- [ ] HPA-344 and HPA-346 scope remains untouched.

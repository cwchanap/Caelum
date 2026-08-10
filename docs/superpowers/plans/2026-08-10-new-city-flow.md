# HPA-345 Minimal Multi-City New City Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a browser player create a named Standard/Creative Blank Grid/Crossroads city through the existing working-save runtime, persist the real Rust/WASM snapshot in IndexedDB before activation, and enter the normal paused game shell.

**Architecture:** Reuse `RuntimePersistenceController.createCity` and the merged IndexedDB `CitySaveStore`; do not add another persistence layer. Narrow `NewCityRequest` to the three player-facing values, render a dedicated no-city screen from `App.svelte`, and wire the browser store in `main.ts`. Native Tauri persistence remains HPA-344 rather than using a temporary IndexedDB fallback.

**Tech Stack:** TypeScript 5.8, Svelte 5, Vitest + Testing Library, Playwright/Chromium, Rust/WASM `caelum-core`, browser IndexedDB.

## Global Constraints

- The Svelte form collects only city name, Standard/Creative, and Blank Grid/Crossroads.
- Hidden sandbox settings use the current Rust canonical defaults: starting capital `120_000`, demand multiplier `1`, move-in rate `"paused"`.
- UI invokes only `runtime.persistence.createCity`; it never builds snapshots or accesses IndexedDB.
- Preserve storage-first create then candidate-first activation; do not add rollback, pending/finalize, reconciliation, retry loops, or recovery state.
- Do not add Continue/Load, city library, Save Now, Rename, or Delete UI; HPA-346 owns those.
- Do not add native storage or an IndexedDB-on-Tauri fallback; HPA-344 owns native persistence.
- No migrations or backward-compatibility adapters for development saves.
- No sanitization/security framework; trim and require a non-empty name, then rely on normal Svelte escaping.
- No generic form abstraction, repository/service layer, state machine, DI container, registry, or new dependency.
- Prefer characterization of one non-default option combination over a full economy/template test matrix.

---

## Task 1: Narrow the runtime New City action to player-facing inputs

**Files:**
- Modify: `src/runtime/workingSaveRuntime.ts:20-33,214-251`
- Modify: `tests/runtime/workingSaveRuntime.test.ts:1-180` and the `working save runtime new cities` describe block

**Interfaces:**
- Consumes: existing `GameBackend.buildSandboxSnapshot(SandboxCreationRequest)` and `CitySaveStore.createCity(CitySaveRecord)`.
- Produces:

```ts
export type NewCityEconomyPreset = "standard" | "creative";
export type NewCityTemplateId = "blankGrid" | "crossroads";

export interface NewCityRequest {
  name: string;
  economyPreset: NewCityEconomyPreset;
  templateId: NewCityTemplateId;
}
```

- `RuntimePersistenceController.createCity(request)` keeps the same method name/result type, so `createGameRuntime` and future HPA-346 work keep one persistence API.

- [ ] **Step 1: Replace the test request fixture with the player-facing request**

In `tests/runtime/workingSaveRuntime.test.ts`, replace the current `SANDBOX_REQUEST` fixture with:

```ts
const NEW_CITY_REQUEST = {
  name: "New City",
  economyPreset: "standard",
  templateId: "blankGrid",
} as const;
```

Remove `SandboxCreationRequest` from the fixture import only if it is no longer needed elsewhere after the next step.

- [ ] **Step 2: Capture backend sandbox requests in the existing test backend**

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

return it with the backend, and record every candidate request:

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

Add this first test to the `working save runtime new cities` block:

```ts
it("maps the player New City choices to the canonical sandbox defaults", async () => {
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

- [ ] **Step 4: Run the focused runtime test and verify it fails at the old request shape**

Run:

```bash
bun run test -- tests/runtime/workingSaveRuntime.test.ts
```

Expected: FAIL because `createCity` still expects `{ name, sandbox }` and does not derive canonical hidden settings.

- [ ] **Step 5: Narrow `NewCityRequest` and add the local canonical request builder**

In `src/runtime/workingSaveRuntime.ts`, replace the current request shape with:

```ts
export type NewCityEconomyPreset = "standard" | "creative";
export type NewCityTemplateId = "blankGrid" | "crossroads";

export interface NewCityRequest {
  name: string;
  economyPreset: NewCityEconomyPreset;
  templateId: NewCityTemplateId;
}

const NEW_CITY_STARTING_CAPITAL = 120_000;
const NEW_CITY_DEMAND_MULTIPLIER = 1;
const NEW_CITY_MOVE_IN_RATE = "paused";
```

Keep these constants in this module instead of creating a settings/config module. Add a comment immediately above them:

```ts
// Mirror `canonical_default_request()` in crates/caelum-core/src/sandbox.rs.
// HPA-345 exposes only economy + template; hidden sandbox tuning stays fixed.
```

- [ ] **Step 6: Build the backend candidate from the three-field request**

Replace:

```ts
const candidate = await host.backend.buildSandboxSnapshot(
  request.sandbox,
);
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

Do not change the subsequent build -> create -> restore -> install order.

- [ ] **Step 7: Update existing New City lifecycle tests to the narrowed request**

For every current call shaped like:

```ts
fixture.runtime.controller.createCity({
  name: "New City",
  sandbox: SANDBOX_REQUEST,
})
```

use:

```ts
fixture.runtime.controller.createCity(NEW_CITY_REQUEST)
```

For tests that need a different template/economy, spread the fixture explicitly:

```ts
fixture.runtime.controller.createCity({
  ...NEW_CITY_REQUEST,
  economyPreset: "creative",
})
```

When constructing the expected sandbox error context, use `NEW_CITY_REQUEST.templateId` rather than the removed backend request fixture.

- [ ] **Step 8: Run the full working-save runtime suite**

Run:

```bash
bun run test -- tests/runtime/workingSaveRuntime.test.ts
```

Expected: PASS, including existing create order, conflict, store failure, activation failure, busy-gate, and disposal tests.

- [ ] **Step 9: Type-check the contract change**

Run:

```bash
bun run check
```

Expected: PASS. If a remaining test caller uses the removed `{ sandbox }` field, update that caller to the three player fields in the same change; do not add a compatibility overload.

- [ ] **Step 10: Commit the runtime contract slice**

```bash
git add src/runtime/workingSaveRuntime.ts tests/runtime/workingSaveRuntime.test.ts
git commit -m "feat: narrow new city runtime request"
```

---

## Task 2: Render a focused no-city entry screen and wire it to the runtime

**Files:**
- Create: `src/components/NewCityScreen.svelte`
- Modify: `src/App.svelte:1-430`
- Modify: `src/styles.css` after the shell/grid section
- Modify: `tests/ui/appShell.test.ts:1-180` and add focused New City cases in the same describe suite

**Interfaces:**
- Consumes:

```ts
NewCityRequest
WorkingSaveError
RuntimeSnapshot["persistence"]
RuntimeController["persistence"]["createCity"]
```

- Produces a presentational screen with:

```ts
interface Props {
  busy: boolean;
  error: WorkingSaveError | null;
  onCreate: (request: NewCityRequest) => void;
}
```

No store/backend object crosses into the component.

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

Replace the current `const persistence = ... as const` with mutable state:

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

Extend the harness return type and returned object with:

```ts
setPersistence(next: Partial<RuntimeSnapshot["persistence"]>) {
  persistence = { ...persistence, ...next };
  return publish();
},
```

so tests can emulate the runtime publications that `workingSaveRuntime` already performs.

- [ ] **Step 2: Write the failing no-city shell test**

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

- [ ] **Step 3: Write the failing form validation/request test**

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

- [ ] **Step 4: Write the failing busy/error/success transition tests**

Add three focused cases:

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

it("shows concise New City errors without diagnostics", () => {
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

it("enters the normal game shell after the runtime publishes an active city", () => {
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

- [ ] **Step 5: Run the focused App tests and verify the new cases fail**

Run:

```bash
bun run test -- tests/ui/appShell.test.ts
```

Expected: FAIL because `App.svelte` has no no-city gate or New City form yet.

- [ ] **Step 6: Create `NewCityScreen.svelte`**

Create `src/components/NewCityScreen.svelte` with this implementation shape:

```svelte
<script lang="ts">
  import type {
    NewCityEconomyPreset,
    NewCityRequest,
    NewCityTemplateId,
    WorkingSaveError,
  } from "../runtime/workingSaveRuntime";

  interface Props {
    busy: boolean;
    error: WorkingSaveError | null;
    onCreate: (request: NewCityRequest) => void;
  }

  let { busy, error, onCreate }: Props = $props();
  let name = $state("");
  let economyPreset = $state<NewCityEconomyPreset>("standard");
  let templateId = $state<NewCityTemplateId>("crossroads");
  const canCreate = $derived(!busy && name.trim().length > 0);

  function errorMessage(value: WorkingSaveError): string {
    if (value.kind === "busy") return "City creation is already in progress.";
    if (value.kind === "sandbox") return "Could not create that city setup.";
    if (value.kind === "backend") return "Could not open the new city.";
    if (value.kind === "unavailable") {
      return "City saves are not available in this build yet.";
    }
    if (value.kind === "store") {
      return value.error.code === "conflict"
        ? "That city slot could not be created. Try again."
        : "Could not save the new city.";
    }
    return "Could not create the city.";
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (!canCreate) return;
    onCreate({
      name: name.trim(),
      economyPreset,
      templateId,
    });
  }
</script>

<main class="new-city-screen" data-testid="new-city-screen">
  <section class="new-city-card" aria-labelledby="new-city-title">
    <p class="new-city-kicker">Caelum // Local City</p>
    <h1 id="new-city-title">New City</h1>
    <p class="new-city-copy">Create a local sandbox city to start building.</p>

    <form class="new-city-form" onsubmit={submit}>
      <label>
        <span>City name</span>
        <input bind:value={name} name="cityName" autocomplete="off" />
      </label>

      <label>
        <span>Economy</span>
        <select bind:value={economyPreset} name="economy">
          <option value="standard">Standard</option>
          <option value="creative">Creative</option>
        </select>
      </label>

      <label>
        <span>Template</span>
        <select bind:value={templateId} name="template">
          <option value="crossroads">Crossroads</option>
          <option value="blankGrid">Blank Grid</option>
        </select>
      </label>

      <button type="submit" disabled={!canCreate}>
        {busy ? "Creating…" : "Create City"}
      </button>
    </form>

    {#if error !== null}
      <p class="new-city-error" role="alert">{errorMessage(error)}</p>
    {/if}
  </section>
</main>
```

Do not add local storage, runtime imports other than types, or extra settings fields.

- [ ] **Step 7: Add the no-city rendering gate to `App.svelte`**

At the top, import:

```ts
import NewCityScreen from "./components/NewCityScreen.svelte";
import type { NewCityRequest } from "./runtime/workingSaveRuntime";
```

Add:

```ts
function handleCreateCity(request: NewCityRequest): void {
  if (runtime === null) return;
  void runtime.persistence.createCity(request);
}
```

Change the top-level template branch from:

```svelte
{#if shellError || runtime === null}
  ...
{:else}
  <main class="shell" ...>
```

into:

```svelte
{#if shellError || runtime === null}
  <main class="shell" data-testid="game-shell">
    <!-- keep the current fatal shell error unchanged -->
  </main>
{:else if snapshot?.persistence.activeCity === null}
  <NewCityScreen
    busy={snapshot.persistence.busy}
    error={snapshot.persistence.error}
    onCreate={handleCreateCity}
  />
{:else}
  <main class="shell" data-testid="game-shell" ...>
    <!-- keep the current active-game shell unchanged -->
  </main>
{/if}
```

Do not put New City inside `CityPanel.svelte` or render game chrome behind the form.

- [ ] **Step 8: Add minimal entry-screen CSS using existing tokens**

In `src/styles.css`, immediately after `.shell`, add:

```css
.new-city-screen {
  display: grid;
  place-items: center;
  width: 100vw;
  height: 100vh;
  padding: 48px;
  background-size: 32px 32px;
}

.new-city-card {
  width: min(520px, 100%);
  padding: 32px;
  background: var(--surface);
  border: 1px solid var(--line-strong);
}

.new-city-kicker {
  margin: 0 0 8px;
  color: var(--cyan);
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.new-city-card h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 36px;
}

.new-city-copy {
  margin: 8px 0 24px;
  color: var(--ink-mid);
}

.new-city-form {
  display: grid;
  gap: 16px;
}

.new-city-form label {
  display: grid;
  gap: 6px;
  color: var(--ink-mid);
  font-size: 12px;
}

.new-city-form input,
.new-city-form select,
.new-city-form button {
  min-height: 42px;
  border: 1px solid var(--line-strong);
  background: var(--surface-sunk);
  color: var(--ink);
  font: inherit;
}

.new-city-form input,
.new-city-form select {
  padding: 0 12px;
}

.new-city-form button {
  margin-top: 8px;
  cursor: pointer;
  color: var(--bg-deep);
  background: var(--amber);
  font-weight: 700;
}

.new-city-form button:disabled {
  cursor: default;
  opacity: 0.45;
}

.new-city-error {
  margin: 16px 0 0;
  color: var(--red);
  font-size: 12px;
}
```

If stylelint rejects an existing-project convention, adjust only syntax/order needed for the current stylesheet; do not introduce a component styling system.

- [ ] **Step 9: Run UI tests**

Run:

```bash
bun run test -- tests/ui/appShell.test.ts
```

Expected: PASS.

- [ ] **Step 10: Run Svelte/TypeScript and CSS checks**

Run:

```bash
bun run check
bun run lint:svelte
bun run lint:css
```

Expected: PASS.

- [ ] **Step 11: Commit the UI slice**

```bash
git add src/components/NewCityScreen.svelte src/App.svelte src/styles.css tests/ui/appShell.test.ts
git commit -m "feat: add new city entry screen"
```

---

## Task 3: Wire the real browser IndexedDB store and prove the Rust/WASM path in Chromium

**Files:**
- Modify: `src/main.ts:1-80`
- Create: `tests/e2e/newCity.spec.ts`

**Interfaces:**
- Consumes `createIndexedDbCitySaveStore(): CitySaveStore` and `isTauriRuntime()`.
- Produces browser bootstrap with a real `saveStore`; native bootstrap deliberately keeps `saveStore` undefined until HPA-344.

- [ ] **Step 1: Write the Chromium New City smoke test first**

Create `tests/e2e/newCity.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { runtimeSnapshot } from "./helpers";

test("creates a real Rust/WASM city through browser IndexedDB", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByTestId("new-city-screen")).toBeVisible();
  await expect(page.getByTestId("game-canvas-host")).toHaveCount(0);

  await page.getByLabel("City name").fill("E2E Creative Grid");
  await page.getByLabel("Economy").selectOption("creative");
  await page.getByLabel("Template").selectOption("blankGrid");
  await page.getByRole("button", { name: "Create City" }).click();

  await expect(page.getByTestId("game-canvas-host")).toBeVisible();

  const live = await runtimeSnapshot(page);
  expect(live.persistence.activeCity?.name).toBe("E2E Creative Grid");
  expect(live.persistence.busy).toBe(false);
  expect(live.persistence.dirty).toBe(false);
  expect(live.state.paused).toBe(true);
  expect(live.state.rules.economyPreset).toBe("creative");
  expect(live.state.rules.sandbox.templateId).toBe("blankGrid");

  const records = await page.evaluate(
    () =>
      new Promise<unknown[]>((resolve, reject) => {
        const open = indexedDB.open("caelum-city-saves-v1", 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          const transaction = database.transaction("cities", "readonly");
          const request = transaction.objectStore("cities").getAll();
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        };
      }),
  );

  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    city: { name: "E2E Creative Grid" },
    snapshot: {
      schemaVersion: live.state.schemaVersion,
      paused: true,
      rules: {
        economyPreset: "creative",
        sandbox: { templateId: "blankGrid" },
      },
    },
  });
});
```

This direct IndexedDB read exists only in e2e test code. Production UI/runtime must continue using `CitySaveStore`.

- [ ] **Step 2: Run the new e2e test and verify it fails before store wiring**

Run:

```bash
bun run test:e2e -- tests/e2e/newCity.spec.ts
```

Expected: FAIL after clicking Create City because browser runtime currently has no `saveStore`, so no record can be created/activated.

- [ ] **Step 3: Wire the IndexedDB store only for the browser host**

In `src/main.ts`, update imports:

```ts
import {
  createBackend,
  isTauriRuntime,
  type GameBackend,
} from "./runtime/backend";
import { createIndexedDbCitySaveStore } from "./persistence/indexedDbCitySaveStore";
```

Inside `mountApp()`, after backend creation and before `createGameRuntime`, add:

```ts
const saveStore = isTauriRuntime()
  ? undefined
  : createIndexedDbCitySaveStore();
```

Then replace:

```ts
const runtime: RuntimeController = await createGameRuntime({ backend });
```

with:

```ts
const runtime: RuntimeController = await createGameRuntime({
  backend,
  saveStore,
});
```

Do not change `createBackend` host selection and do not instantiate the browser store on the Tauri branch.

- [ ] **Step 4: Run the Chromium smoke again**

Run:

```bash
bun run test:e2e -- tests/e2e/newCity.spec.ts
```

Expected: PASS. The test demonstrates an actual Rust/WASM candidate was accepted by structured clone, committed to real browser IndexedDB, activated, and published as the active clean city.

- [ ] **Step 5: Run nearby browser runtime/e2e regression tests**

Run:

```bash
bun run test -- tests/runtime/indexedDbCitySaveStore.test.ts tests/runtime/gameRuntime.test.ts
bun run test:e2e
```

Expected: PASS. Existing e2e tests that previously assumed immediate game-shell startup will now need to create a city first if they use the real `main.ts` bootstrap.

For those tests, add one small helper to `tests/e2e/helpers.ts` only if more than one spec needs the same setup:

```ts
export async function createDefaultCity(
  page: Page,
  name = "E2E City",
): Promise<void> {
  if ((await page.getByTestId("new-city-screen").count()) === 0) return;
  await page.getByLabel("City name").fill(name);
  await page.getByRole("button", { name: "Create City" }).click();
  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
}
```

Call it immediately after `page.goto("/")` in existing gameplay specs. Do not bypass the UI by mutating IndexedDB or `window.__caelumRuntime` to seed an active city.

- [ ] **Step 6: Commit the browser wiring/e2e slice**

```bash
git add src/main.ts tests/e2e/newCity.spec.ts tests/e2e/helpers.ts tests/e2e
git commit -m "feat: persist new browser cities in indexeddb"
```

The broad `tests/e2e` add is intentional only because existing gameplay specs may require the shared `createDefaultCity` call after the no-city startup change; inspect `git diff --cached` before committing and ensure there are no unrelated test edits.

---

## Task 4: Update architecture notes and run full verification

**Files:**
- Modify: `docs/architecture.md` in the runtime/persistence section
- Verify all files changed in Tasks 1-3

**Interfaces:**
- Documentation records the implemented boundary only; it must not promise HPA-344/HPA-346 behavior as already available.

- [ ] **Step 1: Document the no-city and browser-store boundary**

Add a concise subsection to `docs/architecture.md` near the current runtime/persistence discussion:

```markdown
### New City entry and local browser persistence

`App.svelte` treats `RuntimeSnapshot.persistence.activeCity === null` as the
pre-game New City state. The entry form submits only city name, economy preset,
and sandbox template to `RuntimePersistenceController.createCity`; the working-
save runtime supplies the fixed canonical sandbox defaults, builds a pure Rust
candidate, persists it, then activates it.

Browser/WASM bootstrap injects `createIndexedDbCitySaveStore()` into
`createGameRuntime`. Native Tauri persistence is intentionally not backed by
IndexedDB; HPA-344 supplies the native `CitySaveStore` behind the same runtime
contract. Continue/Load and working-save city-library controls remain HPA-346.
```

Do not add a diagram or architecture layer for this one path.

- [ ] **Step 2: Run formatting**

Run:

```bash
bun run format
```

Expected: Prettier and Rust formatting complete without semantic changes.

- [ ] **Step 3: Run the complete TypeScript/Svelte/Rust validation suite**

Run:

```bash
bun run check
bun run lint
bun run test
bun run rust:test
bun run build
```

Expected: all PASS.

- [ ] **Step 4: Run the complete Chromium suite one final time after build-facing changes**

Run:

```bash
bun run test:e2e
```

Expected: PASS in the configured Chromium project.

- [ ] **Step 5: Confirm the implementation remains within HPA-345 scope**

Run:

```bash
git diff --stat main...HEAD
git diff --name-only main...HEAD
```

Expected production surface is limited to:

```text
src/runtime/workingSaveRuntime.ts
src/components/NewCityScreen.svelte
src/App.svelte
src/main.ts
src/styles.css
```

plus focused tests, `tests/e2e/helpers.ts` only if shared setup became necessary, and `docs/architecture.md`.

There should be no new Tauri storage code, city-library UI, autosave/recovery modules, migration code, or persistence abstractions.

- [ ] **Step 6: Commit documentation/verification cleanup**

```bash
git add docs/architecture.md
git commit -m "docs: document new city persistence flow"
```

If `bun run format` changed files already committed in Tasks 1-3, include only those formatting-only edits with this commit after verifying the diff is non-semantic.

---

## Self-review checklist

Before marking HPA-345 implementation ready for review, verify all of these are true:

- [ ] The Svelte component has exactly three player choices: name, economy, template.
- [ ] Hidden sandbox defaults live outside Svelte and match Rust canonical defaults (`120_000`, `1`, `paused`).
- [ ] `workingSaveRuntime.createCity` still runs build -> create -> restore -> install in that order.
- [ ] No compatibility overload for the old `{ name, sandbox }` request remains.
- [ ] No active city means no gameplay chrome is rendered.
- [ ] Busy state disables the Create button and runtime busy gate remains authoritative.
- [ ] Player errors are concise and never include `diagnostic` text.
- [ ] Browser bootstrap injects the real IndexedDB store.
- [ ] Tauri bootstrap does not use IndexedDB as a fallback.
- [ ] Chromium proves the actual Rust/WASM snapshot exists in real IndexedDB and the active runtime is clean/paused afterward.
- [ ] Existing gameplay e2e tests enter through New City rather than bypassing the player flow.
- [ ] No Save/Load/Rename/Delete/city-library UI slipped into this ticket.
- [ ] No migration, retry, recovery, security, manager/service, or state-machine framework was introduced.
- [ ] `bun run check`, `bun run lint`, `bun run test`, `bun run rust:test`, `bun run build`, and `bun run test:e2e` all pass.

## Implementation handoff

Plan complete at `docs/superpowers/plans/2026-08-10-new-city-flow.md`.

Recommended execution mode: **subagent-driven development**, one task at a time with review gates, because the four tasks are independently testable and the browser bootstrap change may require small mechanical updates across existing e2e specs. Inline execution with `superpowers:executing-plans` is also valid.
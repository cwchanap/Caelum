# HPA-345 Minimal Multi-City New City Flow Design

## Decision

HPA-345 is the next player-visible Phase 1 persistence slice.

The prerequisites that matter for the browser flow are already present on `main`:

- HPA-543 provides one active city, one persistence busy gate, dirty tracking, storage-first `createCity`, and candidate-first activation in `src/runtime/workingSaveRuntime.ts`.
- HPA-343 provides the browser `CitySaveStore` implementation in `src/persistence/indexedDbCitySaveStore.ts`.
- `createGameRuntime` already exposes the working-save controller as `runtime.persistence` and prevents gameplay mutation while persistence is busy.

HPA-344 remains a required sibling for native Tauri persistence, but it does not block the first browser New City slice. This ticket must not introduce a temporary IndexedDB-on-Tauri fallback; HPA-344 will later provide the native `CitySaveStore` behind the same runtime/UI contract.

The implementation therefore stays narrow: expose a no-city entry screen, reduce the New City runtime request to the three player-facing choices, wire the real IndexedDB store into browser bootstrap, and prove the full browser/WASM/IndexedDB path once in Chromium.

## Goals

A browser player starting with no active city can:

1. name a city;
2. choose Standard or Creative economy;
3. choose Blank Grid or Crossroads;
4. create the city through the existing runtime persistence action;
5. enter the resulting paused, clean city only after its record was stored successfully.

The implementation must preserve the current persistence guarantees:

- candidate construction happens before storage and does not mutate active gameplay;
- `createCity` is create-only and cannot overwrite another city ID;
- storage succeeds before activation;
- definite candidate/store/restore failures do not replace current gameplay;
- an activation failure after storage leaves the new record in persistence for a future Load retry;
- duplicate/conflicting persistence actions are rejected by the existing single busy gate.

## Non-goals

This ticket does **not** add:

- Continue or Load City UI;
- a city library/list;
- Save Now, Rename, or Delete controls;
- native Tauri save files;
- autosave, checkpoints, recovery, pending/finalize records, retries, reconciliation, or rollback machinery;
- schema migrations or compatibility handling for old development saves;
- advanced sandbox settings;
- security/sanitization frameworks;
- a generic form, persistence service, repository abstraction, state machine, DI layer, or host registry.

HPA-346 owns the city library and working-save controls. HPA-344 owns the native file adapter. HPA-349 owns the eventual shared browser/native smoke test.

## Existing foundation to reuse

### Working-save runtime

`src/runtime/workingSaveRuntime.ts` already owns the important mutation order:

```text
await gameplay idle
  -> backend.buildSandboxSnapshot(...)
  -> saveStore.createCity(...)
  -> backend.restoreSnapshot(candidate)
  -> installRestoredGameplay(candidate)
  -> publish active city + clean state
```

The UI must not duplicate or partially reimplement this sequence.

The only runtime-contract change required by HPA-345 is to make `NewCityRequest` describe the actual player action rather than expose hidden sandbox knobs. The current shape:

```ts
interface NewCityRequest {
  name: string;
  sandbox: SandboxCreationRequest;
}
```

will become:

```ts
export type NewCityEconomyPreset = "standard" | "creative";
export type NewCityTemplateId = "blankGrid" | "crossroads";

export interface NewCityRequest {
  name: string;
  economyPreset: NewCityEconomyPreset;
  templateId: NewCityTemplateId;
}
```

`workingSaveRuntime` will translate those three values to the existing core request using the current canonical defaults:

```ts
{
  templateId: request.templateId,
  economyPreset: request.economyPreset,
  startingCapital: 120_000,
  demandMultiplier: 1,
  moveInRate: "paused",
}
```

These values mirror `canonical_default_request()` in `crates/caelum-core/src/sandbox.rs`. Keeping this translation beside persistence orchestration prevents Svelte components from knowing backend-only settings. Adding a new Rust/host API solely to fetch these constants is unnecessary for this phase.

### Runtime shell

`src/runtime/createGameRuntime.ts` already:

- accepts `saveStore?: CitySaveStore`;
- injects ID/time generation into working-save runtime;
- exposes `runtime.persistence.createCity(...)`;
- publishes `snapshot.persistence.activeCity`, `busy`, `dirty`, and `error`;
- installs a restored snapshot by resetting transient UI/preview state;
- blocks gameplay mutation while persistence is busy.

No new persistence coordinator or runtime service is needed.

### Browser store

`src/persistence/indexedDbCitySaveStore.ts` already exports:

```ts
createIndexedDbCitySaveStore(): CitySaveStore
```

with the development database `caelum-city-saves-v1` and one `cities` object store. Browser bootstrap can use it directly.

## UI architecture

### 1. Top-level no-city gate

`App.svelte` will treat `snapshot.persistence.activeCity === null` as a pre-game state.

Rendering order becomes:

```text
fatal/bootstrap error
  -> no active city: NewCityScreen
  -> active city: existing Topbar + Canvas + panels + CommandShelf
```

This is intentionally a rendering gate, not a new application state machine. The anonymous backend snapshot may exist underneath during bootstrap, but the player does not see or mutate it as a city. Successful `runtime.persistence.createCity()` publishes a non-null active city, and the existing gameplay shell then renders automatically.

While the no-city screen is visible:

- do not render `Topbar`, `GameCanvas`, `CommandShelf`, or command panels;
- do not add keyboard shortcuts for city creation;
- the runtime may remain mounted/subscribed; the existing persistence busy gate protects the operation.

### 2. Focused `NewCityScreen.svelte`

Create `src/components/NewCityScreen.svelte` with only these local fields:

```ts
name: string
economyPreset: "standard" | "creative"
templateId: "blankGrid" | "crossroads"
```

Defaults:

- name: empty;
- economy: `standard`;
- template: `crossroads`.

The component receives:

```ts
interface Props {
  busy: boolean;
  error: WorkingSaveError | null;
  onCreate: (request: NewCityRequest) => void;
}
```

The form trims the city name and requires a non-empty result. No arbitrary maximum length, regex, sanitization framework, or hostile-input validation is introduced in this phase. Svelte escaping is sufficient for display.

On submit, call exactly once:

```ts
onCreate({
  name: name.trim(),
  economyPreset,
  templateId,
});
```

Disable the submit button while `busy` or while the trimmed name is empty. Runtime-level busy rejection remains authoritative; the disabled state is only the user-facing duplicate-submit guard.

### 3. Concise failure copy

The screen may map the small runtime error union to player-facing copy, but it must not expose diagnostic strings or parse adapter/backend internals.

Recommended copy:

| Runtime error | UI copy |
| --- | --- |
| `busy` | `City creation is already in progress.` |
| store `conflict` | `That city slot could not be created. Try again.` |
| `sandbox` | `Could not create that city setup.` |
| `store` | `Could not save the new city.` |
| `backend` | `Could not open the new city.` |
| `unavailable` | `City saves are not available in this build yet.` |
| fallback | `Could not create the city.` |

Do not display `diagnostic`, filesystem/database details, raw error codes, or a recovery workflow.

The `unavailable` copy is useful for the temporary native-development gap before HPA-344. Do not solve that gap with a second persistence implementation in this ticket.

## App-to-runtime interaction

`App.svelte` owns the asynchronous call because it already owns the runtime and subscription.

Add one handler:

```ts
function handleCreateCity(request: NewCityRequest): void {
  if (runtime === null) return;
  void runtime.persistence.createCity(request);
}
```

No manual `setSnapshot` is required: `runExclusive` publishes when busy starts and finishes, and successful creation publishes again after active city installation. The existing subscription updates `snapshot`.

Do not catch and convert returned `WorkingSaveResult` in the component. Expected failures are already represented by `snapshot.persistence.error`. Unexpected thrown failures are normalized by working-save runtime.

## Browser bootstrap

In `src/main.ts`:

1. import `isTauriRuntime` with `createBackend`;
2. import `createIndexedDbCitySaveStore`;
3. create the browser save store only when the host is not Tauri;
4. pass it to `createGameRuntime`.

Conceptually:

```ts
const native = isTauriRuntime();
let backend = await createBackend();
const saveStore = native ? undefined : createIndexedDbCitySaveStore();

const runtime = await createGameRuntime({ backend, saveStore });
```

Do not add a temporary IndexedDB fallback for native Tauri. When HPA-344 lands, only this host-selection seam should change to choose `createTauriCitySaveStore()` for native.

No startup city-list read is needed for HPA-345. HPA-346 will decide how Continue/Load selects an existing record. For this slice, a fresh browser profile enters New City; an existing IndexedDB library is intentionally not surfaced yet.

## Failure semantics

### Candidate failure

`buildSandboxSnapshot` returns an error before any write. Keep `activeCity` and gameplay unchanged; show the concise New City error.

### Create conflict

The opaque generated ID collided. The existing create-only store returns conflict and does not overwrite. Keep gameplay unchanged. The player can submit again, producing a fresh ID through the existing injected generator.

Do not add automatic retry loops for an event that should be extraordinarily rare.

### Definite store failure

No record is created. Keep gameplay unchanged and show the save error.

### Returned activation rejection

The record already exists because storage happened first, but candidate-first restore returned a definite failure before installation. The existing working-save runtime leaves the previous active identity/gameplay intact. Preserve the record for later Load; do not delete it.

### Ambiguous thrown restore/install failure

The existing runtime intentionally detaches active identity on an ambiguous host failure because it cannot prove which backend state is authoritative. HPA-345 must not add rollback or reconstruction machinery around this case. The stored city remains available for HPA-346 Load/retry.

## Testing strategy

### Runtime contract test

Update `tests/runtime/workingSaveRuntime.test.ts` to prove the narrowed New City request is translated to canonical backend defaults.

The current lifecycle tests already cover:

- build -> create -> restore -> install order;
- candidate failure;
- create conflict;
- store failure;
- activation failure;
- duplicate/conflicting operation suppression;
- disposal behavior.

Do not duplicate the same matrix at the component layer.

Add/adjust one assertion that `buildSandboxSnapshot` receives:

```ts
{
  templateId: "blankGrid",
  economyPreset: "creative",
  startingCapital: 120_000,
  demandMultiplier: 1,
  moveInRate: "paused",
}
```

for a player request `{ name, economyPreset: "creative", templateId: "blankGrid" }`.

### Svelte shell/component tests

Update `tests/ui/appShell.test.ts` rather than building a new heavyweight test harness.

Extend its runtime harness so persistence state can be overridden and `persistence.createCity` can publish a successful active-city transition.

Focused cases:

1. `activeCity: null` renders `NewCityScreen` and hides game chrome.
2. Empty/whitespace name keeps Create disabled.
3. Standard + Crossroads submit sends the three-field request and disables repeated submission when busy publishes.
4. Creative + Blank Grid maps correctly without testing every combination.
5. A persistence failure renders concise copy, not raw diagnostics.
6. Successful creation switches to the normal game shell through the runtime publication.

Do not snapshot-test the whole form or create a four-combination matrix.

### Real Chromium smoke

Add `tests/e2e/newCity.spec.ts` using the normal dev server and real browser IndexedDB.

One test is enough:

1. open a fresh page/context;
2. confirm the New City screen is visible and game canvas is absent;
3. enter a unique name;
4. choose Creative + Blank Grid (so the smoke covers non-default options);
5. submit;
6. wait for normal game shell/canvas;
7. assert `runtimeSnapshot(page).persistence.activeCity.name` matches and `dirty === false`;
8. read `caelum-city-saves-v1` / `cities` from `page.evaluate` **in test code only**;
9. assert exactly one stored record has the created name and a Rust/WASM snapshot object with `schemaVersion` and `rules.sandbox.templateId === "blankGrid"`.

Because `workingSaveRuntime.createCity` persists before activation, reaching the active game plus observing the real IndexedDB record proves an actual Rust/WASM candidate was structured-cloned, committed, restored, and installed. Do not use `fake-indexeddb` in this e2e test.

## Files

Expected implementation surface:

- Modify `src/runtime/workingSaveRuntime.ts` — narrow the New City request and fill canonical hidden defaults.
- Create `src/components/NewCityScreen.svelte` — focused three-field entry UI.
- Modify `src/App.svelte` — no-city rendering gate and create handler.
- Modify `src/main.ts` — real IndexedDB store for browser host only.
- Modify `src/styles.css` — small entry-screen styles using the existing Signal Console tokens.
- Modify `tests/runtime/workingSaveRuntime.test.ts` — request/default characterization plus existing lifecycle coverage updates.
- Modify `tests/ui/appShell.test.ts` — no-city and form wiring behavior.
- Create `tests/e2e/newCity.spec.ts` — one real browser/WASM/IndexedDB smoke.
- Modify `docs/architecture.md` — record the no-city entry boundary and browser store wiring; keep native store as HPA-344 follow-up.

No other production file should be needed unless implementation reveals a compile-time import/export issue.

## Rejected alternatives

### Build HPA-344 first

HPA-344 is required for desktop, but it blocks HPA-349 rather than the first browser player loop. HPA-345 immediately connects the already-merged runtime and IndexedDB work and then unblocks HPA-346. Native can consume the same UI/runtime contract after its adapter lands.

### Use IndexedDB as a temporary Tauri fallback

Rejected. It creates a native persistence path that HPA-344 would immediately replace and weakens the intended host boundary.

### Put New City inside `CityPanel.svelte`

Rejected. `CityPanel` is part of the active gameplay command shelf and currently presents city state. A player with no active city should not render the gameplay shell just to reach creation. HPA-346 can later extend the City destination with working-save controls.

### Build the full city library now

Rejected. Existing-city selection, Continue/Load, rename/delete, and Save Now belong to HPA-346. Pulling them forward would make HPA-345 larger and delay the first end-to-end storage proof.

### Add a form/view-model/service abstraction

Rejected. There is one form and one runtime action. A focused component plus the existing runtime contract is sufficient.

### Add retries/recovery for create or activation

Rejected. Create conflicts can be retried by resubmission; definite failures leave current gameplay intact; stored-but-not-activated cities can be retried once HPA-346 exposes Load. No recovery framework is justified.

## Acceptance mapping

- Distinct record/no overwrite: existing create-only `CitySaveStore`, retained and covered by runtime/e2e tests.
- Candidate without active mutation: existing `GameBackend.buildSandboxSnapshot` flow.
- Storage before activation: existing `workingSaveRuntime.createCity` order.
- Failure before activation preserves gameplay: existing runtime semantics, retained tests.
- Activation failure preserves stored record: existing storage-first semantics, retained tests.
- UI depends only on runtime action/state: `NewCityScreen` receives three-field action + persistence view only.
- No advanced settings/recovery/security/compatibility: explicit non-goals above.
- Real IndexedDB browser path: `main.ts` wiring + Chromium smoke.
- Actual Rust/WASM snapshot accepted by IndexedDB: Chromium test reads the committed real record and verifies its Rust snapshot shape.

## Follow-up boundary

After HPA-345:

- HPA-346 can build city listing, Continue/Load, Save Now, Rename, and Delete on the same `RuntimePersistenceController`.
- HPA-344 can add the native Tauri store and replace only the native `saveStore` selection in bootstrap.
- HPA-349 can then smoke-test the shared UI/core on both browser and native hosts.

No HPA-345 code should need to be preserved for backward compatibility if those follow-ups require a cleaner breaking change.
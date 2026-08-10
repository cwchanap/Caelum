# HPA-345 Minimal Multi-City New City Flow Design

## Decision

HPA-345 remains the next player-visible Phase 1 persistence slice.

The browser prerequisites are already on `main`:

- HPA-543 provides `RuntimePersistenceController.createCity`, one persistence busy gate, active-city state, dirty tracking, and the storage-first build → create → restore → install lifecycle.
- HPA-343 provides the real browser `IndexedDbCitySaveStore`.
- HPA-345 connects those existing pieces to the first player-facing New City screen and then unlocks HPA-346.

The implementation must also keep the Tauri desktop host playable while HPA-344 is still pending. HPA-345 therefore gives Tauri the existing in-memory `CitySaveStore` as an explicitly temporary, non-durable bridge. HPA-344 replaces that branch with native application-data persistence. This is not an IndexedDB-on-Tauri fallback and does not change HPA-344's scope.

## Product scope

The player can:

1. start with no active city;
2. enter a city name;
3. choose Standard or Creative;
4. choose Blank Grid or Crossroads;
5. create the city;
6. enter the normal paused game shell after the city record is stored and the candidate is activated.

Nothing else is added to the city workflow in this ticket.

HPA-345 does **not** add:

- city library / Continue / Load;
- Save Now;
- Rename / Delete;
- native durable persistence;
- checkpoints / autosave / recovery;
- migration or backward compatibility;
- retries, rollback, pending/finalize, or reconciliation;
- security frameworks or hostile-input infrastructure;
- generic form, persistence-service, state-machine, or DI abstractions.

## Reuse survey

### Runtime lifecycle

Reuse `RuntimePersistenceController.createCity` and `createWorkingSaveRuntime` unchanged in lifecycle order:

```text
player request
  -> buildSandboxSnapshot(candidate)
  -> CitySaveStore.createCity(record)
  -> restoreSnapshot(candidate)
  -> installRestoredGameplay(candidate)
  -> publish active city / clean state
```

No second persistence path is introduced.

### Domain types

Reuse the closed unions already owned by `src/domain/types.ts`:

```ts
EconomyPreset = "standard" | "creative"
SandboxTemplateId = "blankGrid" | "crossroads"
MoveInRateSelection = "paused"
```

Do not add `NewCityEconomyPreset` or `NewCityTemplateId` aliases.

### Browser storage

Reuse `createIndexedDbCitySaveStore()` with its existing `caelum-city-saves-v1` database and `cities` object store.

The UI and `App.svelte` never access IndexedDB directly.

### Tauri transition

Reuse `createMemoryCitySaveStore()` for the native host **only until HPA-344 lands**.

This preserves the same durability level the current native anonymous sandbox has: none across app restarts. It keeps `bun run tauri:dev` usable after the no-city gate, without pretending browser IndexedDB is a native storage solution.

The bootstrap branch is intentionally obvious and disposable:

```ts
const saveStore = nativeTauri
  ? createMemoryCitySaveStore() // HPA-344 replaces this with native storage.
  : createIndexedDbCitySaveStore();
```

HPA-344 removes the memory branch rather than supporting both permanently.

### Error copy

Reuse the runtime message pattern already established by `rejectionMessage()` in `src/runtime/rejectionMessages.ts`.

Add:

```ts
workingSaveErrorMessage(error: WorkingSaveError): string
```

there, with an exhaustive switch and DEV-loud `never` handling. `NewCityScreen.svelte` receives only `string | null` error copy; it does not own persistence error taxonomy.

This keeps the message map reusable when HPA-346 adds Save/Load/Rename/Delete UI.

## Player request contract

Narrow the current backend-shaped New City input to the actual player choice:

```ts
export interface NewCityRequest {
  name: string;
  economyPreset: EconomyPreset;
  templateId: SandboxTemplateId;
}
```

The old internal shape:

```ts
{
  name,
  sandbox: SandboxCreationRequest
}
```

is removed in the same commit from every production/test caller. No overload or compatibility adapter remains.

## Hidden sandbox defaults

The player does not see advanced sandbox tuning in HPA-345.

The runtime translates the player request into the current required host request using:

- starting capital `120_000`;
- demand multiplier `1`;
- move-in rate `"paused"`.

`MoveInRateSelection` types the fixed move-in value. The numeric values remain beside `createCity` with a source comment pointing to `canonical_default_request()` in `crates/caelum-core/src/sandbox.rs`.

### Why HPA-345 does not make the numeric fields optional

The Rust request already uses `Option<f64>` internally, but `validate_request` intentionally treats `None` as:

- `InvalidStartingCapital`; and
- `InvalidDemandMultiplier`.

`crates/caelum-core/tests/sandbox_coverage.rs` explicitly characterizes null/missing values as typed errors. Making `None` mean "use the default" would weaken that strict request contract and change existing semantics beyond what New City needs.

HPA-345 therefore does **not** change Rust parsing to default omitted numeric fields.

### Drift protection

A TypeScript-only test asserting `120_000` against another TypeScript literal cannot detect Rust-default drift.

The required Chromium New City proof must instead:

1. wait for the real WASM runtime and pre-game screen;
2. capture the anonymous pre-game runtime snapshot produced by `WasmGameEngine::new()` / `GameEngine::new()`;
3. create a default Standard/Crossroads city through the UI;
4. compare the created city's hidden sandbox values against that pre-game Rust-owned snapshot:
   - budget / starting capital;
   - demand multiplier;
   - move-in rate;
5. read the committed IndexedDB record and verify the same created city by name/ID.

If Rust changes its canonical hidden defaults while the TypeScript translation remains stale, this real-engine comparison fails.

## UI boundary

Create one focused component:

```text
src/components/NewCityScreen.svelte
```

Props:

```ts
interface Props {
  busy: boolean;
  error: string | null;
  onCreate: (request: NewCityRequest) => void;
}
```

Local state contains only:

- name;
- `EconomyPreset`;
- `SandboxTemplateId`.

Defaults:

- Standard;
- Crossroads.

Name behavior:

- trim on submit;
- disable Create while trimmed name is empty;
- normal Svelte escaping only.

No advanced settings, snapshot data, store object, backend object, diagnostics, or persistence error union crosses into the component.

## App rendering gate

`App.svelte` keeps the existing fatal-shell branch first.

The pre-game branch is selected whenever no active city is available:

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
  <!-- existing active game shell -->
{/if}
```

The nullish form is correct for both `snapshot === null` and `activeCity === null`, but HPA-345 does not add a dedicated "observe snapshot before Svelte's initial effect flush" test. Existing Svelte rendering seeds `snapshot` during the render lifecycle, so that transient state is not a meaningful user-visible contract.

The focused UI test is the real branch condition: a runtime snapshot whose `activeCity` is null renders New City instead of game chrome.

## Error copy

`workingSaveErrorMessage` owns concise player copy and never exposes adapter/backend diagnostics.

The mapping stays small and tied to existing unions:

- busy → another city action is already in progress;
- unavailable → city storage is unavailable;
- no active city → no city is active;
- sandbox → city setup could not be created;
- backend → city state could not be applied;
- store → message derived from the existing six `CitySaveStoreOperation` values.

For `createCity`, the New City screen therefore receives a generic save failure rather than IndexedDB names, quota details, stack traces, or host diagnostics.

No UI-specific error switch is duplicated in Svelte.

## Browser/Tauri bootstrap

`src/main.ts` determines the current host once and passes a store for both paths:

```text
browser/WASM -> createIndexedDbCitySaveStore()
native Tauri -> createMemoryCitySaveStore()   // temporary until HPA-344
```

This store wiring lands **before** the no-city gate, so every intermediate implementation commit remains playable:

1. request contract changes;
2. host store wiring (inert while the old anonymous UI remains);
3. runtime error-message mapping;
4. pre-game gate + UI + e2e migration;
5. docs / final verification.

No commit should leave browser Create permanently unavailable or make the current Tauri host impossible to enter.

## E2E bootstrap contract

Existing gameplay e2e specs currently assume `page.goto("/")` opens an active game. After HPA-345 that assumption is invalid.

Add mandatory shared helper:

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

The helper is unconditional. Playwright config has no shared `storageState`; each test context is fresh, so the pre-game screen is expected. A one-shot `isVisible()` check is specifically rejected because WASM/backend initialization may finish after `page.goto()` resolves.

Every gameplay spec that currently navigates to `/` and then assumes the game shell must call this helper before gameplay assertions.

The dedicated New City persistence smoke does **not** call the helper because it needs to inspect pre-game state and the persistence transition itself.

## Focused tests

### Runtime request tests

Keep the existing lifecycle coverage and migrate every old request-shape caller in one task:

- `tests/runtime/workingSaveRuntime.test.ts`;
- `tests/runtime/citySaveRuntime.test.ts`;
- any current `tests/runtime/gameRuntime.test.ts` caller found by the required repository scan.

The unit test characterizes request translation; the Chromium test owns Rust-default drift detection.

### Runtime message tests

Extend `tests/runtime/rejectionMessages.test.ts` to prove:

- each `WorkingSaveError.kind` returns concise copy;
- create-store diagnostics are not included;
- store-operation messages cover the existing closed `CitySaveStoreOperation` union;
- DEV handling stays exhaustive.

### Svelte tests

Cover:

- `activeCity: null` renders New City and hides active game chrome;
- request contains only trimmed name + economy + template;
- busy disables repeat submission;
- runtime-mapped error text is shown without diagnostics;
- publishing an active city returns to the normal game shell.

Do not add a special test for an unobservable pre-effect `snapshot === null` frame.

### Chromium persistence proof

One real browser smoke must prove:

- real WASM candidate creation;
- real IndexedDB structured clone / commit;
- storage-before-activation path completes;
- active city is paused and clean;
- committed record is found by created city name/ID, not by assuming `records.length === 1`;
- hidden defaults on the created snapshot match the pre-game Rust-owned canonical snapshot.

No `fake-indexeddb` is used for this proof.

## Failure behavior

Existing `workingSaveRuntime.createCity` behavior remains authoritative:

- candidate failure: no record, active gameplay unchanged;
- create conflict: no overwrite, active gameplay unchanged;
- store failure: no activation;
- returned activation rejection: created record remains available;
- ambiguous thrown restore/install: runtime applies its existing safety behavior;
- duplicate submit: busy gate rejects/disables overlap.

HPA-345 adds no rollback, cleanup, retry, or recovery layer.

## Acceptance criteria

- [ ] `NewCityRequest` uses existing domain unions and contains only player-facing fields.
- [ ] Every current `{ name, sandbox }` runtime/test caller is migrated in the request-contract commit.
- [ ] Hidden numeric settings remain required at the strict Rust host boundary; HPA-345 does not change null/missing validation semantics.
- [ ] One real-WASM Chromium assertion compares created hidden settings with the Rust-owned pre-game canonical snapshot.
- [ ] Browser startup uses the real IndexedDB store.
- [ ] Tauri startup uses the existing in-memory store temporarily and remains playable until HPA-344 replaces it with native persistence.
- [ ] No IndexedDB-on-Tauri fallback is introduced.
- [ ] Player-facing `WorkingSaveError` copy lives under `src/runtime/`, not inside Svelte.
- [ ] No active city renders the focused New City screen; an active city renders the existing game shell.
- [ ] New City invokes only `runtime.persistence.createCity` from UI code.
- [ ] All existing gameplay e2e tests explicitly create a default city through a retrying/assertive shared helper.
- [ ] The dedicated Chromium smoke reads real IndexedDB and matches the committed city by name/ID.
- [ ] No city library, Save/Load, Rename/Delete, recovery, migration, compatibility, security, or generic framework is added.
- [ ] HPA-344 and HPA-346 remain separate downstream work.

## Follow-on boundaries

### HPA-344

Replace only the Tauri `createMemoryCitySaveStore()` bootstrap branch with the native application-data `CitySaveStore` adapter and add native persistence evidence.

### HPA-346

Build the city library and working-save UI on the same runtime/store contracts:

- Continue / Load;
- Save Now;
- Rename;
- Delete.

It reuses `workingSaveErrorMessage` instead of inventing UI-local persistence copy.

### Later work

Autosave, checkpoints, recovery, import/export, migrations, cloud sync, multi-instance ownership, and release hardening remain deferred until separately justified.

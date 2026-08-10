# HPA-345 Minimal Multi-City New City Flow Design

## Decision

HPA-345 is the next player-visible Phase 1 persistence slice.

The browser prerequisites are already present on `main`:

- HPA-543 provides the focused working-save runtime with active-city state, one busy gate, one dirty boolean, storage-first New City creation, and candidate-first activation.
- HPA-343 provides the concrete browser IndexedDB `CitySaveStore`.
- The existing Rust/WASM backend already builds deterministic sandbox candidates and restores them through the same runtime boundary used by native Tauri.

HPA-345 should connect those existing pieces. It must not create a second persistence workflow, a second sandbox settings model, or a temporary native storage path.

## Scope

A player with no active city can:

1. enter a city name;
2. choose Standard or Creative economy;
3. choose Blank Grid or Crossroads;
4. create the city;
5. persist the real Rust/WASM candidate in browser IndexedDB before activation;
6. enter the normal game shell with the created city active, paused, and clean.

This ticket does not add a city library, Continue/Load, Save Now, Rename, Delete, autosave, checkpoints, recovery, migrations, import/export, cloud sync, or native filesystem persistence.

## Current boundaries to reuse

### Working-save runtime

`src/runtime/workingSaveRuntime.ts` already owns the important lifecycle:

```text
buildSandboxSnapshot
  -> createCity(record)
  -> restoreSnapshot(candidate)
  -> installRestoredGameplay(candidate)
  -> publish activeCity + clean state
```

That order remains authoritative.

A failure before storage leaves current gameplay and storage unchanged. A failure after storage but before successful activation leaves the newly created record available for later loading. HPA-345 must not add rollback, pending/finalize, reconciliation, or automatic cleanup.

### Browser store

`src/persistence/indexedDbCitySaveStore.ts` already exposes a zero-configuration browser factory:

```ts
createIndexedDbCitySaveStore()
```

It implements the existing six-operation `CitySaveStore` and stores snapshots opaquely. HPA-345 wires this adapter into browser startup; the UI never imports or calls IndexedDB.

### Native store remains separate

HPA-344 still owns the native Tauri `CitySaveStore`.

Do not use IndexedDB as a temporary Tauri fallback. Until HPA-344 lands, native startup may continue without durable city storage; HPA-349 owns the later browser/native smoke gate.

## Player-facing request contract

The player action should expose only the choices the form actually owns.

Reuse the existing domain unions from `src/domain/types.ts` instead of declaring duplicate aliases:

```ts
import type {
  EconomyPreset,
  SandboxTemplateId,
} from "../domain/types";

export interface NewCityRequest {
  name: string;
  economyPreset: EconomyPreset;
  templateId: SandboxTemplateId;
}
```

Do not add `NewCityEconomyPreset` or `NewCityTemplateId`. `EconomyPreset` and `SandboxTemplateId` are already the closed source of truth for the same values.

The runtime translates this player request into the existing backend `SandboxCreationRequest` immediately beside `createCity`.

The hidden values remain fixed to the current Rust canonical defaults:

```ts
const NEW_CITY_STARTING_CAPITAL = 120_000;
const NEW_CITY_DEMAND_MULTIPLIER = 1;
const NEW_CITY_MOVE_IN_RATE: MoveInRateSelection = "paused";
```

`MoveInRateSelection` is also reused from `src/domain/types.ts` so the fixed value is checked against the existing closed domain type.

These constants intentionally mirror `canonical_default_request()` in `crates/caelum-core/src/sandbox.rs`. Do not create a frontend sandbox-settings object, config service, or extra form fields.

## Runtime responsibility

`RuntimePersistenceController.createCity(request)` keeps its existing method name and result type.

The only contract change is the input shape. Internally it builds the backend request:

```ts
const candidate = await host.backend.buildSandboxSnapshot({
  templateId: request.templateId,
  economyPreset: request.economyPreset,
  startingCapital: NEW_CITY_STARTING_CAPITAL,
  demandMultiplier: NEW_CITY_DEMAND_MULTIPLIER,
  moveInRate: NEW_CITY_MOVE_IN_RATE,
});
```

Everything after candidate construction stays unchanged:

- generate the city ID and timestamp through the existing injected dependencies;
- create one `CitySaveRecord`;
- call `saveStore.createCity(record)`;
- restore/install only after storage succeeds;
- publish `activeCity` only after activation succeeds;
- clear dirty state on success;
- preserve existing busy/error behavior.

There is no compatibility overload for the old `{ name, sandbox }` request. All current callers change in the same implementation slice.

## Contract blast radius

The request shape is already exercised outside `workingSaveRuntime.test.ts`.

Task 1 must update every current runtime/test caller, including at minimum:

- `tests/runtime/workingSaveRuntime.test.ts`;
- `tests/runtime/citySaveRuntime.test.ts`;
- `tests/runtime/gameRuntime.test.ts` when its `createCity` setup uses the old `{ sandbox }` form.

The task ends with a repository scan for old `{ sandbox }` New City calls plus the full frontend type-check/unit gate. A green focused working-save test alone is not sufficient evidence for this breaking internal contract change.

## No-city application state

The no-city state is a real pre-game screen, not an empty version of the active game shell.

Create one focused component:

```text
src/components/NewCityScreen.svelte
```

It receives only:

```ts
interface Props {
  busy: boolean;
  error: WorkingSaveError | null;
  onCreate: (request: NewCityRequest) => void;
}
```

The component owns local form state only:

- city name;
- economy preset;
- template.

Defaults:

- economy: `standard`;
- template: `crossroads`.

The component does not know about `GameBackend`, `CitySaveStore`, IndexedDB, WASM, Tauri, timestamps, IDs, snapshots, or hidden sandbox tuning.

## Initial render gate

`App.svelte` initializes its local `snapshot` to `null`, then seeds it from `runtime.getSnapshot()` in an effect. Therefore the pre-game check must treat both `snapshot === null` and `activeCity === null` as no-city state.

Do not use:

```svelte
snapshot?.persistence.activeCity === null
```

because it is false while `snapshot` is still `null` and would briefly select the active-game branch.

Use an equivalent nullish gate such as:

```svelte
{#if snapshot?.persistence.activeCity == null}
  <NewCityScreen
    busy={snapshot?.persistence.busy ?? false}
    error={snapshot?.persistence.error ?? null}
    onCreate={handleCreateCity}
  />
{:else}
  <!-- normal active-game shell -->
{/if}
```

The existing fatal shell-error branch remains outside and above this gate.

This prevents an empty game shell from flashing before the initial runtime snapshot is seeded.

## Form behavior

The form follows the existing desktop Signal Console visual language without becoming another UI system.

Required behavior:

- trim leading/trailing whitespace from the name on submit;
- disable Create while the trimmed name is empty;
- disable all repeat submission while persistence is busy;
- show `Creating…` while busy;
- submit only `{ name, economyPreset, templateId }`;
- rely on normal Svelte escaping for the name;
- keep the form visible after a failure so the player can retry.

Do not add length policies, character allowlists, sanitization libraries, async name validation, or uniqueness checks. City IDs, not names, provide storage identity.

## Error copy

`WorkingSaveError` stays the runtime contract. The screen maps it to concise player copy and does not render adapter diagnostics.

Representative mapping:

- `busy` -> `City creation is already in progress.`
- `sandbox` / `backend` -> `Could not create that city setup.`
- `store` -> `Could not save the new city.`
- `unavailable` -> `City storage is unavailable.`
- `noActiveCity` is not expected from creation; use a generic creation failure if it is ever observed.

A store error may contain a browser diagnostic such as an IndexedDB error name. The screen does not display it.

## App transition

`App.svelte` calls only:

```ts
runtime.persistence.createCity(request)
```

The runtime already publishes `busy`, `error`, and final `activeCity` state through its normal subscription path. App does not manually synthesize persistence state.

When `activeCity` becomes non-null, the existing active-game shell renders. The restored candidate already resets transient UI through `installRestoredGameplay`, so no extra App reset is needed.

## Browser bootstrap

`src/main.ts` currently creates a backend and then creates a runtime without a save store.

HPA-345 changes startup so the browser/WASM path gets the real IndexedDB adapter while Tauri does not receive a fake browser fallback.

Use the existing runtime detection boundary, conceptually:

```ts
const tauri = isTauriRuntime();
const backend = await createBackend();
const saveStore = tauri ? undefined : createIndexedDbCitySaveStore();
const runtime = await createGameRuntime({ backend, saveStore });
```

Exact local ordering may be adjusted to keep startup code simple, but the invariant is fixed:

- browser -> IndexedDB store;
- Tauri -> no IndexedDB fallback in this ticket.

## Required browser proof

HPA-345 requires one real Chromium New City proof. `fake-indexeddb` unit tests from HPA-343 are not sufficient for this integration ticket.

Add a focused Playwright case that:

1. opens `/` with a fresh browser context;
2. sees the New City screen;
3. enters a city name and creates a city;
4. waits for the normal game canvas/shell;
5. reads `runtime.getSnapshot()` and confirms the active city name;
6. opens the real `caelum-city-saves-v1` IndexedDB database from page context;
7. reads the `cities` object store;
8. finds a record whose `record.city.name` matches the created name;
9. confirms the stored record contains the expected active city ID and a real Rust snapshot/schema;
10. confirms the runtime is active and clean.

Assert by matching the created city name/ID, not by assuming the entire object store has exactly one record. Playwright currently provides a fresh context per test, but a name/ID match is more durable if test storage strategy changes later.

Do not expose a production IndexedDB debug hook just for this assertion.

## Existing e2e bootstrap is part of HPA-345

The current gameplay e2e suite directly calls `page.goto("/")` and assumes the game shell is immediately active. After the no-city gate, those tests will correctly land on `NewCityScreen` instead.

Updating those specs is mandatory work, not optional cleanup.

Add a shared helper in `tests/e2e/helpers.ts`:

```ts
createDefaultCity(page)
```

The helper should:

1. navigate to `/`;
2. create a default Standard/Crossroads city if `new-city-screen` is visible;
3. wait for `game-canvas-host` to become visible;
4. return only after the ordinary gameplay shell is ready.

Replace direct gameplay-start `page.goto("/")` calls with this helper in every affected current spec, including the files found on current `main`:

- `tests/e2e/smoke.spec.ts`;
- `tests/e2e/commandShelf.spec.ts`;
- `tests/e2e/topbarViewport.spec.ts`;
- `tests/e2e/routes.spec.ts`;
- `tests/e2e/roundabouts.spec.ts`.

The dedicated New City integration test keeps its direct `page.goto("/")` because proving the pre-game state is the point of that test.

The Task 3 acceptance gate includes a repository scan for remaining direct gameplay `page.goto("/")` sites and a full `bun run test:e2e` pass. The suite is not considered green until every affected existing gameplay test bootstraps a city explicitly.

## Testing strategy

### Runtime tests

Reuse and update existing New City lifecycle coverage instead of duplicating it:

- candidate build -> store -> restore -> install ordering;
- create conflict;
- candidate failure;
- store failure;
- activation failure preserving the created record;
- busy suppression;
- disposal behavior.

Add one characterization proving the new player request maps to the fixed hidden defaults.

Update all old request-shape callers in the same task.

### Svelte tests

Add focused cases for:

- `snapshot === null` renders the New City pre-game screen, not an empty active shell;
- `activeCity === null` renders the New City screen;
- active city renders the existing game shell;
- trimmed non-empty name is required;
- economy/template submission uses the domain values;
- busy disables duplicate submit;
- concise error copy hides diagnostics;
- successful runtime publication transitions into the game shell.

Do not build a large form-validation matrix.

### Playwright

Required:

- one real New City + real IndexedDB proof;
- mandatory `createDefaultCity` bootstrap for every existing gameplay e2e spec;
- full existing e2e suite remains green.

## Deliberate non-goals

HPA-345 does not include:

- city list/library;
- Continue/Load;
- Save Now controls;
- Rename/Delete controls;
- native Tauri city files;
- autosave/checkpoints/save history;
- recovery/reconciliation;
- import/export;
- migrations or old-save readers;
- cloud sync;
- encryption/signing/checksums;
- multi-tab/window ownership;
- generic repository/service/form abstractions;
- new dependencies.

HPA-344 and HPA-346 remain unchanged.

## Acceptance criteria

- [ ] `NewCityRequest` uses existing `EconomyPreset` and `SandboxTemplateId` domain types; no duplicate aliases are introduced.
- [ ] All current `{ name, sandbox }` New City callers are migrated in one contract-change task.
- [ ] The form exposes only name, economy, and template.
- [ ] Hidden sandbox values remain the current canonical `120_000`, `1`, and typed `"paused"` defaults.
- [ ] Initial `snapshot === null` and `activeCity === null` both render the New City pre-game screen.
- [ ] UI calls only `runtime.persistence.createCity` and never accesses storage/backend APIs.
- [ ] Storage succeeds before activation and the existing working-save lifecycle is reused unchanged after candidate construction.
- [ ] Browser startup uses `createIndexedDbCitySaveStore()`.
- [ ] Tauri does not receive an IndexedDB fallback.
- [ ] One Chromium test proves a real Rust/WASM candidate is committed to real browser IndexedDB and activated.
- [ ] Existing gameplay e2e specs use the required shared `createDefaultCity` bootstrap and the full e2e suite passes.
- [ ] No HPA-344 or HPA-346 functionality is pulled into this ticket.

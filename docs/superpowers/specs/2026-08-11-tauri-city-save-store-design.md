# HPA-344 Native Tauri City Save Store Design

**Issue:** HPA-344  
**Status:** Proposed  
**Decision date:** 2026-08-11  
**Prerequisite:** HPA-548 (done)  
**Downstream:** HPA-349 cross-host smoke

## 1. Decision

Replace the native Tauri branch's temporary `MemoryCitySaveStore` with one small filesystem-backed adapter that implements the existing six-operation `CitySaveStore` and nothing more.

The boundary is deliberately split by responsibility:

```text
Svelte / runtime
  -> CitySaveStore
      -> browser: IndexedDB adapter
      -> native: tauriCitySaveStore.ts
           -> six narrow Tauri commands
                -> src-tauri/src/city_store.rs
                     -> <app_data_dir>/cities/*.json
```

Rust owns every filesystem concern: application-data path resolution, filename encoding, directory creation/scanning, JSON serialization, create-only file creation, temp-file replacement, and native I/O diagnostics.

TypeScript owns only the existing frontend contract: invoke six commands, sort returned summaries with `sortCitySummaries()`, and map native command failures into `CitySaveStoreError` using `citySaveStoreError()`.

The application bootstrap change is one substitution in `src/main.ts`:

```ts
const saveStore = nativeTauri
  ? createTauriCitySaveStore()
  : createIndexedDbCitySaveStore();
```

No runtime, gameplay-host, Svelte, save-schema, or persistence-coordination redesign is part of HPA-344.

## 2. Why HPA-344 is next

The Phase 1 browser path is now complete through the city library:

- HPA-548 — six-operation `CitySaveStore`: done;
- HPA-343 — IndexedDB implementation: done;
- HPA-345 — New City flow: done;
- HPA-346 — city library / Save / Load / Rename / Delete: done.

`src/main.ts` already makes the remaining gap explicit: native Tauri uses `createMemoryCitySaveStore()` only as a temporary bridge and comments that HPA-344 replaces it.

HPA-344 is therefore the smallest unblocked Phase 1 feature that closes a real product gap. HPA-349 is intentionally downstream because its representative native restart/Continue smoke is only meaningful after native persistence exists.

Do not jump to HPA-349 first, and do not begin Phase 2 demand work while the intended desktop release host still loses all city records on process exit.

## 3. Approaches considered

### A. Small Rust filesystem module + thin TypeScript invoke adapter — selected

Add:

```text
src-tauri/src/city_store.rs
src/persistence/tauriCitySaveStore.ts
```

The Rust module is city-save-specific rather than generic. It receives only city IDs, records, updates, and names; it derives every path internally.

**Advantages**

- matches HPA-344's fixed native-storage boundary exactly;
- no frontend path authority;
- reuses the existing `CitySaveStore` without changing runtime or UI code;
- one file per city keeps multi-city behavior inspectable during active development;
- no production dependency is required for storage;
- temp-file replacement is sufficient for the current single-runtime manual-save scope;
- easy to delete or reshape while development saves remain disposable.

**Cost**

- a small amount of Rust JSON/filesystem code;
- one TypeScript command adapter and focused mocks.

### B. Use a frontend Tauri filesystem plugin — rejected

Letting TypeScript resolve application-data paths and read/write files would move native storage policy into the frontend and expose a broader filesystem capability than `CitySaveStore` requires.

That duplicates responsibilities across IndexedDB and native host code without improving the runtime boundary. HPA-344 specifically calls for narrow storage commands and no frontend-supplied paths.

### C. Introduce a generic Rust repository/storage service — rejected

A reusable filesystem repository, storage trait hierarchy, managed storage state, command bus, or persistence service would have one consumer and six operations. It would increase surface area without unlocking any current feature.

If a second native storage domain appears later, extract only the concrete reuse demonstrated then.

## 4. Scope boundary

### HPA-344 owns

- one fixed native city-save directory under Tauri's application-data directory;
- one JSON file per city;
- deterministic filename encoding derived solely from the opaque city ID;
- native list/read/create/update/rename/delete operations;
- create-only conflict semantics;
- temp-file replacement for update and rename;
- best-effort stale-temp ignoring/cleanup only;
- native command error mapping to `notFound`, `conflict`, or `failed`;
- a thin TypeScript `CitySaveStore` adapter;
- native bootstrap wiring in `src/main.ts`;
- focused Rust filesystem tests and TypeScript command-mapping tests;
- architecture documentation for the final Phase 1 native persistence boundary.

### HPA-344 does not own

- changes to `CitySaveStore`, `workingSaveRuntime.ts`, `createGameRuntime()`, or Svelte persistence APIs;
- changes to the native gameplay `GameBackend` or runtime epoch logic;
- IndexedDB behavior;
- import/export between browser and desktop;
- migration of IndexedDB data or earlier Tauri development files;
- save version adapters, legacy readers, or compatibility fixtures;
- autosaves, checkpoints, generations, save history, recovery, or repair;
- metadata indexes or caches;
- multi-window/multi-process locks or save ownership;
- encryption, signing, checksums, permission frameworks, path pickers, fsync/directory-sync certification, crash/power-loss matrices, or forensic recovery;
- generic filesystem/repository abstractions;
- a full native UI E2E suite. HPA-349 owns the representative cross-host smoke.

## 5. Storage layout

Use one directory:

```text
<app_data_dir>/cities/
```

Each committed city is one UTF-8 JSON file containing the complete current `CitySaveRecord` wire shape:

```json
{
  "city": {
    "id": "opaque-city-id",
    "name": "North Loop",
    "createdAt": "2026-08-11T18:00:00.000Z"
  },
  "savedAt": "2026-08-11T18:30:00.000Z",
  "snapshot": {}
}
```

There is no metadata index and no separate snapshot file.

### Filename encoding

Never place the frontend-provided city ID directly into a path. Encode every UTF-8 byte as lowercase hexadecimal and wrap it in a fixed filename form:

```text
city-<hex(id bytes)>.json
```

Examples:

```text
"city-1"       -> city-636974792d31.json
"../outside"   -> city-2e2e2f6f757473696465.json
```

The encoding does not need a reverse operation because list reads the authoritative city ID from each JSON record. Its only job is to make every possible ID a single safe filename component.

No ID validation framework is required. The runtime already generates opaque IDs; the native layer only prevents IDs from becoming paths.

### Temp files

Update and rename use a deterministic sibling temp path:

```text
city-<hex>.json.tmp
```

The supported product model has one runtime and one persistence busy gate, so unique temp generations and lock ownership are unnecessary.

`listCities` ignores `.tmp` files. A later write for the same city may overwrite a stale temp. Best-effort temp deletion after a failed replacement is sufficient; no recovery scan is introduced.

## 6. Rust module shape

Create `src-tauri/src/city_store.rs` and keep all native persistence types/functions there.

A small module-private store object is enough to make temp-directory testing direct without creating a generic repository:

```rust
struct CityFileStore {
    root: PathBuf,
}

impl CityFileStore {
    fn from_app(app: &tauri::AppHandle) -> Result<Self, CityStoreCommandError>;
    fn new(root: PathBuf) -> Self;

    fn list_cities(&self) -> Result<Vec<CitySummary>, CityStoreCommandError>;
    fn read_city(&self, id: &str) -> Result<CitySaveRecord, CityStoreCommandError>;
    fn create_city(&self, record: CitySaveRecord) -> Result<CitySummary, CityStoreCommandError>;
    fn update_city(&self, id: &str, update: CitySaveUpdate) -> Result<CitySummary, CityStoreCommandError>;
    fn rename_city(&self, id: &str, name: String) -> Result<CitySummary, CityStoreCommandError>;
    fn delete_city(&self, id: &str) -> Result<(), CityStoreCommandError>;
}
```

`from_app()` resolves only:

```rust
app.path().app_data_dir()?.join("cities")
```

Do not manage `CityFileStore` as Tauri state. Path resolution is cheap, keeps this module stateless, and avoids another lifecycle object.

### Wire record types

Mirror only the existing TypeScript save-store wire shape:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CityIdentity {
    id: String,
    name: String,
    created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CitySaveRecord {
    city: CityIdentity,
    saved_at: String,
    snapshot: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CitySaveUpdate {
    saved_at: String,
    snapshot: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CitySummary {
    id: String,
    name: String,
    created_at: String,
    saved_at: String,
}
```

These are transport/storage shapes, not new gameplay-domain models. `snapshot` remains opaque JSON; native persistence does not inspect or validate gameplay state.

For `listCities()`, deserialize only the fields needed for `CitySummary` rather than materializing every snapshot:

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CityListRecord {
    city: CityIdentity,
    saved_at: String,
}
```

Serde ignores the extra `snapshot` field by default, so directory scanning does not need a metadata index merely to avoid loading complete snapshots into `serde_json::Value`.

## 7. Native command boundary

Expose exactly six Tauri commands from `city_store.rs`:

```text
city_store_list
city_store_read
city_store_create
city_store_update
city_store_rename
city_store_delete
```

Their conceptual signatures are:

```rust
#[tauri::command]
fn city_store_list(app: tauri::AppHandle)
    -> Result<Vec<CitySummary>, CityStoreCommandError>;

#[tauri::command]
fn city_store_read(app: tauri::AppHandle, id: String)
    -> Result<CitySaveRecord, CityStoreCommandError>;

#[tauri::command]
fn city_store_create(app: tauri::AppHandle, record: CitySaveRecord)
    -> Result<CitySummary, CityStoreCommandError>;

#[tauri::command]
fn city_store_update(app: tauri::AppHandle, id: String, update: CitySaveUpdate)
    -> Result<CitySummary, CityStoreCommandError>;

#[tauri::command]
fn city_store_rename(app: tauri::AppHandle, id: String, name: String)
    -> Result<CitySummary, CityStoreCommandError>;

#[tauri::command]
fn city_store_delete(app: tauri::AppHandle, id: String)
    -> Result<(), CityStoreCommandError>;
```

Register these beside the existing gameplay commands in `src-tauri/src/lib.rs`. Do not merge storage into `createTauriBackend()` or the gameplay command enums; gameplay and city files remain separate responsibilities even though both use Tauri IPC.

No command accepts `path`, `directory`, `filename`, or a generic filesystem request.

## 8. Error wire and TypeScript mapping

Keep native command failures smaller than the frontend `CitySaveStoreError` because the adapter already knows the operation and city ID.

Rust returns:

```rust
#[derive(Debug, Serialize)]
#[serde(tag = "code", content = "diagnostic", rename_all = "camelCase")]
enum CityStoreCommandError {
    NotFound,
    Conflict,
    Failed(String),
}
```

Rules:

- missing committed city file -> `notFound`;
- create-only destination already exists -> `conflict`;
- application-data resolution, directory, read, parse, serialize, write, rename, and other native failures -> `failed`;
- diagnostics are development detail only and may differ from IndexedDB diagnostics.

Do not expose full filesystem paths in player-facing copy. The existing runtime/UI already renders generic persistence messages from store codes, not adapter diagnostics.

The TypeScript adapter recognizes only those three codes. It builds the normal store error with:

```ts
citySaveStoreError(operation, code, { cityId, diagnostic });
```

If Tauri rejects with anything that is not the expected native error object, map it to `failed` for the current operation. Do not invent transport-specific store codes.

## 9. TypeScript adapter

Create `src/persistence/tauriCitySaveStore.ts` with one factory:

```ts
export function createTauriCitySaveStore(): CitySaveStore;
```

It imports `invoke` from `@tauri-apps/api/core` and the existing helpers/types from `citySaveStore.ts`.

Each method invokes exactly one command:

```ts
invoke<CitySummary[]>("city_store_list");
invoke<CitySaveRecord>("city_store_read", { id });
invoke<CitySummary>("city_store_create", { record });
invoke<CitySummary>("city_store_update", { id, update });
invoke<CitySummary>("city_store_rename", { id, name });
invoke<void>("city_store_delete", { id });
```

`listCities()` applies `sortCitySummaries()` after IPC so both durable adapters keep the shared frontend ordering contract without duplicating sort rules in Rust.

Tauri IPC serializes request/response values, so no explicit cloning layer or adapter-local snapshot normalization is needed.

Do not add an injected invoke parameter to production API unless an existing project pattern requires it. Vitest already mocks `@tauri-apps/api/core` directly in `tests/runtime/tauriBackend.test.ts`.

## 10. Operation semantics

### `listCities`

1. Resolve/create `<app_data_dir>/cities`.
2. Scan direct children only.
3. Ignore non-`.json` entries and `.tmp` files.
4. Deserialize `CityListRecord` from each committed JSON file.
5. Return summaries to TypeScript.
6. TypeScript applies `sortCitySummaries()`.

A malformed committed JSON file produces generic `failed` rather than silently hiding a city or introducing repair logic.

### `readCity(id)`

1. Derive the encoded committed path from `id`.
2. Read the file.
3. `NotFound` -> `notFound`.
4. Deserialize the full `CitySaveRecord`.
5. Return it unchanged.

Do not validate Rust gameplay snapshot schema here; `restoreSnapshot()` remains the validation/activation boundary.

### `createCity(record)`

1. Resolve/create the city directory.
2. Serialize the complete record to bytes before opening a destination.
3. Derive the committed path from `record.city.id`.
4. Open with `OpenOptions::create_new(true).write(true)`.
5. Existing destination -> `conflict`.
6. Write all serialized bytes.
7. Return `CitySummary` only after the write completes.

If writing the newly created file fails, best-effort delete the partial destination before returning `failed`. No fsync/power-loss guarantee is claimed in Phase 1.

There is no read-before-create conflict check and no overwrite path.

### `updateCity(id, update)`

1. Read the existing record by encoded ID path.
2. Missing -> `notFound`.
3. Build a replacement that preserves stored `city.id`, `city.name`, and `city.createdAt` while replacing only `savedAt` and `snapshot`.
4. Serialize the replacement before touching the committed file.
5. Write bytes to the deterministic sibling `.tmp` file.
6. Rename the temp file onto the committed path.
7. Return the replacement summary only after rename succeeds.

A failure before the rename leaves the committed file untouched. A failed rename returns `failed`; best-effort remove the temp file. Do not delete the committed file before rename.

### `renameCity(id, name)`

Use the same read -> build replacement -> serialize -> temp write -> rename helper as update. Replace only `city.name`; preserve `createdAt`, `savedAt`, and `snapshot`.

Do not update `savedAt` merely because metadata was renamed.

### `deleteCity(id)`

Delete the encoded committed path directly.

- missing -> `notFound`;
- success -> `{ ok: true, value: undefined }` through the TypeScript adapter;
- other native failure -> `failed`.

A stale temp file does not make a missing committed city exist.

## 11. Atomicity and active-development tradeoffs

Use the smallest guarantees already promised by `CitySaveStore` and HPA-344:

- create uses create-new semantics and cannot overwrite an existing city;
- update/rename serialize first, write a sibling temp, and replace only at rename;
- a definite pre-replacement update/rename failure leaves the prior committed file unchanged;
- mutation success is returned only after its filesystem operation completes;
- paths never come from frontend strings other than opaque IDs transformed by the fixed encoder.

Do not add:

- `fsync`/directory sync;
- journal files;
- generations;
- checksums;
- lock files;
- rollback records;
- startup repair;
- multi-process coordination.

The product currently has one runtime, one persistence busy gate, manual saves, and disposable development data. HPA-544 owns additional hardening only if observed risk justifies it.

## 12. Test strategy

### Rust filesystem tests

Add `tempfile` as a **dev-only** dependency in `src-tauri/Cargo.toml`; using a maintained temp-directory utility is smaller than inventing a project-specific test-directory allocator/cleanup helper.

Test `CityFileStore` directly with fresh temp directories:

1. **empty list** — new root returns no summaries;
2. **create/list/read** — create a JSON-shaped record, list metadata, read the complete record;
3. **create conflict** — second create with the same ID returns `conflict` and the first record remains unchanged;
4. **update** — only `savedAt`/`snapshot` change;
5. **failed update preserves prior file** — make the deterministic temp path unwritable as a file (for example, create a directory at the temp path), assert `failed`, then read and compare the complete original record;
6. **rename** — only name changes; save time and snapshot remain unchanged;
7. **delete** — committed file disappears; second delete/read returns `notFound`;
8. **reopen** — create through one `CityFileStore`, construct a second store for the same temp root, then list/read the city;
9. **fixed-path authority** — create/read an ID containing path-looking characters such as `../outside\\city`; assert the committed file is still a direct child of the configured root and no caller-controlled relative path is created;
10. **list ignores stale temp** — leave a valid-looking `.json.tmp` sibling and confirm it does not appear as a city.

Do not build permission/vendor/power-loss matrices or test-only production failure switches.

### TypeScript adapter tests

Create `tests/runtime/persistence/tauriCitySaveStore.test.ts` and mock `@tauri-apps/api/core` exactly like the existing Tauri backend tests.

Focus on the adapter seam rather than reimplementing a fake filesystem:

- each `CitySaveStore` method calls the intended command with only record/ID/update/name arguments and no path;
- successful values pass through unchanged;
- list results are normalized with shared summary sorting;
- native `notFound`, `conflict`, and `failed` rejections become existing `CitySaveStoreError` objects with the correct operation/city ID;
- an unexpected rejection becomes generic `failed`.

Do not run the shared behavioral contract against a hand-written `invoke` fake. The common contract already proves frontend semantics for real in-memory/IndexedDB implementations; the Rust suite proves native filesystem semantics, and the TypeScript suite proves the IPC mapping. A fake native store would duplicate the behavior under test.

### Bootstrap proof

`src/main.ts` is a one-line host-selection change. Do not extract a production bootstrap factory solely to unit-test that ternary.

HPA-349 owns the real Tauri restart/Continue smoke. HPA-344 should still run `bun run tauri:build` as a compilation/package check after the adapter is wired.

## 13. Verification gate

Implementation should finish with:

```bash
bun run test:unit
bun run check
bun run lint
bun run format:check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
bun run tauri:build
```

The focused inner loops should be narrower:

```bash
cargo test -p caelum --lib city_store
bunx vitest run --project runtime tests/runtime/persistence/tauriCitySaveStore.test.ts
```

If Cargo's package filter differs because the package is exposed through the workspace under another target name, use the repository's existing `bun run rust:test` wrapper for the broad gate rather than adding another script.

No browser Playwright expansion is required in HPA-344. Existing browser E2E should remain unaffected; HPA-349 owns the new native smoke.

## 14. Documentation update

Update `docs/architecture.md` only where the current architecture still says:

```text
Tauri startup until HPA-344:
  createTauriBackend
  -> createMemoryCitySaveStore
```

Replace that temporary bridge with the final Phase 1 boundary:

```text
Tauri startup:
  createTauriBackend
  -> createTauriCitySaveStore
       -> six narrow Tauri storage commands
       -> <app_data_dir>/cities/*.json
  -> same city-list/create-city/runtime flow
```

Keep HPA-349 explicitly identified as the representative cross-host Save/reload/Continue smoke.

Do not rewrite unrelated architecture sections.

## 15. Acceptance criteria mapping

- **One file per city / six operations:** `CityFileStore` plus the six command registrations.
- **No arbitrary frontend path:** commands accept no paths; city IDs are always hex-encoded into a single filename component.
- **Create cannot overwrite:** `OpenOptions::create_new(true)` and conflict mapping.
- **Failed update preserves prior file:** serialize -> temp write -> rename, plus a real filesystem failure test before replacement.
- **No metadata index/migration/lock/recovery/security framework:** one directory scan and one JSON record per city only.
- **Adapter independent from gameplay host:** separate `tauriCitySaveStore.ts` and `city_store.rs`; no changes to `GameBackend`.
- **Focused tests:** Rust filesystem behavior + thin TypeScript IPC mapping; no exhaustive platform matrix.
- **Same small UI behavior across stores:** TypeScript returns the existing `CitySaveStoreResult` taxonomy and shared summary ordering.

## 16. Implementation sequence

Use three reviewable implementation slices:

1. Add the Rust city-file module, six commands, command registration, and focused temp-directory tests.
2. Add the TypeScript Tauri `CitySaveStore` adapter and command/error mapping tests.
3. Replace the native memory-store bootstrap, update architecture docs, and run the full frontend/Rust/Tauri verification gate.

No step should introduce a compatibility layer or refactor the existing runtime/UI to make HPA-344 fit.

## 17. Review focus

Reviewers should concentrate on four questions:

1. Can any frontend value become a filesystem path, or is every city ID forced through the fixed filename encoder?
2. Can create overwrite an existing city, or can update/rename touch the committed file before the temp replacement boundary?
3. Does the TypeScript adapter remain exactly `CitySaveStore` rather than leaking native filesystem/command concepts upward?
4. Did the implementation add any storage architecture that HPA-349, Phase 2, or current UI work does not actually need?

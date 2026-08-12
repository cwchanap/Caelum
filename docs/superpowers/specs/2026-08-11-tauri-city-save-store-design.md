# HPA-344 Native Tauri City Save Store Design

**Issue:** HPA-344  
**Status:** Approved  
**Decision date:** 2026-08-12  
**Prerequisite:** HPA-548 (done)  
**Downstream:** HPA-349 packaged cross-host UI smoke

## 1. Decision

Replace Tauri's temporary in-memory city store with one concrete native file store behind the existing six-operation `CitySaveStore`.

```text
Svelte / runtime
  -> CitySaveStore
      -> browser: IndexedDB
      -> native: tauriCitySaveStore.ts
           -> six Tauri commands
                -> src-tauri/src/city_store.rs
                     -> <app_data_dir>/cities/
```

Keep responsibilities narrow:

- Rust owns the application-data path, filename encoding, directory scan, JSON I/O, create-only commit, replacement writes, and native diagnostics.
- TypeScript owns six `invoke()` calls, existing `CitySaveStoreError` mapping, and shared `sortCitySummaries()` ordering.
- `workingSaveRuntime.ts`, Svelte, gameplay `GameBackend`, and the Rust gameplay core do not change.
- `MemoryCitySaveStore` remains as a test double after native bootstrap stops using it.

HPA-344 adds no generic repository, filesystem API, migration layer, lock service, recovery model, or native browser/WebDriver framework. Its native acceptance proof composes one Rust mock-runtime IPC test using the production command handler with the direct filesystem reopen test, both against isolated test roots.

## 2. Why HPA-344 is next

The browser Phase 1 persistence path is already complete:

- HPA-548 — six-operation `CitySaveStore`: done;
- HPA-343 — IndexedDB adapter: done;
- HPA-345 — New City flow: done;
- HPA-346 — City Library / Save / Load / Rename / Delete: done.

`src/main.ts` still selects `MemoryCitySaveStore` for Tauri, so the intended desktop release host loses cities when the process exits. HPA-344 is the smallest remaining unblocked Phase 1 implementation. HPA-349 stays downstream and owns packaged browser/native UI journey coverage; HPA-344 proves the native command/disk persistence seam automatically.

## 3. Approaches considered

### A. Rust city-file module + thin TypeScript adapter — selected

Create:

```text
src-tauri/src/city_store.rs
src/persistence/tauriCitySaveStore.ts
```

Advantages:

- reuses the current `CitySaveStore`;
- keeps paths out of frontend input;
- keeps gameplay and persistence command responsibilities separate;
- one file per city is easy to inspect while development saves are disposable;
- no production filesystem dependency;
- focused Rust tests can exercise real filesystem behavior directly.

### B. Frontend Tauri filesystem plugin — rejected

This would move app-data resolution and file policy into TypeScript and expose more filesystem surface than the six save operations need.

### C. Generic Rust repository/storage service — rejected

There is one native storage domain and six operations. A trait hierarchy, managed storage state, repository, command bus, or storage service would have no second current consumer.

## 4. Scope

### HPA-344 owns

- fixed `<app_data_dir>/cities/` root;
- one JSON `CitySaveRecord` per committed city;
- opaque-ID filename encoding;
- list/read/create/update/rename/delete;
- create-only conflict semantics;
- temp-first payload writes;
- exact native error wire for `notFound | conflict | failed`;
- thin TypeScript command adapter;
- a tiny tested host-store selector;
- reuse of one existing-quality host-rejection diagnostic formatter;
- Tauri bootstrap swap;
- focused Rust and Vitest coverage;
- one CI-portable mock-runtime IPC story using the production handler and one isolated test root;
- the existing direct second-store reopen proof for the stateless file store;
- current architecture/CLAUDE guidance updates;
- no human-only acceptance gate.

### HPA-344 does not own

- changes to `CitySaveStore`, `workingSaveRuntime.ts`, `createGameRuntime()`, or Svelte persistence APIs;
- gameplay `GameBackend` changes;
- IndexedDB changes;
- import/export or browser-to-native migration;
- old development-save compatibility;
- metadata indexes/caches;
- autosave, checkpoints, generations, history, recovery, or repair;
- retries or multi-window/multi-process ownership;
- encryption, signing, checksums, filesystem permission frameworks, fsync/directory-sync certification, or power-loss matrices;
- a native Playwright/test-driver framework or packaged desktop UI automation.

## 5. Storage layout and filename authority

Committed files live directly under:

```text
<app_data_dir>/cities/
```

The complete current `CitySaveRecord` is stored as UTF-8 JSON.

A city ID never becomes a path directly. Encode every UTF-8 byte as lowercase hex:

```text
city-<hex(id bytes)>.json
```

Examples:

```text
city-1      -> city-636974792d31.json
../outside  -> city-2e2e2f6f757473696465.json
```

`listCities()` recognizes only direct-child names in exactly that shape:

- `city-` prefix;
- non-empty even-length lowercase hexadecimal payload;
- `.json` suffix.

No reverse decoder is needed. After parsing a candidate record, list re-encodes `record.city.id` and requires it to equal the actual filename. A copied/renamed file whose embedded ID disagrees with its name is ignored rather than producing a ghost list row.

Entries that are directories, symlinks, temp files, unrelated JSON, malformed JSON, or filename/content-ID mismatches are skipped. Directory enumeration, entry metadata, and accepted-entry read I/O failures still fail `listCities()`.

This makes the city library resilient to known-invalid development files without adding repair UI or a corruption taxonomy: one malformed or misnamed file does not hide healthy cities. An OS read failure is ambiguous, so it is surfaced instead of silently hiding a potentially valid city.

## 6. Temp and commit model

Use one deterministic sibling temp name per city:

```text
city-<hex>.json.tmp
```

The supported product has one runtime and one persistence busy gate, so temp generations and lock ownership are unnecessary.

All payload bytes go through one temp writer:

```text
serialize complete record
  -> write/truncate sibling .tmp
  -> close file
  -> operation-specific commit
```

### Create commit

Create must satisfy both current contract requirements:

1. an existing city ID cannot be overwritten;
2. a create operation that returns failure leaves no committed city record.

Do not stream payload bytes into the committed path.

After the complete temp file is closed, create commits with a hard link:

```text
hard_link(temp, committed)
```

Because temp and committed are siblings, they are on the same filesystem. An existing committed destination is a conflict; success exposes the already-written file at the committed name. Then best-effort remove the temp name.

Temp-first create exists to satisfy the returned-failure contract: a write failure happens before a committed city name exists, while `hard_link` provides create-only commit without a check-then-write race or empty reservation file. Crash and power-loss behavior is explicitly outside HPA-344; there is no fsync or directory-sync guarantee.

### Update and rename commit

Update and rename read the existing committed record, construct the complete replacement, write it through the same temp writer, then:

```text
rename(temp, committed)
```

Do not remove/truncate the committed file before rename.

Update replaces only `savedAt` and `snapshot`. Rename replaces only `city.name`.

## 7. Rust module shape

Use one module-private concrete store:

```rust
struct CityFileStore {
    root: PathBuf,
}

impl CityFileStore {
    fn new(root: PathBuf) -> Self;

    fn from_app<R: tauri::Runtime>(
        app: &tauri::AppHandle<R>,
    ) -> Result<Self, CityStoreCommandError>;

    fn list_cities(&self) -> Result<Vec<CitySummary>, CityStoreCommandError>;
    fn read_city(&self, id: &str) -> Result<CitySaveRecord, CityStoreCommandError>;
    fn create_city(&self, record: CitySaveRecord) -> Result<CitySummary, CityStoreCommandError>;
    fn update_city(
        &self,
        id: &str,
        update: CitySaveUpdate,
    ) -> Result<CitySummary, CityStoreCommandError>;
    fn rename_city(
        &self,
        id: &str,
        name: String,
    ) -> Result<CitySummary, CityStoreCommandError>;
    fn delete_city(&self, id: &str) -> Result<(), CityStoreCommandError>;
}
```

`from_app()` resolves only:

```rust
app.path().app_data_dir()?.join("cities")
```

Keep it generic over `tauri::Runtime` so both the production runtime and Tauri's mock runtime use the same path-resolution code. Under `#[cfg(test)]` only, the mock app may manage an explicit `TestCityStoreRoot(PathBuf)`; `from_app()` uses that exact root when present and otherwise resolves the production `<app_data_dir>/cities` path. This creates no production command argument or filesystem override.

Do not manage `CityFileStore` as Tauri state.

All six `#[tauri::command]` functions are generic over `R: tauri::Runtime` and accept `tauri::AppHandle<R>`. This lets the same generated command wrappers execute under production Wry and Tauri's mock runtime without test-only command duplicates.

### Wire shapes

Mirror only the existing frontend storage wire:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CityIdentity {
    id: String,
    name: String,
    created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CitySummary {
    id: String,
    name: String,
    created_at: String,
    saved_at: String,
}
```

List may deserialize a partial `CityListRecord` so the full snapshot is not materialized into `serde_json::Value`. The file still has to be read/scanned; this is not an index or reduced disk-I/O claim.

Lock the duplicated TypeScript/Rust field names with exact JSON tests beside the error-wire test: serialize one `CitySummary` and one `CitySaveRecord`, and deserialize one literal camelCase `CitySaveUpdate`. Code generation is not justified for these three small wire records.

## 8. Native commands and error wire

Expose exactly:

```text
city_store_list
city_store_read
city_store_create
city_store_update
city_store_rename
city_store_delete
```

Register them beside gameplay commands in `src-tauri/src/lib.rs`; do not put them in `GameBackend` or `EngineState`. One generic function owns the complete production handler list:

```rust
fn with_commands<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![/* gameplay + city commands */])
}
```

Both `run()` and the mock-runtime IPC test call `with_commands()`. This is only handler registration reuse: managed gameplay state, plugins, setup, and production run-loop construction remain in `run()`.

No command accepts a path, filename, or directory.

Rust errors:

```rust
#[derive(Debug, Serialize)]
#[serde(tag = "code", content = "diagnostic", rename_all = "camelCase")]
enum CityStoreCommandError {
    NotFound,
    Conflict,
    Failed(String),
}
```

Lock these exact values in a Rust serde test:

```json
{"code":"notFound"}
{"code":"conflict"}
{"code":"failed","diagnostic":"disk full"}
```

The same test module also locks the exact camelCase JSON for `CitySummary`, `CitySaveRecord`, and `CitySaveUpdate` so frontend and native field names cannot drift independently.

TypeScript owns operation/city-ID context and maps only these codes into `citySaveStoreError()`.

## 9. TypeScript adapter and shared rejection diagnostics

`src/persistence/tauriCitySaveStore.ts` exposes only:

```ts
export function createTauriCitySaveStore(): CitySaveStore;
```

Each method invokes one native command. `listCities()` applies `sortCitySummaries()` after IPC.

Do not parse filesystem details or validate snapshots in TypeScript.

The repository already has guarded formatting for structured host rejections in `src/runtime/backend/persistence.ts`; raw `String(object)` would collapse useful context to `[object Object]`. Once the Tauri save adapter becomes a second consumer, extract only that pure formatting behavior to:

```text
src/hostDiagnostics.ts
```

with:

```ts
describeHostRejection(error: unknown): string | undefined
```

Both snapshot persistence and the Tauri save adapter use it. Error-code taxonomies stay separate.

## 10. Store selection

The gameplay backend already uses a small tested host selector. Apply the same idea to save storage without duplicating Tauri detection.

Create:

```text
src/persistence/createCitySaveStore.ts
```

with a plain function that receives the already-computed `nativeTauri` boolean:

```ts
createCitySaveStore({
  nativeTauri,
  createTauri?,
  createIndexedDb?,
}): CitySaveStore
```

Production defaults are `createTauriCitySaveStore` and `createIndexedDbCitySaveStore`. Tests inject both factories and prove true selects only Tauri and false selects only IndexedDB.

`src/main.ts` remains the sole production caller for `CitySaveStore` selection
and passes the already-computed `nativeTauri` boolean to the selector.
`createBackend()` continues to own gameplay-backend detection independently,
including its own `isTauriRuntime()` call; no second save-store detector,
`windowLike` detector, or host-selection framework is introduced.

## 11. Operation behavior

### List

Calling list on a fresh store initializes the fixed `cities/` root before reading it. This is storage initialization, not a frontend-visible write operation or arbitrary path mutation.

For each direct child:

1. filename must match the encoder-produced committed shape;
2. entry must be a regular file;
3. read bytes; I/O failure -> `failed`;
4. malformed `CityListRecord` -> skip;
5. re-encode embedded city ID; mismatch with filename -> skip;
6. return summary.

TypeScript applies shared ordering.

### Read

Derive encoded path from requested ID, read full record, map missing to `notFound`, parse failure to `failed`.

### Create

1. ensure root;
2. write complete temp record;
3. `hard_link(temp, committed)`;
4. existing destination -> `conflict`;
5. other link failure -> `failed`;
6. best-effort remove temp;
7. return summary only after link success.

### Update

Read existing record, preserve identity/name, replace only `savedAt`/`snapshot`, temp-write, rename over committed, then return summary.

### Rename

Read existing record, change only name, temp-write, rename over committed, then return summary.

### Delete

Remove encoded committed path. Missing -> `notFound`. A stale temp alone does not make a city exist.

## 12. Test strategy

Add `tempfile = "3"` as a dev-only Rust dependency.

### Rust filesystem tests

Keep the focused filesystem behaviors already present: empty list; create/list/read; conflict and failed-write preservation; update/rename field preservation; missing-operation errors; delete; second-store reopen; path-looking IDs; malformed/mismatched/non-file filtering; and production app-data path computation. These are behavior groups, not an exhaustive branch matrix.

Extend the existing serde test with exact JSON assertions for `CitySummary` and `CitySaveRecord`, plus a literal camelCase `CitySaveUpdate` deserialization assertion.

Add one mock-runtime IPC story that uses the production `with_commands()` handler to create, update, list, and read a city, then confirms the encoded committed file exists. It manages a `#[cfg(test)]`-only `TestCityStoreRoot` backed by `tempfile`, so it never writes to the developer or CI machine's real application-data directory. The existing no-override `from_app` test separately locks production path computation, and `second_store_instance_reopens_same_directory` separately proves the stateless disk-reopen invariant. A second mock app would add process-lifetime ceremony without testing new state because every command constructs a fresh `CityFileStore`.

### TypeScript tests

Adapter tests mock `@tauri-apps/api/core` and prove:

- exact six command names/arguments with no paths;
- successful value passthrough;
- shared list ordering;
- `notFound`, `conflict`, `failed` mapping;
- unknown primitive rejection -> readable generic `failed`;
- unknown structured rejection -> JSON-readable diagnostic via `describeHostRejection`.

Do not run the shared `defineCitySaveStoreContract` through a fake `invoke`; that would primarily test the fake.

Store-selection tests prove each host chooses only its intended durable adapter.

Existing runtime/backend tests continue to prove structured snapshot rejections remain readable after extracting the formatter.

## 13. Runtime acceptance boundary

Automated HPA-344 coverage proves:

- real filesystem semantics in temp directories;
- production app-data root computation through `mock_app` without an override;
- exact production command registration through the same generic handler function used by `run()`;
- native create/update/list/read argument and result serialization through Tauri IPC;
- the committed `city-<hex-id>.json` file exists under that root;
- a new `CityFileStore` instance can reopen the same directory and read committed data;
- native error serialization;
- TypeScript IPC mapping;
- tested native/browser store selection;
- existing browser UI E2E remains green.

Because commands hold no process-lifetime storage state, the IPC story plus direct second-store reopen test is the restart-equivalent proof at the command/disk seam and replaces the HPA-344 human smoke. It intentionally stops below packaged desktop UI automation: the existing browser E2E proves the City Library/New City/Save/Continue UI journey, while the Rust tests prove the native handler, serialization, path-construction, and disk persistence. HPA-349 remains downstream for a representative packaged cross-host UI journey rather than duplicating that infrastructure here.

## 14. Documentation cleanup

`docs/architecture.md` currently describes the temporary Tauri memory bridge in three connected places. HPA-344 updates all of them:

1. the `Tauri startup until HPA-344` block;
2. the `native Tauri store: temporary memory adapter until HPA-344` diagram line;
3. the prose calling the memory store an intentionally temporary bridge.

`CLAUDE.md` is updated to state browser = IndexedDB and native = application-data files.

`MemoryCitySaveStore` is **not deleted**. After bootstrap switches, it remains the focused test double used by runtime/persistence tests.

## 15. Acceptance criteria

HPA-344 is complete when:

- native desktop uses one file per city behind the existing six-operation `CitySaveStore`;
- no frontend-supplied paths exist;
- create cannot overwrite and a returned create failure leaves no committed record;
- update/rename do not touch committed payload before replacement;
- one malformed/mismatched city file cannot hide healthy city rows;
- native error JSON matches the TypeScript consumer;
- native/browser store selection is unit tested;
- `from_app` path resolution is exercised with Tauri's mock runtime;
- the production Tauri handler is exercised through mock-runtime create/update/list/read IPC against an isolated root;
- a second direct store instance reopens the same directory, and the encoded committed file exists;
- browser E2E remains green;
- no index, migration, compatibility, lock, recovery, fsync, or security framework is added.

## 16. Risks and limits

- The IPC story uses Tauri's version-coupled `tauri::test` invoke plumbing. If a Tauri upgrade breaks it, update the harness or revise this acceptance design; silently replacing it with registration-only or mocked-invoke coverage would no longer prove the serialization seam.
- Mock-runtime path resolution does not prove that a packaged macOS bundle can write its real Application Support directory. HPA-349 owns that packaged-host permission and UI journey.
- Crash/power-loss durability is intentionally unclaimed without fsync and directory-sync certification.

## 17. Review focus

1. Is every payload temp-first, with create committed create-only and update/rename replacement-only?
2. Can one malformed/misnamed file affect healthy city listing?
3. Does any frontend value become a path?
4. Are native error and record wires, host selection, production command registration, IPC serialization, disk reopen, and app-data path computation tested without building a fake native filesystem or GUI framework?
5. Did any abstraction appear that current Phase 1 work does not need?

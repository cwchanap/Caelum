# HPA-344 Native Tauri City Save Store Design

**Issue:** HPA-344  
**Status:** Proposed  
**Decision date:** 2026-08-11  
**Prerequisite:** HPA-548 (done)  
**Downstream:** HPA-349 automated cross-host smoke

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

HPA-344 adds no generic repository, filesystem API, migration layer, lock service, recovery model, or native automation framework.

## 2. Why HPA-344 is next

The browser Phase 1 persistence path is already complete:

- HPA-548 — six-operation `CitySaveStore`: done;
- HPA-343 — IndexedDB adapter: done;
- HPA-345 — New City flow: done;
- HPA-346 — City Library / Save / Load / Rename / Delete: done.

`src/main.ts` still selects `MemoryCitySaveStore` for Tauri, so the intended desktop release host loses cities when the process exits. HPA-344 is the smallest remaining unblocked Phase 1 implementation. HPA-349 stays downstream and owns automated browser/native restart coverage.

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
- current architecture/CLAUDE guidance updates;
- one explicit human-only restart smoke after the implementation commit.

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
- a native Playwright/test-driver framework.

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

Entries that are directories, symlinks, temp files, unrelated JSON, malformed JSON, or filename/content-ID mismatches are skipped. Directory/read I/O failures still fail `listCities()`.

This makes the city library resilient without adding repair UI or a corruption taxonomy: one bad development file does not hide healthy cities.

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

Because temp and committed are siblings, they are on the same filesystem. An existing committed destination is a conflict; success exposes the already-complete file at the committed name. Then best-effort remove the temp name.

Crash shape without fsync certification:

- before `hard_link`: only `.tmp` may remain, and list ignores it;
- after `hard_link`: the committed name refers to the complete temp contents; a stale `.tmp` name may remain.

This is not a power-loss/fsync guarantee. It only avoids the plan's previous torn committed create path and keeps create-only semantics without a reservation file.

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

Keep it generic over `tauri::Runtime` so the existing `tauri::test::mock_app()` path can prove the production path-resolution line without doing disk I/O.

Do not manage `CityFileStore` as Tauri state.

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

Register them beside gameplay commands in `src-tauri/src/lib.rs`; do not put them in `GameBackend` or `EngineState`.

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

`src/main.ts` remains the single place that calls `isTauriRuntime()`. No second `windowLike` detector or host-selection framework is introduced.

## 11. Operation behavior

### List

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

Required:

1. empty list;
2. create/list/read;
3. create conflict preserves original;
4. failed create commits nothing;
5. update changes only saved payload;
6. failed update preserves prior committed record;
7. rename changes only name;
8. missing update -> `notFound`;
9. missing rename -> `notFound`;
10. delete + second delete/read -> `notFound`;
11. reopen through a second `CityFileStore`;
12. path-looking ID stays inside root;
13. list skips stale temp/unrelated JSON/non-file/malformed JSON;
14. list skips filename/content-ID mismatch;
15. `from_app(mock_app.handle())` resolves exactly `app_data_dir()/cities`;
16. native error serde wire is exact.

The `from_app` test does not call storage commands or write to app data. A command-level mock-app persistence test would risk writing into the machine's real resolved application-data location, so the remaining registration + real disk path is intentionally left to the human smoke.

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
- app-data root computation through `mock_app`;
- native error serialization;
- TypeScript IPC mapping;
- tested native/browser store selection;
- existing browser E2E remains green.

One seam remains intentionally manual: actual Tauri command registration and real desktop restart persistence.

After the final implementation commit, the executing agent must stop and hand off this check to a human:

```text
tauri:dev
-> create named city
-> make one visible gameplay change
-> Save Now
-> fully quit
-> tauri:dev
-> city appears
-> Continue/Load
-> saved change remains
-> committed city-<hex>.json exists under resolved app_data_dir/cities
```

The human gate is required for HPA-344 completion, but it creates no checked-in harness. HPA-349 later automates the representative cross-host smoke.

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
- browser E2E remains green;
- the final human restart smoke passes;
- no index, migration, compatibility, lock, recovery, fsync, or security framework is added.

## 16. Review focus

1. Is every payload temp-first, with create committed create-only and update/rename replacement-only?
2. Can one malformed/misnamed file affect healthy city listing?
3. Does any frontend value become a path?
4. Are native error wire, host selection, and app-data path computation tested without building a fake native filesystem?
5. Did any abstraction appear that current Phase 1 work does not need?

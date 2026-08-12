# HPA-344 Native Tauri City Save Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Tauri's session-only memory city store with the smallest durable application-data-file implementation of the existing six-operation `CitySaveStore`.

**Architecture:** `src-tauri/src/city_store.rs` owns the fixed native save directory and real filesystem semantics. Every payload is written to a sibling temp file first; create commits the complete temp file with create-only `hard_link`, while update/rename replace the prior committed file with `rename`. `src/persistence/tauriCitySaveStore.ts` remains a thin Tauri-command adapter. A tiny tested store selector chooses native files vs IndexedDB from the already-computed `nativeTauri` boolean; runtime/Svelte/gameplay interfaces stay unchanged.

**Tech Stack:** Rust 2021, Tauri 2.11, `std::fs`, Serde/`serde_json`, TypeScript, `@tauri-apps/api/core`, Vitest, Bun, dev-only Rust `tempfile`.

## Global Constraints

- Keep the existing six `CitySaveStore` operations exactly: `listCities`, `readCity`, `createCity`, `updateCity`, `renameCity`, `deleteCity`.
- Native committed records live only under `<app_data_dir>/cities/`.
- Store one complete `CitySaveRecord` JSON file per city; no index, sidecar, database, generation directory, or cache.
- No command accepts a frontend path, filename, or directory.
- Encode every city ID as `city-<lowercase hex UTF-8 bytes>.json`.
- `listCities` accepts only encoder-shaped direct-child filenames, regular files, parseable list records, and records whose embedded ID re-encodes to the actual filename.
- Malformed/mismatched/non-file entries are skipped; directory enumeration, entry metadata, and accepted-entry read I/O failures remain `failed` rather than silently hiding an ambiguous city.
- Never stream city payload bytes into a committed path.
- `createCity` writes a complete sibling temp and commits create-only via `std::fs::hard_link(temp, committed)`.
- `updateCity` and `renameCity` write the same temp path then `std::fs::rename(temp, committed)`.
- An existing create destination maps to `conflict`; a create operation that returns failure must leave `readCity(id)` as `notFound`.
- Snapshot JSON remains opaque to storage; `GameBackend.restoreSnapshot()` owns gameplay validation.
- Store errors remain exactly `notFound | conflict | failed`.
- Lock the exact Rust error JSON and the camelCase `CitySummary`, `CitySaveRecord`, and `CitySaveUpdate` wire fields with serde tests before relying on TypeScript mocks.
- Reuse a single guarded `describeHostRejection()` formatter for snapshot-host and city-store unexpected rejections; do not merge their error-code taxonomies.
- Keep gameplay Tauri commands and city-store commands separate from each other and from `EngineState`.
- `src/main.ts` is the sole production caller for `CitySaveStore` selection and
  passes its already-computed `nativeTauri` boolean to the selector.
- `createBackend()` continues to own gameplay-backend detection independently;
  its `isTauriRuntime()` call is not part of save-store selection. Do not couple
  these host decisions or introduce a second save-store detector.
- `MemoryCitySaveStore` remains as a test double after native bootstrap stops using it.
- No migrations, compatibility readers, IndexedDB import, autosave/checkpoints, recovery/repair, metadata index, retries, locks, multi-process ownership, import/export, encryption/signing/checksums, fsync certification, or power-loss matrix.
- HPA-344 replaces its human restart smoke with a CI-portable composition: one production-handler mock-runtime IPC story plus the direct second-store reopen test. HPA-349 owns packaged native/browser UI coverage and real-bundle application-data permission.

---

## File structure

### Production

- Create `src-tauri/src/city_store.rs`
  - wire records;
  - fixed root and ID encoding;
  - authoritative list filtering;
  - shared temp writer;
  - create-only hard-link commit;
  - update/rename replacement;
  - six commands;
  - focused Rust tests in-module.
- Modify `src-tauri/src/lib.rs`
  - `mod city_store;`
  - register six commands beside gameplay commands.
- Modify `src-tauri/Cargo.toml`
  - add dev-only `tempfile = "3"`.
- Modify `Cargo.lock`
  - dependency resolution if changed.
- Create `src/hostDiagnostics.ts`
  - one guarded `describeHostRejection(error)` helper.
- Modify `src/runtime/backend/persistence.ts`
  - reuse `describeHostRejection`;
  - remove its private duplicate formatter.
- Create `src/persistence/tauriCitySaveStore.ts`
  - six invokes;
  - native error recognition;
  - shared error envelope + list sorting.
- Create `src/persistence/createCitySaveStore.ts`
  - tested selection from `nativeTauri`.
- Modify `src/main.ts`
  - select save store through `createCitySaveStore({ nativeTauri })`.

### Tests

- Create `tests/runtime/persistence/tauriCitySaveStore.test.ts`
  - exact commands;
  - list sorting;
  - native error mapping;
  - primitive/object unexpected rejection diagnostics.
- Create `tests/runtime/persistence/citySaveStoreSelection.test.ts`
  - native selects only Tauri;
  - browser selects only IndexedDB.
- Existing `tests/runtime/tauriBackend.test.ts`
  - remains regression coverage for structured host diagnostic formatting after helper extraction.
- Existing memory-store/runtime tests remain unchanged unless a concrete compiler/test failure requires an import-only adjustment.

### Documentation

- Modify `docs/architecture.md`
  - update all three temporary-memory-store references in the current persistence boundary.
- Modify `CLAUDE.md`
  - record native files as delivered;
  - retain `MemoryCitySaveStore` as a test double;
  - keep HPA-349 as downstream automated smoke.

No other files belong in the implementation unless a concrete compile/test failure proves the need.

---

### Task 1: Implement the native city-file module and command boundary

**Files:**
- Create: `src-tauri/src/city_store.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `Cargo.lock`

**Interfaces:**
- Consumes: `tauri::AppHandle<R>`, `tauri::Manager::path()`, standard filesystem APIs, `serde_json::Value`.
- Produces wire types: `CityIdentity`, `CitySaveRecord`, `CitySaveUpdate`, `CitySummary`.
- Produces `CityStoreCommandError::{NotFound, Conflict, Failed(String)}` with exact `{ code, diagnostic? }` JSON.
- Produces commands: `city_store_list|read|create|update|rename|delete`.
- Produces no gameplay/runtime interface changes.

- [ ] **Step 1: Add the test dependency and module declaration**

In `src-tauri/Cargo.toml`:

```toml
[dev-dependencies]
tauri = { version = "2.11.0", features = ["test"] }
tempfile = "3"
```

In `src-tauri/src/lib.rs`:

```rust
mod city_store;
```

Run:

```bash
cargo check -p caelum
```

Expected: PASS and update `Cargo.lock` if dependency resolution changes.

- [ ] **Step 2: Add wire types, filename helpers, error wire, store shell, and red tests**

Create `src-tauri/src/city_store.rs` starting with:

```rust
use std::{
    ffi::OsStr,
    fmt::Write as _,
    fs::{self, OpenOptions},
    io::Write as _,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::Manager;

const CITY_DIRECTORY: &str = "cities";
const CITY_PREFIX: &str = "city-";
const CITY_SUFFIX: &str = ".json";
const TEMP_SUFFIX: &str = ".tmp";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CityIdentity {
    id: String,
    name: String,
    created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CitySaveRecord {
    city: CityIdentity,
    saved_at: String,
    snapshot: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CitySaveUpdate {
    saved_at: String,
    snapshot: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CitySummary {
    id: String,
    name: String,
    created_at: String,
    saved_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CityListRecord {
    city: CityIdentity,
    saved_at: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "code", content = "diagnostic", rename_all = "camelCase")]
pub(crate) enum CityStoreCommandError {
    NotFound,
    Conflict,
    Failed(String),
}
```

Add helpers:

```rust
fn failed(error: impl ToString) -> CityStoreCommandError {
    CityStoreCommandError::Failed(error.to_string())
}

fn encoded_city_filename(id: &str) -> String {
    let mut filename =
        String::with_capacity(CITY_PREFIX.len() + id.len() * 2 + CITY_SUFFIX.len());
    filename.push_str(CITY_PREFIX);
    for byte in id.as_bytes() {
        write!(&mut filename, "{byte:02x}").expect("writing to String cannot fail");
    }
    filename.push_str(CITY_SUFFIX);
    filename
}

fn is_committed_city_filename(name: &OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    let Some(hex) = name
        .strip_prefix(CITY_PREFIX)
        .and_then(|name| name.strip_suffix(CITY_SUFFIX))
    else {
        return false;
    };

    !hex.is_empty()
        && hex.len() % 2 == 0
        && hex
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn summary(record: &CitySaveRecord) -> CitySummary {
    CitySummary {
        id: record.city.id.clone(),
        name: record.city.name.clone(),
        created_at: record.city.created_at.clone(),
        saved_at: record.saved_at.clone(),
    }
}

struct CityFileStore {
    root: PathBuf,
}

impl CityFileStore {
    fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn from_app<R: tauri::Runtime>(
        app: &tauri::AppHandle<R>,
    ) -> Result<Self, CityStoreCommandError> {
        Ok(Self::new(
            app.path()
                .app_data_dir()
                .map_err(failed)?
                .join(CITY_DIRECTORY),
        ))
    }

    fn city_path(&self, id: &str) -> PathBuf {
        self.root.join(encoded_city_filename(id))
    }

    fn temp_path(&self, id: &str) -> PathBuf {
        self.root
            .join(format!("{}{}", encoded_city_filename(id), TEMP_SUFFIX))
    }
}
```

Add a `#[cfg(test)] mod tests` with a local `record(id, name)` fixture and these required tests:

```rust
#[test]
fn city_store_command_error_wire_is_stable() {
    assert_eq!(
        serde_json::to_value(CityStoreCommandError::NotFound).unwrap(),
        json!({ "code": "notFound" })
    );
    assert_eq!(
        serde_json::to_value(CityStoreCommandError::Conflict).unwrap(),
        json!({ "code": "conflict" })
    );
    assert_eq!(
        serde_json::to_value(CityStoreCommandError::Failed("disk full".into())).unwrap(),
        json!({ "code": "failed", "diagnostic": "disk full" })
    );
}

#[test]
fn empty_store_lists_no_cities() {
    let temp = tempdir().expect("temp dir");
    let store = CityFileStore::new(temp.path().join("cities"));
    assert_eq!(
        store.list_cities().expect("list succeeds"),
        Vec::<CitySummary>::new()
    );
}

#[test]
fn create_list_and_read_round_trip() {
    let temp = tempdir().expect("temp dir");
    let store = CityFileStore::new(temp.path().join("cities"));
    let city = record("city-1", "First");

    assert_eq!(store.create_city(city.clone()).expect("create"), summary(&city));
    assert_eq!(store.list_cities().expect("list"), vec![summary(&city)]);
    assert_eq!(store.read_city("city-1").expect("read"), city);
}

#[test]
fn create_conflict_preserves_original() {
    let temp = tempdir().expect("temp dir");
    let store = CityFileStore::new(temp.path().join("cities"));
    let original = record("city-1", "First");
    store.create_city(original.clone()).expect("seed");

    assert!(matches!(
        store.create_city(record("city-1", "Replacement")),
        Err(CityStoreCommandError::Conflict)
    ));
    assert_eq!(store.read_city("city-1").expect("original"), original);
}

#[test]
fn failed_create_commits_nothing() {
    let temp = tempdir().expect("temp dir");
    let store = CityFileStore::new(temp.path().join("cities"));
    fs::create_dir_all(&store.root).expect("root");
    fs::create_dir(store.temp_path("city-1")).expect("block temp path");

    assert!(matches!(
        store.create_city(record("city-1", "First")),
        Err(CityStoreCommandError::Failed(_))
    ));
    assert!(matches!(
        store.read_city("city-1"),
        Err(CityStoreCommandError::NotFound)
    ));
    assert!(!store.city_path("city-1").exists());
}
```

Run:

```bash
cargo test -p caelum --lib city_store
```

Expected: the module **does not compile yet** because the storage methods referenced by the tests are intentionally not implemented. No test is claimed to run before compilation succeeds.

- [ ] **Step 3: Implement root setup, resilient list/read, the shared temp writer, and create-only commit**

Add:

```rust
fn ensure_root(&self) -> Result<(), CityStoreCommandError> {
    fs::create_dir_all(&self.root).map_err(failed)
}

fn list_cities(&self) -> Result<Vec<CitySummary>, CityStoreCommandError> {
    self.ensure_root()?;
    let mut cities = Vec::new();

    for entry in fs::read_dir(&self.root).map_err(failed)? {
        let entry = entry.map_err(failed)?;
        let file_name = entry.file_name();

        if !is_committed_city_filename(&file_name) {
            continue;
        }
        if !entry.file_type().map_err(failed)?.is_file() {
            continue;
        }

        let bytes = fs::read(entry.path()).map_err(failed)?;
        let Ok(record) = serde_json::from_slice::<CityListRecord>(&bytes) else {
            continue;
        };

        let expected_name = encoded_city_filename(&record.city.id);
        if file_name.to_str() != Some(expected_name.as_str()) {
            continue;
        }

        cities.push(CitySummary {
            id: record.city.id,
            name: record.city.name,
            created_at: record.city.created_at,
            saved_at: record.saved_at,
        });
    }

    Ok(cities)
}

fn read_city(&self, id: &str) -> Result<CitySaveRecord, CityStoreCommandError> {
    let bytes = fs::read(self.city_path(id)).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            CityStoreCommandError::NotFound
        } else {
            failed(error)
        }
    })?;

    serde_json::from_slice(&bytes).map_err(failed)
}

fn write_temp_record(
    &self,
    id: &str,
    record: &CitySaveRecord,
) -> Result<PathBuf, CityStoreCommandError> {
    self.ensure_root()?;
    let bytes = serde_json::to_vec(record).map_err(failed)?;
    let temp = self.temp_path(id);

    let _ = fs::remove_file(&temp);
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&temp)
        .map_err(failed)?;

    if let Err(error) = file.write_all(&bytes) {
        drop(file);
        let _ = fs::remove_file(&temp);
        return Err(failed(error));
    }

    drop(file);
    Ok(temp)
}

fn create_city(
    &self,
    record: CitySaveRecord,
) -> Result<CitySummary, CityStoreCommandError> {
    let id = record.city.id.clone();
    let committed = self.city_path(&id);
    let temp = self.write_temp_record(&id, &record)?;

    let result = fs::hard_link(&temp, &committed);
    let _ = fs::remove_file(&temp);

    match result {
        Ok(()) => Ok(summary(&record)),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(CityStoreCommandError::Conflict)
        }
        Err(error) => Err(failed(error)),
    }
}
```

Important: `hard_link` is the create-only commit primitive. Do not replace it with a read-before-write check or an empty committed reservation.

Run:

```bash
cargo test -p caelum --lib city_store
```

Expected: the initial create/list/read/conflict/failed-create/error-wire tests PASS.

- [ ] **Step 4: Add all remaining filesystem tests red-first**

Add required tests for:

```text
update_changes_only_saved_payload
failed_update_preserves_committed_record
rename_changes_only_name
missing_update_is_not_found
missing_rename_is_not_found
delete_then_read_and_second_delete_are_not_found
second_store_instance_reopens_same_directory
encoded_ids_cannot_escape_store_root
list_skips_stale_temp_unrelated_json_and_non_files
list_skips_malformed_committed_json
list_skips_filename_content_id_mismatch
from_app_uses_app_data_cities_child
```

Use concrete assertions, including:

```rust
#[test]
fn missing_update_is_not_found() {
    let temp = tempdir().expect("temp dir");
    let store = CityFileStore::new(temp.path().join("cities"));

    assert!(matches!(
        store.update_city(
            "missing",
            CitySaveUpdate {
                saved_at: "2026-08-11T19:00:00.000Z".into(),
                snapshot: json!({}),
            },
        ),
        Err(CityStoreCommandError::NotFound)
    ));
}

#[test]
fn missing_rename_is_not_found() {
    let temp = tempdir().expect("temp dir");
    let store = CityFileStore::new(temp.path().join("cities"));

    assert!(matches!(
        store.rename_city("missing", "Renamed".into()),
        Err(CityStoreCommandError::NotFound)
    ));
}

#[test]
fn from_app_uses_app_data_cities_child() {
    let app = tauri::test::mock_app();
    let expected = app
        .handle()
        .path()
        .app_data_dir()
        .expect("app data dir")
        .join(CITY_DIRECTORY);

    let store = CityFileStore::from_app(app.handle()).expect("store path");
    assert_eq!(store.root, expected);
}
```

For malformed/mismatch authority, create the candidate files directly under the temp root:

```rust
#[test]
fn list_skips_malformed_and_mismatched_city_files() {
    let temp = tempdir().expect("temp dir");
    let store = CityFileStore::new(temp.path().join("cities"));
    let valid = record("city-1", "Valid");
    store.create_city(valid.clone()).expect("seed");

    fs::write(store.root.join("city-ab.json"), b"{bad json").expect("malformed");

    let mismatched = record("city-a", "Copied");
    fs::write(
        store.root.join(encoded_city_filename("city-b")),
        serde_json::to_vec(&mismatched).unwrap(),
    )
    .expect("mismatched");

    fs::create_dir(store.root.join("city-cd.json")).expect("directory lookalike");
    fs::write(store.root.join("notes.json"), b"{}").expect("unrelated");

    assert_eq!(store.list_cities().expect("list"), vec![summary(&valid)]);
}
```

Run:

```bash
cargo test -p caelum --lib city_store
```

Expected: FAIL to compile until update/rename/delete/replacement exist.

- [ ] **Step 5: Implement replacement, update, rename, and delete**

Reuse `write_temp_record`:

```rust
fn replace_record(
    &self,
    id: &str,
    record: &CitySaveRecord,
) -> Result<(), CityStoreCommandError> {
    let temp = self.write_temp_record(id, record)?;
    let committed = self.city_path(id);

    if let Err(error) = fs::rename(&temp, &committed) {
        let _ = fs::remove_file(&temp);
        return Err(failed(error));
    }

    Ok(())
}

fn update_city(
    &self,
    id: &str,
    update: CitySaveUpdate,
) -> Result<CitySummary, CityStoreCommandError> {
    let existing = self.read_city(id)?;
    let replacement = CitySaveRecord {
        city: existing.city,
        saved_at: update.saved_at,
        snapshot: update.snapshot,
    };

    self.replace_record(id, &replacement)?;
    Ok(summary(&replacement))
}

fn rename_city(
    &self,
    id: &str,
    name: String,
) -> Result<CitySummary, CityStoreCommandError> {
    let existing = self.read_city(id)?;
    let replacement = CitySaveRecord {
        city: CityIdentity {
            name,
            ..existing.city
        },
        saved_at: existing.saved_at,
        snapshot: existing.snapshot,
    };

    self.replace_record(id, &replacement)?;
    Ok(summary(&replacement))
}

fn delete_city(&self, id: &str) -> Result<(), CityStoreCommandError> {
    fs::remove_file(self.city_path(id)).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            CityStoreCommandError::NotFound
        } else {
            failed(error)
        }
    })
}
```

Run:

```bash
cargo test -p caelum --lib city_store
```

Expected: all city-store filesystem/path/error-wire tests PASS.

- [ ] **Step 6: Add and register the six Tauri commands**

Add wrappers:

```rust
#[tauri::command]
pub(crate) fn city_store_list(
    app: tauri::AppHandle,
) -> Result<Vec<CitySummary>, CityStoreCommandError> {
    CityFileStore::from_app(&app)?.list_cities()
}

#[tauri::command]
pub(crate) fn city_store_read(
    app: tauri::AppHandle,
    id: String,
) -> Result<CitySaveRecord, CityStoreCommandError> {
    CityFileStore::from_app(&app)?.read_city(&id)
}

#[tauri::command]
pub(crate) fn city_store_create(
    app: tauri::AppHandle,
    record: CitySaveRecord,
) -> Result<CitySummary, CityStoreCommandError> {
    CityFileStore::from_app(&app)?.create_city(record)
}

#[tauri::command]
pub(crate) fn city_store_update(
    app: tauri::AppHandle,
    id: String,
    update: CitySaveUpdate,
) -> Result<CitySummary, CityStoreCommandError> {
    CityFileStore::from_app(&app)?.update_city(&id, update)
}

#[tauri::command]
pub(crate) fn city_store_rename(
    app: tauri::AppHandle,
    id: String,
    name: String,
) -> Result<CitySummary, CityStoreCommandError> {
    CityFileStore::from_app(&app)?.rename_city(&id, name)
}

#[tauri::command]
pub(crate) fn city_store_delete(
    app: tauri::AppHandle,
    id: String,
) -> Result<(), CityStoreCommandError> {
    CityFileStore::from_app(&app)?.delete_city(&id)
}
```

Append to the existing `tauri::generate_handler![]` in `src-tauri/src/lib.rs`:

```rust
city_store::city_store_list,
city_store::city_store_read,
city_store::city_store_create,
city_store::city_store_update,
city_store::city_store_rename,
city_store::city_store_delete,
```

Do not move gameplay commands or add storage to `EngineState`.

Run:

```bash
cargo fmt --all --check
cargo test -p caelum --lib city_store
cargo clippy -p caelum --all-targets -- -D warnings
```

Expected: PASS.

- [ ] **Step 7: Commit Task 1**

```bash
git add src-tauri/src/city_store.rs src-tauri/src/lib.rs src-tauri/Cargo.toml Cargo.lock
git commit -m "feat: add native city file store"
```

---

### Task 2: Add the thin TypeScript adapter, reuse diagnostics, and test store selection

**Files:**
- Create: `src/hostDiagnostics.ts`
- Modify: `src/runtime/backend/persistence.ts`
- Create: `src/persistence/tauriCitySaveStore.ts`
- Create: `src/persistence/createCitySaveStore.ts`
- Create: `tests/runtime/persistence/tauriCitySaveStore.test.ts`
- Create: `tests/runtime/persistence/citySaveStoreSelection.test.ts`

**Interfaces:**
- Produces: `describeHostRejection(error: unknown): string | undefined`.
- Produces: `createTauriCitySaveStore(): CitySaveStore`.
- Produces: `createCitySaveStore({ nativeTauri, createTauri?, createIndexedDb? }): CitySaveStore`.
- Reuses: `citySaveStoreError()`, `sortCitySummaries()`.
- Keeps snapshot error taxonomy and city-save error taxonomy separate.

- [ ] **Step 1: Extract the already-used robust host rejection formatter**

Create `src/hostDiagnostics.ts`:

```ts
export function describeHostRejection(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (error === undefined) return undefined;

  if (typeof error === "object" && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error);
}
```

In `src/runtime/backend/persistence.ts`:

```ts
import { describeHostRejection } from "../../hostDiagnostics";
```

Delete the private `diagnosticFor()` function and change:

```ts
diagnostic: diagnosticFor(error),
```

to:

```ts
diagnostic: describeHostRejection(error),
```

Do not move snapshot error-code parsing into the shared helper.

Run the existing focused regression:

```bash
bunx vitest run --project runtime tests/runtime/tauriBackend.test.ts
```

Expected: PASS, including the existing structured-object diagnostic expectation.

- [ ] **Step 2: Write Tauri store adapter tests red-first**

Create `tests/runtime/persistence/tauriCitySaveStore.test.ts` using the existing `@tauri-apps/api/core` mock pattern.

Required cases:

```text
invokes_only_the_six_narrow_commands
sorts_native_list_with_shared_ordering
maps_not_found
maps_conflict
maps_failed_with_native_diagnostic
maps_unknown_primitive_rejection
maps_unknown_object_rejection_to_json_diagnostic
```

The unknown-object assertion must be concrete:

```ts
it("keeps an unexpected structured rejection readable", async () => {
  invokeMock.mockRejectedValue({
    code: "transportDown",
    context: { attempt: 2 },
  });

  const result = await createTauriCitySaveStore().deleteCity("city-1");

  expect(result).toEqual({
    ok: false,
    error: {
      operation: "deleteCity",
      code: "failed",
      cityId: "city-1",
      diagnostic: '{"code":"transportDown","context":{"attempt":2}}',
    },
  });
});
```

Run:

```bash
bunx vitest run --project runtime tests/runtime/persistence/tauriCitySaveStore.test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement native error recognition and the six invokes**

Create `src/persistence/tauriCitySaveStore.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";

import { describeHostRejection } from "../hostDiagnostics";
import {
  citySaveStoreError,
  sortCitySummaries,
  type CitySaveRecord,
  type CitySaveStore,
  type CitySaveStoreErrorCode,
  type CitySaveStoreOperation,
  type CitySaveStoreResult,
  type CitySummary,
} from "./citySaveStore";

interface NativeCityStoreError {
  code: CitySaveStoreErrorCode;
  diagnostic?: string;
}

function asNativeCityStoreError(error: unknown): NativeCityStoreError | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }

  const code = (error as { code?: unknown }).code;
  if (code !== "notFound" && code !== "conflict" && code !== "failed") {
    return null;
  }

  const diagnostic = (error as { diagnostic?: unknown }).diagnostic;
  return {
    code,
    ...(code === "failed" && typeof diagnostic === "string"
      ? { diagnostic }
      : {}),
  };
}

async function runCommand<T>(
  operation: CitySaveStoreOperation,
  cityId: string | undefined,
  command: () => Promise<T>,
): Promise<CitySaveStoreResult<T>> {
  try {
    return { ok: true, value: await command() };
  } catch (error: unknown) {
    const native = asNativeCityStoreError(error);
    const code = native?.code ?? "failed";

    return {
      ok: false,
      error: citySaveStoreError(operation, code, {
        cityId,
        ...(code === "failed"
          ? {
              diagnostic:
                native?.diagnostic ?? describeHostRejection(error),
            }
          : {}),
      }),
    };
  }
}

export function createTauriCitySaveStore(): CitySaveStore {
  return {
    async listCities() {
      const result = await runCommand<CitySummary[]>(
        "listCities",
        undefined,
        () => invoke<CitySummary[]>("city_store_list"),
      );
      return result.ok
        ? { ok: true, value: sortCitySummaries(result.value) }
        : result;
    },

    readCity(id) {
      return runCommand("readCity", id, () =>
        invoke<CitySaveRecord>("city_store_read", { id }),
      );
    },

    createCity(record) {
      return runCommand("createCity", record.city.id, () =>
        invoke<CitySummary>("city_store_create", { record }),
      );
    },

    updateCity(id, update) {
      return runCommand("updateCity", id, () =>
        invoke<CitySummary>("city_store_update", { id, update }),
      );
    },

    renameCity(id, name) {
      return runCommand("renameCity", id, () =>
        invoke<CitySummary>("city_store_rename", { id, name }),
      );
    },

    deleteCity(id) {
      return runCommand("deleteCity", id, () =>
        invoke<void>("city_store_delete", { id }),
      );
    },
  };
}
```

Run:

```bash
bunx vitest run --project runtime tests/runtime/persistence/tauriCitySaveStore.test.ts
bunx vitest run --project runtime tests/runtime/tauriBackend.test.ts
```

Expected: PASS.

- [ ] **Step 4: Add a small tested store selector**

Create `src/persistence/createCitySaveStore.ts`:

```ts
import type { CitySaveStore } from "./citySaveStore";
import { createIndexedDbCitySaveStore } from "./indexedDbCitySaveStore";
import { createTauriCitySaveStore } from "./tauriCitySaveStore";

export interface CreateCitySaveStoreOptions {
  nativeTauri: boolean;
  createTauri?: () => CitySaveStore;
  createIndexedDb?: () => CitySaveStore;
}

export function createCitySaveStore({
  nativeTauri,
  createTauri = createTauriCitySaveStore,
  createIndexedDb = createIndexedDbCitySaveStore,
}: CreateCitySaveStoreOptions): CitySaveStore {
  return nativeTauri ? createTauri() : createIndexedDb();
}
```

Create `tests/runtime/persistence/citySaveStoreSelection.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import type { CitySaveStore } from "../../../src/persistence/citySaveStore";
import { createCitySaveStore } from "../../../src/persistence/createCitySaveStore";

describe("city save store selection", () => {
  it("uses Tauri storage when nativeTauri is true", () => {
    const tauri = {} as CitySaveStore;
    const indexedDb = {} as CitySaveStore;
    const createTauri = vi.fn(() => tauri);
    const createIndexedDb = vi.fn(() => indexedDb);

    expect(
      createCitySaveStore({
        nativeTauri: true,
        createTauri,
        createIndexedDb,
      }),
    ).toBe(tauri);
    expect(createTauri).toHaveBeenCalledTimes(1);
    expect(createIndexedDb).not.toHaveBeenCalled();
  });

  it("uses IndexedDB storage when nativeTauri is false", () => {
    const tauri = {} as CitySaveStore;
    const indexedDb = {} as CitySaveStore;
    const createTauri = vi.fn(() => tauri);
    const createIndexedDb = vi.fn(() => indexedDb);

    expect(
      createCitySaveStore({
        nativeTauri: false,
        createTauri,
        createIndexedDb,
      }),
    ).toBe(indexedDb);
    expect(createTauri).not.toHaveBeenCalled();
    expect(createIndexedDb).toHaveBeenCalledTimes(1);
  });
});
```

Do not add `windowLike` here. `isTauriRuntime()` and its marker cases already have focused coverage in `tests/runtime/backendSelection.test.ts`; this selector only maps that boolean to the two current stores.

Run:

```bash
bunx vitest run --project runtime \
  tests/runtime/persistence/tauriCitySaveStore.test.ts \
  tests/runtime/persistence/citySaveStoreSelection.test.ts \
  tests/runtime/tauriBackend.test.ts \
  tests/runtime/backendSelection.test.ts
bun run check
bun run lint:svelte
bun run format:check
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add \
  src/hostDiagnostics.ts \
  src/runtime/backend/persistence.ts \
  src/persistence/tauriCitySaveStore.ts \
  src/persistence/createCitySaveStore.ts \
  tests/runtime/persistence/tauriCitySaveStore.test.ts \
  tests/runtime/persistence/citySaveStoreSelection.test.ts
git commit -m "feat: add Tauri city save adapter"
```

---

### Task 3: Wire native durability, update guidance, verify, and commit

**Files:**
- Modify: `src/main.ts`
- Modify: `docs/architecture.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: existing `isTauriRuntime()`.
- Consumes: `createCitySaveStore({ nativeTauri })`.
- Produces: native startup = Tauri files; browser startup = IndexedDB.
- Preserves: `createBackend()`, `createGameRuntime()`, runtime persistence controller, Svelte city flow, and `GameBackend`.

- [ ] **Step 1: Replace bootstrap selection without an inline store ternary**

In `src/main.ts`, remove direct imports of:

```ts
createIndexedDbCitySaveStore
createMemoryCitySaveStore
```

Import:

```ts
import { createCitySaveStore } from "./persistence/createCitySaveStore";
```

Keep the existing:

```ts
const nativeTauri = isTauriRuntime();
```

Replace store construction with:

```ts
const saveStore = createCitySaveStore({ nativeTauri });
```

Do not change backend creation, New City flow, App props, or runtime construction.

`MemoryCitySaveStore` is not deleted; it remains a test double.

- [ ] **Step 2: Update every current temporary-storage statement in architecture docs**

In `docs/architecture.md`, update all three connected stale areas, not only the first diagram:

1. Replace:

```text
Tauri startup until HPA-344:
  createTauriBackend
  -> createMemoryCitySaveStore (non-durable temporary bridge)
```

with:

```text
Tauri startup:
  createTauriBackend
  -> createTauriCitySaveStore
       -> city_store_* Tauri commands
       -> <app_data_dir>/cities/city-<hex-id>.json
```

2. Replace:

```text
native Tauri store: temporary memory adapter until HPA-344
```

with:

```text
native Tauri store: application-data JSON files through narrow Tauri commands
```

3. Replace the prose calling memory storage an intentionally temporary Tauri bridge with current native ownership.

Also document:

- create payloads are temp-first and create-only;
- update/rename are temp-first replacement;
- list ignores malformed/misnamed/non-file entries so healthy cities remain available;
- TypeScript owns shared list ordering;
- `MemoryCitySaveStore` remains a test double;
- HPA-349 owns packaged native/browser UI smoke.

Do not rewrite unrelated gameplay architecture.

- [ ] **Step 3: Update CLAUDE.md current-state guidance**

Update the durable-storage current state to:

```text
browser: IndexedDB
native Tauri: application-data city JSON files
```

State that six native city-store commands are separate from gameplay `GameBackend`.

Remove stale language saying Tauri uses memory until HPA-344 or that the future adapter belongs to HPA-548.

Explicitly retain:

```text
MemoryCitySaveStore is a test double used by runtime/persistence tests; it is
not a production host after HPA-344.
```

Do not add HPA-344 as an ongoing architectural dependency after delivery.

- [ ] **Step 4: Run the task-focused gate**

```bash
cargo test -p caelum --lib city_store
bunx vitest run --project runtime \
  tests/runtime/persistence/tauriCitySaveStore.test.ts \
  tests/runtime/persistence/citySaveStoreSelection.test.ts \
  tests/runtime/tauriBackend.test.ts \
  tests/runtime/backendSelection.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the repository gate, including browser E2E because main.ts changed**

```bash
bun run test:unit
bun run check
bun run lint
bun run format:check
bun run build
bun run test:e2e
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
bun run tauri:build
```

Expected: all commands PASS.

Browser Playwright is not new HPA-344 coverage; it is the existing suite proving the bootstrap change did not accidentally route browser persistence to Tauri commands.

- [ ] **Step 6: Review the final diff before commit**

Run:

```bash
git diff --stat main...HEAD
git diff main...HEAD -- \
  src-tauri/src \
  src/persistence \
  src/runtime/backend/persistence.ts \
  src/hostDiagnostics.ts \
  src/main.ts \
  docs/architecture.md \
  CLAUDE.md
```

Expected implementation shape:

- one concrete Rust city-file module;
- six registered commands;
- one shared temp payload writer;
- hard-link create-only commit;
- rename update/rename commit;
- one thin Tauri `CitySaveStore`;
- one tiny tested store selector;
- one extracted host-rejection stringifier with two current consumers;
- dev-only `tempfile`;
- bootstrap swap;
- focused docs.

Reject the diff if it adds a repository/service/trait hierarchy, generic filesystem API, migration/compatibility code, lock/recovery/autosave framework, gameplay-backend changes, or native browser/WebDriver framework.

- [ ] **Step 7: Commit the wiring/docs slice**

```bash
git add src/main.ts docs/architecture.md CLAUDE.md
git commit -m "feat: enable native city persistence"
```

---

### Task 4: Replace the human smoke with the native command/disk automation seam

**Files:**
- Modify: `src-tauri/src/city_store.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: Tauri 2.11 `mock_builder`, `mock_context`, `WebviewWindowBuilder`, `InvokeRequest`, and `get_ipc_response`.
- Produces: six command functions generic over `R: tauri::Runtime` and accepting `tauri::AppHandle<R>`.
- Produces: `with_commands<R: tauri::Runtime>(tauri::Builder<R>) -> tauri::Builder<R>` as the single production command-registration list.
- Produces: test-only `TestCityStoreRoot(PathBuf)`; no production command argument or filesystem override.
- Proves: exact record/update wire JSON, native create/update/list/read IPC, encoded file creation, and direct second-store reopen behavior.

- [ ] **Step 1: Add the record-wire assertions and the failing IPC story**

Extend `src-tauri/src/city_store.rs` tests beside `city_store_command_error_wire_is_stable`:

```rust
#[test]
fn city_store_record_wire_is_stable() {
    let record = record("city-ipc", "IPC City");

    assert_eq!(
        serde_json::to_value(summary(&record)).expect("summary serializes"),
        json!({
            "id": "city-ipc",
            "name": "IPC City",
            "createdAt": "2026-08-11T18:00:00.000Z",
            "savedAt": "2026-08-11T19:00:00.000Z"
        })
    );
    assert_eq!(
        serde_json::to_value(&record).expect("record serializes"),
        json!({
            "city": {
                "id": "city-ipc",
                "name": "IPC City",
                "createdAt": "2026-08-11T18:00:00.000Z"
            },
            "savedAt": "2026-08-11T19:00:00.000Z",
            "snapshot": { "id": "city-ipc" }
        })
    );

    let update: CitySaveUpdate = serde_json::from_value(json!({
        "savedAt": "2026-08-11T20:00:00.000Z",
        "snapshot": { "revision": 2 }
    }))
    .expect("update deserializes");
    assert_eq!(update.saved_at, "2026-08-11T20:00:00.000Z");
    assert_eq!(update.snapshot, json!({ "revision": 2 }));
}
```

Add this helper and story to `src-tauri/src/lib.rs` tests:

```rust
use serde_json::{json, Value};
use tauri::{ipc::InvokeBody, test::MockRuntime, webview::InvokeRequest};

fn invoke_city_store(
    webview: &tauri::WebviewWindow<MockRuntime>,
    command: &str,
    body: Value,
) -> Result<Value, Value> {
    tauri::test::get_ipc_response(
        webview,
        InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: if cfg!(any(windows, target_os = "android")) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .expect("valid Tauri URL"),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .map(|response| response.deserialize::<Value>().expect("JSON response"))
}

#[test]
fn production_city_store_handler_round_trips_ipc() {
    let temp = tempfile::tempdir().expect("temp dir");
    let root = temp.path().join("cities");
    let app = with_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app builds");
    assert!(app.manage(city_store::TestCityStoreRoot(root.clone())));
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("mock webview builds");

    let record = json!({
        "city": {
            "id": "city-ipc",
            "name": "IPC City",
            "createdAt": "2026-08-11T18:00:00.000Z"
        },
        "savedAt": "2026-08-11T19:00:00.000Z",
        "snapshot": { "revision": 1 }
    });
    assert_eq!(
        invoke_city_store(&webview, "city_store_create", json!({ "record": record }))
            .expect("create IPC succeeds"),
        json!({
            "id": "city-ipc",
            "name": "IPC City",
            "createdAt": "2026-08-11T18:00:00.000Z",
            "savedAt": "2026-08-11T19:00:00.000Z"
        })
    );

    invoke_city_store(
        &webview,
        "city_store_update",
        json!({
            "id": "city-ipc",
            "update": {
                "savedAt": "2026-08-11T20:00:00.000Z",
                "snapshot": { "revision": 2 }
            }
        }),
    )
    .expect("update IPC succeeds");

    let listed = invoke_city_store(&webview, "city_store_list", json!({}))
        .expect("list IPC succeeds");
    assert_eq!(listed.as_array().expect("summary array").len(), 1);
    let loaded = invoke_city_store(
        &webview,
        "city_store_read",
        json!({ "id": "city-ipc" }),
    )
    .expect("read IPC succeeds");
    assert_eq!(loaded["savedAt"], "2026-08-11T20:00:00.000Z");
    assert_eq!(loaded["snapshot"], json!({ "revision": 2 }));
    assert!(root.join("city-636974792d697063.json").is_file());
}
```

- [ ] **Step 2: Run the IPC test to observe RED**

Run:

```bash
cargo test -p caelum --lib production_city_store_handler_round_trips_ipc
```

Expected: compilation fails because `with_commands`, `TestCityStoreRoot`, and mock-runtime-compatible generic command signatures do not exist yet. This is the observed RED; do not weaken the test to a mocked invoke.

- [ ] **Step 3: Add the test root and make the six commands runtime-generic**

In `src-tauri/src/city_store.rs`, add:

```rust
#[cfg(test)]
#[derive(Clone)]
pub(crate) struct TestCityStoreRoot(pub(crate) PathBuf);
```

At the start of `CityFileStore::from_app` add:

```rust
#[cfg(test)]
if let Some(root) = app.try_state::<TestCityStoreRoot>() {
    return Ok(Self::new(root.0.clone()));
}
```

Change all six commands to the exact generic shape:

```rust
#[tauri::command]
pub(crate) fn city_store_list<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Vec<CitySummary>, CityStoreCommandError> {
    CityFileStore::from_app(&app)?.list_cities()
}

#[tauri::command]
pub(crate) fn city_store_read<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    id: String,
) -> Result<CitySaveRecord, CityStoreCommandError> {
    CityFileStore::from_app(&app)?.read_city(&id)
}

#[tauri::command]
pub(crate) fn city_store_create<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    record: CitySaveRecord,
) -> Result<CitySummary, CityStoreCommandError> {
    CityFileStore::from_app(&app)?.create_city(record)
}

#[tauri::command]
pub(crate) fn city_store_update<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    id: String,
    update: CitySaveUpdate,
) -> Result<CitySummary, CityStoreCommandError> {
    CityFileStore::from_app(&app)?.update_city(&id, update)
}

#[tauri::command]
pub(crate) fn city_store_rename<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    id: String,
    name: String,
) -> Result<CitySummary, CityStoreCommandError> {
    CityFileStore::from_app(&app)?.rename_city(&id, name)
}

#[tauri::command]
pub(crate) fn city_store_delete<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    id: String,
) -> Result<(), CityStoreCommandError> {
    CityFileStore::from_app(&app)?.delete_city(&id)
}
```

Keep the existing no-override `from_app_uses_app_data_cities_child` test. Do not expose the test root in production configuration or IPC.

- [ ] **Step 4: Share only the production command-registration list**

In `src-tauri/src/lib.rs`, extract:

```rust
fn with_commands<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
        game_snapshot,
        game_begin_runtime,
        game_dispatch,
        game_tick,
        game_build_sandbox_snapshot,
        game_reset,
        game_snapshot_for_save,
        game_restore_snapshot,
        game_preview_route,
        game_preview_road_mutation,
        city_store::city_store_list,
        city_store::city_store_read,
        city_store::city_store_create,
        city_store::city_store_update,
        city_store::city_store_rename,
        city_store::city_store_delete,
    ])
}
```

Start `run()` with:

```rust
let builder = tauri::Builder::default().manage(Mutex::new(OwnedEngine {
    engine: GameEngine::new(),
    runtime_epoch: 0,
}));

with_commands(builder)
```

Then keep the existing `.setup(...)`, `.run(...)`, and error handling unchanged. Do not extract managed state, plugins, setup, context generation, or the run loop.

- [ ] **Step 5: Run focused GREEN and all native module tests**

Run:

```bash
cargo test -p caelum --lib production_city_store_handler_round_trips_ipc
cargo test -p caelum --lib city_store
```

Expected: the IPC story and the full city-store module pass, including `second_store_instance_reopens_same_directory`, no-override app-data resolution, exact error JSON, and exact record/update JSON.

- [ ] **Step 6: Update the acceptance documentation**

In `docs/architecture.md`, state that HPA-344 automatically covers the production command/serialization seam plus direct disk reopen in isolated Rust tests. State that HPA-349 owns the packaged native/browser UI journey and real-bundle application-data permission. Remove the stale human acceptance gate.

Do not claim power-loss behavior or packaged-bundle write permission.

- [ ] **Step 7: Run the complete verification gate**

Run:

```bash
cargo test --workspace
cargo check --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
bun run test:unit
bun run check
bun run lint
bun run format:check
bun run build
bun run test:e2e
bun run tauri:build
```

Expected: all commands pass. If a release build hits the known sandbox `wasm-opt` permission failure, rerun the unchanged command in the approved environment; do not change implementation to accommodate the sandbox.

- [ ] **Step 8: Review and commit the automation slice**

Run:

```bash
git diff --check
git diff -- src-tauri/src/city_store.rs src-tauri/src/lib.rs docs/architecture.md
```

Reject the diff if it adds a second mock app, test-only command duplicates, a fake invoke layer, production path override, storage trait, or crash/fsync machinery.

Commit:

```bash
git add src-tauri/src/city_store.rs src-tauri/src/lib.rs docs/architecture.md
git commit -m "test: automate native city persistence seam"
```

---

## Plan self-review

### Spec coverage

- Six native operations: Task 1 + Task 2.
- No arbitrary paths: ID encoding + narrow commands.
- Create returned-failure atomicity: temp write + hard-link commit + failed-create test.
- Create conflict: hard-link destination existence + conflict test.
- Update/rename preservation: shared temp writer + rename + failure test.
- Resilient listing: filename shape + regular file + parse skip + embedded-ID/filename match.
- App-data path: generic `from_app<R>` + `mock_app` test.
- Exact native error wire: Rust serde test.
- Readable unexpected errors: shared `describeHostRejection` + existing/new TS tests.
- Store host selection: `src/main.ts` is the sole production caller for
  `CitySaveStore` selection; the tested boolean selector maps its value, while
  `createBackend()` retains independent gameplay-backend detection and the
  existing `isTauriRuntime` tests remain authority for marker cases.
- Browser regression: existing Playwright suite included after main bootstrap change.
- Native integration: one production-handler mock-runtime IPC story plus the existing direct second-store reopen proof; no human-only HPA-344 gate.
- Packaged native permission/UI journey: explicitly deferred to HPA-349.
- Memory test double: retained/documented.
- Deferred hardening: global constraints and final diff gate.

### Placeholder scan

There are no `TBD`, `TODO`, optional unnamed tests, or “handle later” implementation steps. Missing update and rename tests are required explicitly.

### Type/name consistency

- Native commands: `city_store_list|read|create|update|rename|delete`.
- All native commands accept `AppHandle<R>` and share one generic `with_commands<R>` registration function across production Wry and the mock runtime.
- Frontend store operations remain the six `CitySaveStore` names.
- Native error codes serialize to `notFound|conflict|failed`.
- `CitySaveUpdate` changes only `savedAt` + `snapshot`.
- Rename changes only city name.
- Committed filenames are both produced and validated by the same encoder rule.
- `createCitySaveStore` maps only the already-computed `nativeTauri` boolean.
- Browser store remains `createIndexedDbCitySaveStore`; native store is `createTauriCitySaveStore`.

## Implementation handoff

Tasks 1 through 3 are already implemented. After this amendment is reviewed, execute Task 4 with subagent-driven development, observe its focused RED/GREEN cycle, perform a fresh task review, and finish with a whole-branch review. HPA-344 has no remaining human-only smoke gate; HPA-349 retains packaged-host UI and real application-data permission coverage.

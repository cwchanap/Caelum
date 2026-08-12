# HPA-344 Native Tauri City Save Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Tauri's session-only memory city store with the smallest durable application-data-file implementation of the existing six-operation `CitySaveStore`.

**Architecture:** `src-tauri/src/city_store.rs` owns a fixed `<app_data_dir>/cities` directory, safe opaque-ID filename encoding, JSON records, create-new writes, temp-file replacement, and native error classification. `src/persistence/tauriCitySaveStore.ts` owns only six `invoke()` calls plus mapping into the existing `CitySaveStoreResult` taxonomy. `src/main.ts` switches the native branch from `createMemoryCitySaveStore()` to `createTauriCitySaveStore()`; the browser IndexedDB branch, runtime persistence controller, gameplay backend, and Svelte UI remain unchanged.

**Tech Stack:** Rust 2021, Tauri 2.11, `std::fs`, Serde/`serde_json`, TypeScript, `@tauri-apps/api/core`, Vitest, Bun, dev-only Rust `tempfile`.

## Global Constraints

- Implement exactly `listCities`, `readCity`, `createCity`, `updateCity`, `renameCity`, and `deleteCity`; do not widen `CitySaveStore`.
- Native committed records live only under Tauri's application-data directory in a `cities` child directory.
- Store one complete `CitySaveRecord` JSON file per city; no metadata index, sidecar, database, generation directory, or cache.
- Never accept a frontend path, filename, directory, or generic filesystem request.
- Convert every city ID to one fixed `city-<lowercase hex UTF-8 bytes>.json` filename component before joining it to the configured root.
- `createCity` must use create-new semantics and cannot overwrite an existing committed city.
- `updateCity` and `renameCity` must serialize first, write a sibling `.tmp`, then rename over the committed file; do not delete/truncate the committed file before replacement.
- `listCities` ignores `.tmp` and non-`.json` entries and returns summaries through the shared TypeScript `sortCitySummaries()` ordering.
- Store errors remain exactly `notFound | conflict | failed`; native diagnostics are development-only and may differ from IndexedDB.
- Snapshot JSON is opaque storage data. Do not validate gameplay schema in the save adapter; `GameBackend.restoreSnapshot()` remains the validation/activation boundary.
- Keep gameplay Tauri commands and storage Tauri commands as separate modules/responsibilities. Do not add city-save methods to `GameBackend`.
- Do not add a generic repository, storage trait hierarchy, managed storage service/state, command bus, DI container, plugin abstraction, retry layer, or lock manager.
- No migration/legacy reader, IndexedDB import, compatibility fixture, autosave, checkpoint, recovery, repair, import/export, encryption/signing/checksum, fsync certification, power-loss matrix, multi-window/process ownership, or quota/vendor hardening.
- Development saves are disposable; a future record/schema break updates the current readers/writers directly.
- Test the happy path plus the concrete boundaries required by HPA-344: conflict, failed replacement preservation, reopen, and fixed path authority. Do not add an exhaustive filesystem failure matrix.
- HPA-349 owns the representative browser/native cross-host Save/reload/Continue smoke; do not turn HPA-344 into a second E2E project.

---

## File structure

### Production

- Create `src-tauri/src/city_store.rs`
  - city-save wire structs;
  - fixed root + filename encoding;
  - six filesystem operations;
  - native error enum;
  - six narrow Tauri commands.
- Modify `src-tauri/src/lib.rs`
  - declare `mod city_store;`;
  - register six storage commands beside, but separate from, gameplay commands.
- Create `src/persistence/tauriCitySaveStore.ts`
  - six `invoke()` calls;
  - typed native error recognition;
  - mapping through `citySaveStoreError()`;
  - shared `sortCitySummaries()` on list.
- Modify `src/main.ts`
  - replace native `createMemoryCitySaveStore()` with `createTauriCitySaveStore()`;
  - remove the temporary HPA-344 bridge comment/import.

### Tests/tooling

- Modify `src-tauri/Cargo.toml`
  - add `tempfile = "3"` under `[dev-dependencies]` only.
- Modify `Cargo.lock`
  - record the dev-dependency resolution if the lock changes.
- Create `tests/runtime/persistence/tauriCitySaveStore.test.ts`
  - command arguments;
  - list ordering;
  - native error mapping;
  - unexpected rejection fallback.

### Documentation

- Modify `docs/architecture.md`
  - replace the temporary Tauri memory-store branch with the native application-data-file boundary.
- Modify `CLAUDE.md`
  - mark durable storage reduction as delivered;
  - remove the stale “Tauri memory store until HPA-344” guidance;
  - describe `src-tauri` as owning narrow city-save commands in addition to gameplay commands;
  - keep HPA-349 as the next cross-host smoke rather than inventing more persistence work.

No other production/test files belong in this implementation unless a concrete compiler/test failure proves the need.

---

### Task 1: Implement the native city-file module and command boundary

**Files:**
- Create: `src-tauri/src/city_store.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `Cargo.lock`

**Interfaces:**
- Consumes: `tauri::AppHandle`, `tauri::Manager::path()`, `serde_json::Value`, standard filesystem APIs.
- Produces internal wire types mirroring the existing TS contract: `CityIdentity`, `CitySaveRecord`, `CitySaveUpdate`, `CitySummary`.
- Produces native command error: `CityStoreCommandError::{NotFound, Conflict, Failed(String)}` serialized as `{ code, diagnostic? }`.
- Produces commands: `city_store_list`, `city_store_read`, `city_store_create`, `city_store_update`, `city_store_rename`, `city_store_delete`.
- Produces no gameplay/runtime interface changes.

- [ ] **Step 1: Add the temp-directory test dependency and declare the storage module**

In `src-tauri/Cargo.toml` extend the existing dev dependencies:

```toml
[dev-dependencies]
tauri = { version = "2.11.0", features = ["test"] }
tempfile = "3"
```

In `src-tauri/src/lib.rs`, add the module declaration near the imports/module declarations:

```rust
mod city_store;
```

Run dependency resolution so `Cargo.lock` is updated if necessary:

```bash
cargo check -p caelum
```

Do not add a production filesystem crate.

- [ ] **Step 2: Create the wire types, error type, safe filename encoder, and first failing tests**

Create `src-tauri/src/city_store.rs` with imports and wire shapes:

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

Add these helpers:

```rust
fn failed(error: impl ToString) -> CityStoreCommandError {
    CityStoreCommandError::Failed(error.to_string())
}

fn encoded_city_filename(id: &str) -> String {
    let mut filename = String::with_capacity(CITY_PREFIX.len() + id.len() * 2 + CITY_SUFFIX.len());
    filename.push_str(CITY_PREFIX);
    for byte in id.as_bytes() {
        write!(&mut filename, "{byte:02x}").expect("writing to String cannot fail");
    }
    filename.push_str(CITY_SUFFIX);
    filename
}

fn summary(record: &CitySaveRecord) -> CitySummary {
    CitySummary {
        id: record.city.id.clone(),
        name: record.city.name.clone(),
        created_at: record.city.created_at.clone(),
        saved_at: record.saved_at.clone(),
    }
}
```

Define the concrete, module-private store:

```rust
struct CityFileStore {
    root: PathBuf,
}

impl CityFileStore {
    fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn from_app(app: &tauri::AppHandle) -> Result<Self, CityStoreCommandError> {
        let root = app.path().app_data_dir().map_err(failed)?.join(CITY_DIRECTORY);
        Ok(Self::new(root))
    }

    fn city_path(&self, id: &str) -> PathBuf {
        self.root.join(encoded_city_filename(id))
    }

    fn temp_path(&self, id: &str) -> PathBuf {
        let filename = format!("{}{}", encoded_city_filename(id), TEMP_SUFFIX);
        self.root.join(filename)
    }
}
```

At the bottom of the file, add a `#[cfg(test)] mod tests` with the fixture helper and the first tests. These should be red until the methods are implemented:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn record(id: &str, name: &str) -> CitySaveRecord {
        CitySaveRecord {
            city: CityIdentity {
                id: id.to_owned(),
                name: name.to_owned(),
                created_at: "2026-08-11T18:00:00.000Z".to_owned(),
            },
            saved_at: "2026-08-11T18:00:00.000Z".to_owned(),
            snapshot: json!({ "budget": 120_000 }),
        }
    }

    #[test]
    fn empty_store_lists_no_cities() {
        let temp = tempdir().expect("temp dir");
        let store = CityFileStore::new(temp.path().join("cities"));
        assert_eq!(store.list_cities().expect("list succeeds"), Vec::<CitySummary>::new());
    }

    #[test]
    fn create_list_and_read_round_trip() {
        let temp = tempdir().expect("temp dir");
        let store = CityFileStore::new(temp.path().join("cities"));
        let city = record("city-1", "First");

        let created = store.create_city(city.clone()).expect("create succeeds");
        assert_eq!(created, summary(&city));
        assert_eq!(store.list_cities().expect("list succeeds"), vec![summary(&city)]);
        assert_eq!(store.read_city("city-1").expect("read succeeds"), city);
    }

    #[test]
    fn create_conflict_preserves_original_record() {
        let temp = tempdir().expect("temp dir");
        let store = CityFileStore::new(temp.path().join("cities"));
        let original = record("city-1", "First");
        store.create_city(original.clone()).expect("seed create");

        let error = store.create_city(record("city-1", "Replacement")).expect_err("conflict");
        assert!(matches!(error, CityStoreCommandError::Conflict));
        assert_eq!(store.read_city("city-1").expect("original remains"), original);
    }
}
```

Run:

```bash
cargo test -p caelum --lib city_store
```

Expected: FAIL to compile because the first `CityFileStore` operations are not implemented yet.

- [ ] **Step 3: Implement directory setup, list/read, and create-new semantics**

Add to `impl CityFileStore`:

```rust
fn ensure_root(&self) -> Result<(), CityStoreCommandError> {
    fs::create_dir_all(&self.root).map_err(failed)
}

fn list_cities(&self) -> Result<Vec<CitySummary>, CityStoreCommandError> {
    self.ensure_root()?;
    let mut cities = Vec::new();

    for entry in fs::read_dir(&self.root).map_err(failed)? {
        let entry = entry.map_err(failed)?;
        let path = entry.path();
        if path.extension() != Some(OsStr::new("json")) {
            continue;
        }

        let bytes = fs::read(&path).map_err(failed)?;
        let record: CityListRecord = serde_json::from_slice(&bytes).map_err(failed)?;
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
    let path = self.city_path(id);
    let bytes = fs::read(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            CityStoreCommandError::NotFound
        } else {
            failed(error)
        }
    })?;
    serde_json::from_slice(&bytes).map_err(failed)
}

fn create_city(&self, record: CitySaveRecord) -> Result<CitySummary, CityStoreCommandError> {
    self.ensure_root()?;
    let bytes = serde_json::to_vec(&record).map_err(failed)?;
    let path = self.city_path(&record.city.id);

    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                CityStoreCommandError::Conflict
            } else {
                failed(error)
            }
        })?;

    if let Err(error) = file.write_all(&bytes) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(failed(error));
    }

    Ok(summary(&record))
}
```

Do not pre-read to detect conflict. `create_new(true)` is the authority.

Run:

```bash
cargo test -p caelum --lib city_store
```

Expected: the three initial tests PASS.

- [ ] **Step 4: Add the remaining filesystem behavior tests before implementing replacement/delete**

Extend the test module with the remaining HPA-344 cases:

```rust
#[test]
fn update_changes_only_saved_payload() {
    let temp = tempdir().expect("temp dir");
    let store = CityFileStore::new(temp.path().join("cities"));
    let original = record("city-1", "First");
    store.create_city(original.clone()).expect("seed create");

    let updated = store
        .update_city(
            "city-1",
            CitySaveUpdate {
                saved_at: "2026-08-11T19:00:00.000Z".to_owned(),
                snapshot: json!({ "budget": 90_000 }),
            },
        )
        .expect("update succeeds");

    assert_eq!(updated.name, "First");
    assert_eq!(updated.created_at, original.city.created_at);
    assert_eq!(updated.saved_at, "2026-08-11T19:00:00.000Z");
    let read = store.read_city("city-1").expect("read updated");
    assert_eq!(read.city, original.city);
    assert_eq!(read.snapshot, json!({ "budget": 90_000 }));
}

#[test]
fn failed_update_preserves_committed_record() {
    let temp = tempdir().expect("temp dir");
    let store = CityFileStore::new(temp.path().join("cities"));
    let original = record("city-1", "First");
    store.create_city(original.clone()).expect("seed create");

    fs::create_dir(store.temp_path("city-1")).expect("block temp file creation");
    let error = store
        .update_city(
            "city-1",
            CitySaveUpdate {
                saved_at: "2026-08-11T19:00:00.000Z".to_owned(),
                snapshot: json!({ "budget": 1 }),
            },
        )
        .expect_err("update fails");

    assert!(matches!(error, CityStoreCommandError::Failed(_)));
    assert_eq!(store.read_city("city-1").expect("old record remains"), original);
}

#[test]
fn rename_changes_only_name() {
    let temp = tempdir().expect("temp dir");
    let store = CityFileStore::new(temp.path().join("cities"));
    let original = record("city-1", "First");
    store.create_city(original.clone()).expect("seed create");

    let renamed = store.rename_city("city-1", "North Loop".to_owned()).expect("rename");
    assert_eq!(renamed.name, "North Loop");
    assert_eq!(renamed.created_at, original.city.created_at);
    assert_eq!(renamed.saved_at, original.saved_at);
    let read = store.read_city("city-1").expect("read renamed");
    assert_eq!(read.city.name, "North Loop");
    assert_eq!(read.snapshot, original.snapshot);
}

#[test]
fn delete_removes_only_committed_city() {
    let temp = tempdir().expect("temp dir");
    let store = CityFileStore::new(temp.path().join("cities"));
    store.create_city(record("city-1", "First")).expect("seed create");

    store.delete_city("city-1").expect("delete succeeds");
    assert!(matches!(store.read_city("city-1"), Err(CityStoreCommandError::NotFound)));
    assert!(matches!(store.delete_city("city-1"), Err(CityStoreCommandError::NotFound)));
}

#[test]
fn second_store_instance_reopens_same_city_directory() {
    let temp = tempdir().expect("temp dir");
    let root = temp.path().join("cities");
    let first = CityFileStore::new(root.clone());
    let city = record("city-1", "First");
    first.create_city(city.clone()).expect("seed create");
    drop(first);

    let reopened = CityFileStore::new(root);
    assert_eq!(reopened.read_city("city-1").expect("reopen read"), city);
    assert_eq!(reopened.list_cities().expect("reopen list"), vec![summary(&city)]);
}

#[test]
fn encoded_ids_cannot_escape_store_root() {
    let temp = tempdir().expect("temp dir");
    let root = temp.path().join("cities");
    let store = CityFileStore::new(root.clone());
    let id = "../outside\\city";
    let city = record(id, "Path Test");

    store.create_city(city.clone()).expect("create succeeds");
    let expected = root.join(encoded_city_filename(id));
    assert!(expected.is_file());
    assert_eq!(expected.parent(), Some(root.as_path()));
    assert_eq!(store.read_city(id).expect("read by opaque id"), city);
    assert!(!temp.path().join("outside").exists());
}

#[test]
fn list_ignores_stale_temp_file() {
    let temp = tempdir().expect("temp dir");
    let store = CityFileStore::new(temp.path().join("cities"));
    let city = record("city-1", "First");
    store.create_city(city.clone()).expect("seed create");
    fs::write(store.temp_path("city-2"), serde_json::to_vec(&record("city-2", "Temp")).unwrap())
        .expect("write stale temp");

    assert_eq!(store.list_cities().expect("list succeeds"), vec![summary(&city)]);
}
```

Also add explicit missing update/rename tests if they are not naturally covered by the implementation path:

```rust
assert!(matches!(
    store.update_city("missing", CitySaveUpdate { saved_at: "2026-08-11T19:00:00.000Z".into(), snapshot: json!({}) }),
    Err(CityStoreCommandError::NotFound)
));
assert!(matches!(
    store.rename_city("missing", "Renamed".into()),
    Err(CityStoreCommandError::NotFound)
));
```

Run:

```bash
cargo test -p caelum --lib city_store
```

Expected: FAIL to compile until `update_city`, `rename_city`, and `delete_city` exist.

- [ ] **Step 5: Implement temp replacement, update, rename, and delete**

Add one record replacement helper:

```rust
fn replace_record(&self, id: &str, record: &CitySaveRecord) -> Result<(), CityStoreCommandError> {
    self.ensure_root()?;
    let bytes = serde_json::to_vec(record).map_err(failed)?;
    let temp = self.temp_path(id);
    let committed = self.city_path(id);

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

    if let Err(error) = fs::rename(&temp, &committed) {
        let _ = fs::remove_file(&temp);
        return Err(failed(error));
    }
    Ok(())
}
```

Implement the three methods by reading the committed record first:

```rust
fn update_city(&self, id: &str, update: CitySaveUpdate) -> Result<CitySummary, CityStoreCommandError> {
    let existing = self.read_city(id)?;
    let replacement = CitySaveRecord {
        city: existing.city,
        saved_at: update.saved_at,
        snapshot: update.snapshot,
    };
    self.replace_record(id, &replacement)?;
    Ok(summary(&replacement))
}

fn rename_city(&self, id: &str, name: String) -> Result<CitySummary, CityStoreCommandError> {
    let existing = self.read_city(id)?;
    let replacement = CitySaveRecord {
        city: CityIdentity { name, ..existing.city },
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

Do not call `remove_file(committed)` before rename. Do not add rollback files, generations, or retries.

Run:

```bash
cargo test -p caelum --lib city_store
```

Expected: all `city_store` tests PASS.

- [ ] **Step 6: Add the six Tauri command wrappers and register them**

At module scope in `city_store.rs`, add exactly these wrappers:

```rust
#[tauri::command]
pub(crate) fn city_store_list(app: tauri::AppHandle) -> Result<Vec<CitySummary>, CityStoreCommandError> {
    CityFileStore::from_app(&app)?.list_cities()
}

#[tauri::command]
pub(crate) fn city_store_read(app: tauri::AppHandle, id: String) -> Result<CitySaveRecord, CityStoreCommandError> {
    CityFileStore::from_app(&app)?.read_city(&id)
}

#[tauri::command]
pub(crate) fn city_store_create(app: tauri::AppHandle, record: CitySaveRecord) -> Result<CitySummary, CityStoreCommandError> {
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
pub(crate) fn city_store_delete(app: tauri::AppHandle, id: String) -> Result<(), CityStoreCommandError> {
    CityFileStore::from_app(&app)?.delete_city(&id)
}
```

In `src-tauri/src/lib.rs`, append only the storage commands to the existing `tauri::generate_handler![]`:

```rust
city_store::city_store_list,
city_store::city_store_read,
city_store::city_store_create,
city_store::city_store_update,
city_store::city_store_rename,
city_store::city_store_delete,
```

Do not move gameplay commands into the new module and do not make city storage part of `EngineState`.

Run:

```bash
cargo fmt --all --check
cargo test -p caelum --lib city_store
cargo clippy -p caelum --all-targets -- -D warnings
```

Expected: PASS.

- [ ] **Step 7: Commit the independently working native storage slice**

```bash
git add src-tauri/src/city_store.rs src-tauri/src/lib.rs src-tauri/Cargo.toml Cargo.lock
git commit -m "feat: add native city file store"
```

---

### Task 2: Add the thin TypeScript Tauri CitySaveStore adapter

**Files:**
- Create: `src/persistence/tauriCitySaveStore.ts`
- Create: `tests/runtime/persistence/tauriCitySaveStore.test.ts`

**Interfaces:**
- Consumes: existing `CitySaveStore`, `CitySaveStoreResult`, `CitySaveStoreErrorCode`, `CitySaveStoreOperation`, `citySaveStoreError()`, `sortCitySummaries()`.
- Consumes: `invoke` from `@tauri-apps/api/core`.
- Produces: `createTauriCitySaveStore(): CitySaveStore`.
- Does not expose command names, filesystem details, or Tauri errors above the adapter.

- [ ] **Step 1: Write adapter tests red-first**

Create `tests/runtime/persistence/tauriCitySaveStore.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createTauriCitySaveStore } from "../../../src/persistence/tauriCitySaveStore";
import { makeCitySaveRecord } from "./citySaveStoreContract";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

const summary = {
  id: "city-1",
  name: "First",
  createdAt: "2026-08-11T18:00:00.000Z",
  savedAt: "2026-08-11T18:00:00.000Z",
};

describe("TauriCitySaveStore", () => {
  beforeEach(() => invokeMock.mockReset());

  it("invokes only the six narrow city-store commands", async () => {
    const record = makeCitySaveRecord("city-1", "First", {
      createdAt: summary.createdAt,
      savedAt: summary.savedAt,
    });
    invokeMock
      .mockResolvedValueOnce([summary])
      .mockResolvedValueOnce(record)
      .mockResolvedValueOnce(summary)
      .mockResolvedValueOnce({ ...summary, savedAt: "2026-08-11T19:00:00.000Z" })
      .mockResolvedValueOnce({ ...summary, name: "Renamed" })
      .mockResolvedValueOnce(undefined);

    const store = createTauriCitySaveStore();
    await store.listCities();
    await store.readCity("city-1");
    await store.createCity(record);
    await store.updateCity("city-1", { savedAt: "2026-08-11T19:00:00.000Z", snapshot: { budget: 90_000 } });
    await store.renameCity("city-1", "Renamed");
    await store.deleteCity("city-1");

    expect(invokeMock.mock.calls).toEqual([
      ["city_store_list"],
      ["city_store_read", { id: "city-1" }],
      ["city_store_create", { record }],
      ["city_store_update", { id: "city-1", update: { savedAt: "2026-08-11T19:00:00.000Z", snapshot: { budget: 90_000 } } }],
      ["city_store_rename", { id: "city-1", name: "Renamed" }],
      ["city_store_delete", { id: "city-1" }],
    ]);
  });

  it("sorts native list results with the shared contract ordering", async () => {
    invokeMock.mockResolvedValue([
      { id: "city-b", name: "B", createdAt: summary.createdAt, savedAt: "2026-08-11T18:00:00.000Z" },
      { id: "city-z", name: "Z", createdAt: summary.createdAt, savedAt: "2026-08-11T19:00:00.000Z" },
      { id: "city-a", name: "A", createdAt: summary.createdAt, savedAt: "2026-08-11T18:00:00.000Z" },
    ]);

    const result = await createTauriCitySaveStore().listCities();
    expect(result.ok && result.value.map((city) => city.id)).toEqual(["city-z", "city-a", "city-b"]);
  });

  it.each([
    ["readCity", { code: "notFound" }, "notFound"],
    ["createCity", { code: "conflict" }, "conflict"],
    ["updateCity", { code: "failed", diagnostic: "disk full" }, "failed"],
  ] as const)("maps %s native errors", async (operation, rejection, expectedCode) => {
    invokeMock.mockRejectedValue(rejection);
    const store = createTauriCitySaveStore();
    const result =
      operation === "readCity"
        ? await store.readCity("city-1")
        : operation === "createCity"
          ? await store.createCity(makeCitySaveRecord("city-1", "First"))
          : await store.updateCity("city-1", { savedAt: summary.savedAt, snapshot: {} });

    expect(result).toMatchObject({
      ok: false,
      error: { operation, code: expectedCode, cityId: "city-1" },
    });
  });

  it("maps an unexpected Tauri rejection to generic failed", async () => {
    invokeMock.mockRejectedValue("bridge unavailable");
    const result = await createTauriCitySaveStore().deleteCity("city-1");
    expect(result).toEqual({
      ok: false,
      error: {
        operation: "deleteCity",
        code: "failed",
        cityId: "city-1",
        diagnostic: "bridge unavailable",
      },
    });
  });
});
```

Run:

```bash
bunx vitest run --project runtime tests/runtime/persistence/tauriCitySaveStore.test.ts
```

Expected: FAIL because `tauriCitySaveStore.ts` does not exist.

- [ ] **Step 2: Implement native error recognition without a new error framework**

Create `src/persistence/tauriCitySaveStore.ts` with imports:

```ts
import { invoke } from "@tauri-apps/api/core";
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
```

Use one file-local native error parser:

```ts
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

  const rawDiagnostic = (error as { diagnostic?: unknown }).diagnostic;
  return {
    code,
    ...(code === "failed" && typeof rawDiagnostic === "string"
      ? { diagnostic: rawDiagnostic }
      : {}),
  };
}
```

Add one generic command wrapper local to this adapter:

```ts
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
          ? { diagnostic: native?.diagnostic ?? String(error) }
          : {}),
      }),
    };
  }
}
```

Do not export the parser/wrapper and do not merge it with `tauriBackend.ts` error handling; gameplay-host and city-store errors are different contracts.

- [ ] **Step 3: Implement the six CitySaveStore methods**

Add the factory:

```ts
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

Do not add an adapter class, injected command client, path arguments, local record cache, or clone layer.

- [ ] **Step 4: Run focused and runtime verification**

```bash
bunx vitest run --project runtime tests/runtime/persistence/tauriCitySaveStore.test.ts
bunx vitest run --project runtime
bun run check
bun run lint:svelte
bun run format:check
```

Expected: PASS.

- [ ] **Step 5: Commit the independently testable frontend adapter**

```bash
git add src/persistence/tauriCitySaveStore.ts tests/runtime/persistence/tauriCitySaveStore.test.ts
git commit -m "feat: add Tauri city save adapter"
```

---

### Task 3: Wire native durability, update current guidance, and run the full gate

**Files:**
- Modify: `src/main.ts`
- Modify: `docs/architecture.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `createTauriCitySaveStore(): CitySaveStore` from Task 2.
- Produces: native startup uses durable files; browser startup remains IndexedDB.
- Preserves: `createGameRuntime({ backend, saveStore })`, `RuntimePersistenceController`, Svelte city flow, `GameBackend`, IndexedDB adapter.

- [ ] **Step 1: Replace only the native memory-store bootstrap**

In `src/main.ts`, replace:

```ts
import { createMemoryCitySaveStore } from "./persistence/memoryCitySaveStore";
```

with:

```ts
import { createTauriCitySaveStore } from "./persistence/tauriCitySaveStore";
```

Then replace:

```ts
const saveStore = nativeTauri
  ? createMemoryCitySaveStore() // HPA-344 replaces this with native persistence.
  : createIndexedDbCitySaveStore();
```

with:

```ts
const saveStore = nativeTauri
  ? createTauriCitySaveStore()
  : createIndexedDbCitySaveStore();
```

Do not change `createBackend()`, `createGameRuntime()`, the New City bootstrap, or App props.

- [ ] **Step 2: Update the architecture's persistence host boundary**

In `docs/architecture.md`, keep the existing browser block and replace the temporary Tauri block:

```text
Tauri startup:
  createTauriBackend
  -> createTauriCitySaveStore
       -> city_store_* Tauri commands
       -> <app_data_dir>/cities/city-<hex-id>.json
  -> createGameRuntime(activeCity = null)
  -> runtime.persistence.listCities()
```

Update the nearby prose so it states:

- native Tauri persistence is now one file per city under application data;
- filesystem details are Rust-only;
- frontend commands accept IDs/records/updates/names, never paths;
- update/rename use temp replacement;
- list has no metadata index and TypeScript applies the shared summary order;
- HPA-349 remains the final representative cross-host Save/reload/Continue smoke.

Delete text saying Tauri uses the memory bridge “until HPA-344.” Do not rewrite unrelated gameplay-host architecture.

- [ ] **Step 3: Update CLAUDE.md so future work sees the delivered state**

In `CLAUDE.md`:

1. Replace the `In-flight reductions` durable-storage row with delivered wording, or remove the row if campaign/growth is the only remaining in-flight reduction. The current-state guidance must say browser = IndexedDB and native Tauri = application-data city files.
2. Keep the small save-boundary rule exactly six operations.
3. In the Tauri host section, replace the stale “future narrow application-data city-save adapter remains HPA-548 work” sentence with current ownership:

```text
Tauri also exposes six narrow city-store commands whose Rust module owns the
application-data path and JSON file replacement. These commands are separate
from GameBackend/gameplay state; TypeScript sees them only through CitySaveStore.
```

4. Do not add HPA-344 as an ongoing architectural dependency after it is delivered.

- [ ] **Step 4: Run the task-focused gate**

```bash
cargo test -p caelum --lib city_store
bunx vitest run --project runtime tests/runtime/persistence/tauriCitySaveStore.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the repository verification gate**

```bash
bun run test:unit
bun run check
bun run lint
bun run format:check
bun run build
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
bun run tauri:build
```

Expected: all commands PASS.

Do not add a new browser Playwright test or native automation harness merely for HPA-344. If the existing CI Playwright suite runs automatically, it should remain green without edits. HPA-349 is the next task specifically because it owns the representative native restart proof.

- [ ] **Step 6: Review the final diff for accidental architecture growth**

Run:

```bash
git diff --stat main...HEAD
git diff main...HEAD -- src-tauri/src src/persistence src/main.ts docs/architecture.md CLAUDE.md
```

The final diff should show exactly:

- one concrete Rust city-file module;
- six registered storage commands;
- one thin TS adapter;
- one TS adapter test file;
- dev-only `tempfile` test support;
- one native bootstrap substitution;
- focused current-state docs.

Reject the diff before merge if it contains a new repository/service/trait hierarchy, generic filesystem API, migration/compatibility code, persistence scheduler/lock, autosave/recovery mechanism, or gameplay-backend changes.

- [ ] **Step 7: Commit the wiring/docs slice**

```bash
git add src/main.ts docs/architecture.md CLAUDE.md
git commit -m "feat: enable native city persistence"
```

---

## Plan self-review

### Spec coverage

- Six-operation native adapter: Tasks 1-2.
- Fixed application-data root/no arbitrary paths: Task 1 filename encoder + command signatures.
- One file per city/no index: Task 1 store layout/list implementation.
- Create-only conflict: Task 1 `create_new(true)` + conflict test.
- Failed update preserves prior file: Task 1 temp replacement + concrete blocked-temp test.
- Rename/delete/reopen: Task 1 focused tests.
- Same frontend error taxonomy: Task 2 native error parser + `citySaveStoreError()` mapping.
- Independent gameplay/storage boundaries: Task 1 separate Rust module + Task 2 separate TS adapter; no `GameBackend` edits.
- Native bootstrap: Task 3 one-line host selection.
- Current docs: Task 3 architecture + CLAUDE cleanup.
- Deferred hardening and HPA-349 boundary: Global Constraints + Task 3 verification/review.

### Placeholder scan

The plan contains no `TBD`, `TODO`, “handle later,” generic “add tests,” or unnamed implementation step. Every planned file, command name, wire type, failure code, filename rule, test behavior, and verification command is explicit.

### Type/name consistency

- Command names are consistently `city_store_list|read|create|update|rename|delete` in Rust, TypeScript, and tests.
- Frontend operations remain `listCities|readCity|createCity|updateCity|renameCity|deleteCity`.
- Native errors are `notFound|conflict|failed`, matching `CitySaveStoreErrorCode`.
- `CitySaveUpdate` contains only `savedAt` + `snapshot`; update preserves stored identity/name metadata.
- Rename preserves stored ID/createdAt/savedAt/snapshot and changes only name.
- Browser store remains `createIndexedDbCitySaveStore()`; native store becomes `createTauriCitySaveStore()`.

## Implementation handoff

After this planning PR is reviewed, implement Task 1 -> Task 2 -> Task 3 in order. Prefer subagent-driven development with a fresh review gate after each task; inline execution is also valid if the same red/green and review boundaries are preserved.

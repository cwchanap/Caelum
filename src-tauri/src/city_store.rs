use std::{
    ffi::OsStr,
    fmt::Write as _,
    fs::{self, OpenOptions},
    io::Write as _,
    path::PathBuf,
};

use serde::{Deserialize, Serialize};
use tauri::Manager;

const CITY_DIRECTORY: &str = "cities";
const CITY_PREFIX: &str = "city-";
const CITY_SUFFIX: &str = ".json";
const TEMP_SUFFIX: &str = ".tmp";

#[cfg(test)]
#[derive(Clone)]
pub(crate) struct TestCityStoreRoot(pub(crate) PathBuf);

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
        #[cfg(test)]
        if let Some(root) = app.try_state::<TestCityStoreRoot>() {
            return Ok(Self::new(root.0.clone()));
        }

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

        // Remove any stale temp authoritatively. A leftover temp can be a hard
        // link to the committed record (see `create_city`): silently ignoring a
        // removal failure would let the `create_new` open below truncate the
        // shared inode and corrupt the committed save on a later failed write.
        match fs::remove_file(&temp) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(failed(error)),
        }

        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
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

    fn create_city(&self, record: CitySaveRecord) -> Result<CitySummary, CityStoreCommandError> {
        let id = record.city.id.clone();
        if id.is_empty() {
            return Err(failed("city id must be non-empty"));
        }
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

    fn rename_city(&self, id: &str, name: String) -> Result<CitySummary, CityStoreCommandError> {
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
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn record(id: &str, name: &str) -> CitySaveRecord {
        CitySaveRecord {
            city: CityIdentity {
                id: id.into(),
                name: name.into(),
                created_at: "2026-08-11T18:00:00.000Z".into(),
            },
            saved_at: "2026-08-11T19:00:00.000Z".into(),
            snapshot: json!({ "id": id }),
        }
    }

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

        assert_eq!(
            store.create_city(city.clone()).expect("create"),
            summary(&city)
        );
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
    fn create_rejects_empty_city_id_and_leaves_store_empty() {
        let temp = tempdir().expect("temp dir");
        let store = CityFileStore::new(temp.path().join("cities"));
        let empty = record("", "Empty");

        assert!(matches!(
            store.create_city(empty),
            Err(CityStoreCommandError::Failed(_))
        ));
        assert_eq!(
            store.list_cities().expect("list"),
            Vec::<CitySummary>::new()
        );
        assert!(!store.root.join(encoded_city_filename("")).exists());
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

    #[test]
    fn update_changes_only_saved_payload() {
        let temp = tempdir().expect("temp dir");
        let store = CityFileStore::new(temp.path().join("cities"));
        let original = record("city-1", "First");
        store.create_city(original.clone()).expect("seed");
        let update = CitySaveUpdate {
            saved_at: "2026-08-11T20:00:00.000Z".into(),
            snapshot: json!({ "updated": true }),
        };

        let expected = CitySaveRecord {
            city: original.city.clone(),
            saved_at: update.saved_at.clone(),
            snapshot: update.snapshot.clone(),
        };
        assert_eq!(
            store.update_city("city-1", update).expect("update"),
            summary(&expected)
        );
        assert_eq!(store.read_city("city-1").expect("read"), expected);
    }

    #[test]
    fn failed_update_preserves_committed_record() {
        let temp = tempdir().expect("temp dir");
        let store = CityFileStore::new(temp.path().join("cities"));
        let original = record("city-1", "First");
        store.create_city(original.clone()).expect("seed");
        fs::create_dir(store.temp_path("city-1")).expect("block temp path");

        assert!(matches!(
            store.update_city(
                "city-1",
                CitySaveUpdate {
                    saved_at: "2026-08-11T20:00:00.000Z".into(),
                    snapshot: json!({ "updated": true }),
                },
            ),
            Err(CityStoreCommandError::Failed(_))
        ));
        assert_eq!(store.read_city("city-1").expect("original"), original);
    }

    #[test]
    fn rename_changes_only_name() {
        let temp = tempdir().expect("temp dir");
        let store = CityFileStore::new(temp.path().join("cities"));
        let original = record("city-1", "First");
        store.create_city(original.clone()).expect("seed");

        let expected = CitySaveRecord {
            city: CityIdentity {
                name: "Renamed".into(),
                ..original.city.clone()
            },
            ..original.clone()
        };
        assert_eq!(
            store
                .rename_city("city-1", "Renamed".into())
                .expect("rename"),
            summary(&expected)
        );
        assert_eq!(store.read_city("city-1").expect("read"), expected);
    }

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
    fn delete_then_read_and_second_delete_are_not_found() {
        let temp = tempdir().expect("temp dir");
        let store = CityFileStore::new(temp.path().join("cities"));
        store.create_city(record("city-1", "First")).expect("seed");

        store.delete_city("city-1").expect("delete");
        assert!(matches!(
            store.read_city("city-1"),
            Err(CityStoreCommandError::NotFound)
        ));
        assert!(matches!(
            store.delete_city("city-1"),
            Err(CityStoreCommandError::NotFound)
        ));
    }

    #[test]
    fn second_store_instance_reopens_same_directory() {
        let temp = tempdir().expect("temp dir");
        let root = temp.path().join("cities");
        let first = CityFileStore::new(root.clone());
        let city = record("city-1", "First");
        first.create_city(city.clone()).expect("create");

        let second = CityFileStore::new(root);
        assert_eq!(second.list_cities().expect("list"), vec![summary(&city)]);
        assert_eq!(second.read_city("city-1").expect("read"), city);
    }

    #[test]
    fn encoded_ids_cannot_escape_store_root() {
        let temp = tempdir().expect("temp dir");
        let store = CityFileStore::new(temp.path().join("cities"));
        let id = "../escape";
        let city_path = store.city_path(id);

        assert_eq!(city_path.parent(), Some(store.root.as_path()));
        store.create_city(record(id, "Safe")).expect("create");
        assert!(city_path.is_file());
        assert!(!temp.path().join("escape.json").exists());
    }

    #[test]
    fn list_skips_stale_temp_unrelated_json_and_non_files() {
        let temp = tempdir().expect("temp dir");
        let store = CityFileStore::new(temp.path().join("cities"));
        let valid = record("city-1", "Valid");
        store.create_city(valid.clone()).expect("seed");

        fs::write(store.temp_path("stale"), b"{}").expect("stale temp");
        fs::write(store.root.join("notes.json"), b"{}").expect("unrelated");
        fs::create_dir(store.root.join("city-cd.json")).expect("directory lookalike");

        assert_eq!(store.list_cities().expect("list"), vec![summary(&valid)]);
    }

    #[test]
    fn list_skips_malformed_committed_json() {
        let temp = tempdir().expect("temp dir");
        let store = CityFileStore::new(temp.path().join("cities"));
        let valid = record("city-1", "Valid");
        store.create_city(valid.clone()).expect("seed");
        fs::write(store.root.join("city-ab.json"), b"{bad json").expect("malformed");

        assert_eq!(store.list_cities().expect("list"), vec![summary(&valid)]);
    }

    #[test]
    fn list_skips_filename_content_id_mismatch() {
        let temp = tempdir().expect("temp dir");
        let store = CityFileStore::new(temp.path().join("cities"));
        let valid = record("city-1", "Valid");
        store.create_city(valid.clone()).expect("seed");
        let mismatched = record("city-a", "Copied");
        fs::write(
            store.root.join(encoded_city_filename("city-b")),
            serde_json::to_vec(&mismatched).expect("encode"),
        )
        .expect("mismatched");

        assert_eq!(store.list_cities().expect("list"), vec![summary(&valid)]);
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
}

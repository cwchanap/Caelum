mod common;

use std::fs;
use std::path::Path;
use std::process::Command;

use caelum_core::{
    check_snapshot_schema, validate_snapshot, GameEngine, GameSnapshot, PersistenceError,
    SNAPSHOT_SCHEMA_VERSION,
};
use serde_json::{json, Value};

use common::persistence_fixtures::host_parity_fixture;

const PERSISTENCE_FIXTURES_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/fixtures/persistence",
);
const SNAPSHOT_FIXTURE_NAMES: [&str; 4] = [
    "valid-paused.json",
    "unsupported-schema.json",
    "unpaused.json",
    "malformed-current-schema.json",
];

fn read_json(name: &str) -> Value {
    let path = Path::new(PERSISTENCE_FIXTURES_DIR).join(name);
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn write_json(name: &str, value: &Value) {
    let path = Path::new(PERSISTENCE_FIXTURES_DIR).join(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(value).unwrap()),
    )
    .unwrap();
}

fn format_snapshot_fixtures() {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repository root must exist");
    let fixture_root = Path::new(PERSISTENCE_FIXTURES_DIR)
        .canonicalize()
        .expect("persistence fixture root must exist");
    let prettier = repo_root.join("node_modules/prettier/bin/prettier.cjs");
    let status = Command::new("bun")
        .current_dir(&repo_root)
        .arg(&prettier)
        .arg("--write")
        .arg("--log-level")
        .arg("silent")
        .args(
            SNAPSHOT_FIXTURE_NAMES
                .iter()
                .map(|name| fixture_root.join(name)),
        )
        .status()
        .unwrap_or_else(|error| {
            panic!(
                "failed to run Bun with repo-pinned Prettier at {}: {error}; \
                 install Bun and run `bun install --frozen-lockfile` at the repository root",
                prettier.display()
            )
        });
    assert!(
        status.success(),
        "Bun failed while running repo-pinned Prettier at {}",
        prettier.display()
    );
}

#[test]
#[ignore = "regenerates checked-in persistence fixture evidence"]
fn export_snapshot_fixtures_from_authoritative_rust_state() {
    let snapshot = host_parity_fixture();
    let valid = serde_json::to_value(&snapshot).unwrap();

    let mut unsupported = valid.clone();
    unsupported["schemaVersion"] = json!(3);
    unsupported["rules"]["sandbox"]
        .as_object_mut()
        .unwrap()
        .remove("startingCapital");

    let mut unpaused = valid.clone();
    unpaused["paused"] = json!(false);

    let mut malformed = valid.clone();
    malformed["map"]["tiles"] = json!("not-an-array");

    write_json("valid-paused.json", &valid);
    write_json("unsupported-schema.json", &unsupported);
    write_json("unpaused.json", &unpaused);
    write_json("malformed-current-schema.json", &malformed);
    format_snapshot_fixtures();
}

#[test]
fn checked_in_snapshot_fixtures_preserve_the_persistence_contract() {
    let valid = read_json("valid-paused.json");
    assert_eq!(
        valid["schemaVersion"].as_u64(),
        Some(u64::from(SNAPSHOT_SCHEMA_VERSION)),
        "checked-in fixture schema must match Rust",
    );
    check_snapshot_schema(&valid).unwrap();
    let valid: GameSnapshot = serde_json::from_value(valid).unwrap();
    validate_snapshot(&valid).unwrap();
    assert_eq!(
        valid.rules.sandbox.starting_capital.value(),
        150_000,
        "fixture must preserve its public sandbox construction request"
    );

    let unsupported = read_json("unsupported-schema.json");
    assert_eq!(
        check_snapshot_schema(&unsupported).unwrap_err(),
        PersistenceError::UnsupportedSchema {
            expected: SNAPSHOT_SCHEMA_VERSION,
            actual: 3,
        }
    );
    assert!(
        serde_json::from_value::<GameSnapshot>(unsupported).is_err(),
        "legacy-shaped fixture must fail a full current-schema decode"
    );

    let unpaused: GameSnapshot =
        serde_json::from_value(read_json("unpaused.json")).expect("unpaused fixture must decode");
    let restored = GameEngine::from_snapshot(unpaused).expect("unpaused fixture must normalize");
    assert!(restored.snapshot().paused);

    let malformed = read_json("malformed-current-schema.json");
    check_snapshot_schema(&malformed).unwrap();
    assert!(
        serde_json::from_value::<GameSnapshot>(malformed).is_err(),
        "malformed current-schema fixture must fail full decode"
    );
}

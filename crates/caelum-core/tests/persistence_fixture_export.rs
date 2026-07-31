mod common;

use std::fs;
use std::path::Path;
use std::process::Command;

use caelum_core::model::TripStatus;
use caelum_core::{
    check_snapshot_schema, validate_snapshot, DerivedStateError, GameSnapshot, ModeError,
    PersistenceError, SnapshotField,
};
use serde_json::{json, Value};

use common::persistence_fixtures::host_parity_fixture;

const PERSISTENCE_FIXTURES_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/fixtures/persistence",
);
const SNAPSHOT_FIXTURE_NAMES: [&str; 5] = [
    "valid-paused.json",
    "unsupported-schema.json",
    "unpaused.json",
    "malformed-current-schema.json",
    "late-derived-corruption.json",
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

    let nonterminal_trip_count = snapshot
        .active_trips
        .iter()
        .filter(|trip| {
            matches!(
                trip.status,
                TripStatus::Idle | TripStatus::Walking | TripStatus::Waiting | TripStatus::Riding
            )
        })
        .count();
    let mut late_corruption = valid.clone();
    late_corruption["metrics"]["waitingTripCount"] = json!(nonterminal_trip_count + 1);
    let late_snapshot: GameSnapshot = serde_json::from_value(late_corruption.clone()).unwrap();
    assert_eq!(
        validate_snapshot(&late_snapshot).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::MetricsCounters,
            reason: DerivedStateError::MetricsRelationshipMismatch,
        }
    );

    write_json("valid-paused.json", &valid);
    write_json("unsupported-schema.json", &unsupported);
    write_json("unpaused.json", &unpaused);
    write_json("malformed-current-schema.json", &malformed);
    write_json("late-derived-corruption.json", &late_corruption);
    format_snapshot_fixtures();
}

#[test]
fn checked_in_snapshot_fixtures_preserve_the_persistence_contract() {
    let valid = read_json("valid-paused.json");
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
            expected: 4,
            actual: 3,
        }
    );
    assert!(
        serde_json::from_value::<GameSnapshot>(unsupported).is_err(),
        "legacy-shaped fixture must fail a full current-schema decode"
    );

    let unpaused: GameSnapshot =
        serde_json::from_value(read_json("unpaused.json")).expect("unpaused fixture must decode");
    assert_eq!(
        validate_snapshot(&unpaused).unwrap_err(),
        PersistenceError::InvalidModeSettings {
            field: SnapshotField::Paused,
            reason: ModeError::PersistenceRequiresPaused,
        }
    );

    let malformed = read_json("malformed-current-schema.json");
    check_snapshot_schema(&malformed).unwrap();
    assert!(
        serde_json::from_value::<GameSnapshot>(malformed).is_err(),
        "malformed current-schema fixture must fail full decode"
    );

    let late: GameSnapshot = serde_json::from_value(read_json("late-derived-corruption.json"))
        .expect("late-corruption fixture must fully decode");
    assert_eq!(
        validate_snapshot(&late).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::MetricsCounters,
            reason: DerivedStateError::MetricsRelationshipMismatch,
        }
    );
}

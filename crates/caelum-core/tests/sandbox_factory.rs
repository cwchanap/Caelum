use caelum_core::model::{
    DemandMultiplier, EconomyPreset, GameMode, Heading, MovementKind, Point, SandboxTemplateId,
    StartingCapital,
};
use caelum_core::road_topology::{RoadState, RoadTopology};
use caelum_core::{create_sandbox_snapshot, SandboxCreationRequest};
use serde_json::{json, Value};

fn request(template_id: &str) -> SandboxCreationRequest {
    SandboxCreationRequest {
        template_id: template_id.to_string(),
        economy_preset: "creative".to_string(),
        starting_capital: Some(0.0),
        demand_multiplier: Some(1.5),
    }
}

#[test]
fn identical_requests_produce_equal_complete_snapshots() {
    for template in ["blankGrid", "crossroads"] {
        let first = create_sandbox_snapshot(request(template)).unwrap();
        let second = create_sandbox_snapshot(request(template)).unwrap();
        assert_eq!(first, second);
    }
}

#[test]
fn blank_grid_contains_only_canonical_empty_tiles() {
    let snapshot = create_sandbox_snapshot(request("blankGrid")).unwrap();
    assert_eq!((snapshot.map.width, snapshot.map.height), (28, 18));
    assert_eq!(snapshot.map.tiles.len(), 28 * 18);
    assert!(snapshot.map.road_structures.is_empty());
    assert!(snapshot.map.tiles.iter().all(|tile| {
        tile.kind == "empty"
            && tile.area.is_none()
            && !tile.has_track
            && tile.one_way.is_none()
            && tile.road_connections.is_empty()
            && tile.road_structure_id.is_none()
    }));
    assert_eq!(snapshot.map.tiles[0].id, "tile-0-0");
    assert_eq!(snapshot.map.tiles[27].id, "tile-27-0");
    assert_eq!(snapshot.map.tiles[17 * 28].id, "tile-0-17");
    assert_eq!(snapshot.map.tiles[18 * 28 - 1].id, "tile-27-17");
    for (index, tile) in snapshot.map.tiles.iter().enumerate() {
        let x = index % 28;
        let y = index / 28;
        assert_eq!(tile.id, format!("tile-{x}-{y}"));
        assert_eq!((tile.x, tile.y), (x as i32, y as i32));
    }
    assert!(snapshot.buildings.is_empty());
    assert!(snapshot.sims.is_empty());
    assert!(snapshot.active_trips.is_empty());
    assert!(snapshot.transit.stops.is_empty());
    assert!(snapshot.transit.stations.is_empty());
    assert!(snapshot.transit.routes.is_empty());
    assert!(snapshot.transit.metro_lines.is_empty());
    assert!(snapshot.transit.vehicles.is_empty());
    assert_eq!(snapshot.scenario.name, "Blank Grid");
    assert!(snapshot.scenario.objectives.is_none());
    assert!(snapshot.scenario.growth_waves.is_empty());
}

#[test]
fn valid_settings_change_rules_and_budget_without_changing_template_content() {
    let cases = [
        ("standard", 0, 1.0, EconomyPreset::Standard),
        ("creative", 120_000, 1.0, EconomyPreset::Creative),
        ("standard", i32::MAX, 2.75, EconomyPreset::Standard),
    ];

    for template in ["blankGrid", "crossroads"] {
        let canonical = create_sandbox_snapshot(SandboxCreationRequest {
            template_id: template.to_string(),
            economy_preset: "standard".to_string(),
            starting_capital: Some(120_000.0),
            demand_multiplier: Some(1.0),
        })
        .unwrap();

        for (economy, starting_capital, demand_multiplier, expected_economy) in cases {
            let settings_request = SandboxCreationRequest {
                template_id: template.to_string(),
                economy_preset: economy.to_string(),
                starting_capital: Some(f64::from(starting_capital)),
                demand_multiplier: Some(demand_multiplier),
            };
            let first = create_sandbox_snapshot(settings_request.clone()).unwrap();
            let second = create_sandbox_snapshot(settings_request).unwrap();

            assert_eq!(first, second);
            assert_eq!(first.map, canonical.map);
            assert_eq!(first.buildings, canonical.buildings);
            assert_eq!(first.sims, canonical.sims);
            assert_eq!(first.active_trips, canonical.active_trips);
            assert_eq!(first.transit, canonical.transit);
            assert_eq!(first.scenario, canonical.scenario);
            assert_eq!(first.metrics, canonical.metrics);
            assert_eq!(first.budget, starting_capital);
            assert_eq!(first.rules.game_mode, GameMode::Sandbox);
            assert_eq!(first.rules.economy_preset, expected_economy);
            assert_eq!(
                first.rules.sandbox.template_id,
                match template {
                    "blankGrid" => SandboxTemplateId::BlankGrid,
                    "crossroads" => SandboxTemplateId::Crossroads,
                    _ => unreachable!(),
                }
            );
            assert_eq!(
                first.rules.sandbox.starting_capital,
                StartingCapital::new(starting_capital).unwrap()
            );
            assert_eq!(
                first.rules.sandbox.demand_multiplier,
                DemandMultiplier::new(demand_multiplier).unwrap()
            );
        }
    }
}

#[test]
fn crossroads_has_the_canonical_automatic_junction_and_required_movements() {
    let snapshot = create_sandbox_snapshot(request("crossroads")).unwrap();
    let topology = RoadTopology::compile(&snapshot.map).unwrap();
    let structure = snapshot
        .map
        .road_structures
        .iter()
        .find(|structure| structure.id().starts_with("junction-"))
        .expect("Crossroads automatic junction");
    let expected_id = "junction-14,8;14,9;15,8;15,9-14,8:north;14,8:west;14,9:south;14,9:west;15,8:north;15,8:east;15,9:east;15,9:south";
    assert_eq!(structure.id(), expected_id);

    let mut footprint = structure.footprint().to_vec();
    footprint.sort();
    assert_eq!(
        footprint,
        vec![
            Point { x: 14, y: 8 },
            Point { x: 14, y: 9 },
            Point { x: 15, y: 8 },
            Point { x: 15, y: 9 },
        ]
    );
    assert_eq!(
        structure.port_keys(),
        vec![
            (Point { x: 14, y: 8 }, Heading::North),
            (Point { x: 14, y: 8 }, Heading::West),
            (Point { x: 14, y: 9 }, Heading::South),
            (Point { x: 14, y: 9 }, Heading::West),
            (Point { x: 15, y: 8 }, Heading::North),
            (Point { x: 15, y: 8 }, Heading::East),
            (Point { x: 15, y: 9 }, Heading::East),
            (Point { x: 15, y: 9 }, Heading::South),
        ]
    );
    for point in &footprint {
        let tile = snapshot.map.tile(*point).unwrap();
        assert_eq!(tile.kind, "road");
        assert_eq!(tile.one_way, None);
        assert_eq!(tile.road_structure_id.as_deref(), Some(expected_id));
        assert_eq!(
            tile.road_connections,
            vec![Heading::North, Heading::East, Heading::South, Heading::West]
        );
    }

    let required = [
        (
            RoadState {
                position: Point { x: 14, y: 8 },
                incoming_heading: Heading::South,
            },
            [
                (Heading::South, MovementKind::Straight),
                (Heading::West, MovementKind::RightTurn),
                (Heading::East, MovementKind::LeftTurn),
            ],
        ),
        (
            RoadState {
                position: Point { x: 15, y: 8 },
                incoming_heading: Heading::West,
            },
            [
                (Heading::West, MovementKind::Straight),
                (Heading::North, MovementKind::RightTurn),
                (Heading::South, MovementKind::LeftTurn),
            ],
        ),
        (
            RoadState {
                position: Point { x: 15, y: 9 },
                incoming_heading: Heading::North,
            },
            [
                (Heading::North, MovementKind::Straight),
                (Heading::East, MovementKind::RightTurn),
                (Heading::West, MovementKind::LeftTurn),
            ],
        ),
        (
            RoadState {
                position: Point { x: 14, y: 9 },
                incoming_heading: Heading::East,
            },
            [
                (Heading::East, MovementKind::Straight),
                (Heading::South, MovementKind::RightTurn),
                (Heading::North, MovementKind::LeftTurn),
            ],
        ),
    ];

    for (entry, movements) in required {
        for (outgoing, expected_kind) in movements {
            let transition = topology
                .transition_for(entry, outgoing)
                .expect("required Crossroads movement");
            assert_eq!(transition.movement, expected_kind);
        }
    }
}

#[test]
fn crossroads_current_compiler_exposes_four_center_uturns() {
    let snapshot = create_sandbox_snapshot(request("crossroads")).unwrap();
    let topology = RoadTopology::compile(&snapshot.map).unwrap();
    let characterized = [
        (
            RoadState {
                position: Point { x: 14, y: 8 },
                incoming_heading: Heading::South,
            },
            Heading::North,
        ),
        (
            RoadState {
                position: Point { x: 15, y: 8 },
                incoming_heading: Heading::West,
            },
            Heading::East,
        ),
        (
            RoadState {
                position: Point { x: 15, y: 9 },
                incoming_heading: Heading::North,
            },
            Heading::South,
        ),
        (
            RoadState {
                position: Point { x: 14, y: 9 },
                incoming_heading: Heading::East,
            },
            Heading::West,
        ),
    ];

    let uturns = characterized
        .into_iter()
        .filter(|(entry, outgoing)| {
            topology
                .transition_for(*entry, *outgoing)
                .is_some_and(|transition| transition.movement == MovementKind::UTurn)
        })
        .count();
    assert_eq!(uturns, 4);
}

fn entity_ids(collection: &Value) -> Vec<String> {
    collection
        .as_array()
        .expect("entity collection must be an array")
        .iter()
        .map(|entity| {
            entity["id"]
                .as_str()
                .expect("characterized entity must have an id")
                .to_string()
        })
        .collect()
}

fn template_review(template_id: &str) -> Value {
    let snapshot = create_sandbox_snapshot(SandboxCreationRequest {
        template_id: template_id.to_string(),
        economy_preset: "standard".to_string(),
        starting_capital: Some(120_000.0),
        demand_multiplier: Some(1.0),
    })
    .unwrap();
    let snapshot_json = serde_json::to_value(&snapshot).unwrap();
    let non_default_tiles = snapshot
        .map
        .tiles
        .iter()
        .filter(|tile| {
            tile.kind != "empty"
                || tile.area.is_some()
                || tile.has_track
                || tile.one_way.is_some()
                || !tile.road_connections.is_empty()
                || tile.road_structure_id.is_some()
        })
        .map(|tile| serde_json::to_value(tile).unwrap())
        .collect::<Vec<_>>();

    json!({
        "dimensions": {
            "width": snapshot.map.width,
            "height": snapshot.map.height,
        },
        "orderedTileIds": snapshot
            .map
            .tiles
            .iter()
            .map(|tile| tile.id.clone())
            .collect::<Vec<_>>(),
        "nonDefaultTiles": non_default_tiles,
        "roadStructures": snapshot_json["map"]["roadStructures"].clone(),
        "rules": snapshot_json["rules"].clone(),
        "budget": snapshot.budget,
        "scenario": snapshot_json["scenario"].clone(),
        "counters": {
            "schemaVersion": snapshot.schema_version,
            "time": snapshot.time,
            "day": snapshot.day,
            "clockMinutes": snapshot.clock_minutes,
            "speed": snapshot.speed,
            "paused": snapshot.paused,
            "tripSequenceDay": snapshot.trip_sequence_day,
            "nextTripSequence": snapshot.next_trip_sequence,
            "metrics": snapshot_json["metrics"].clone(),
        },
        "entityIds": {
            "buildings": entity_ids(&snapshot_json["buildings"]),
            "sims": entity_ids(&snapshot_json["sims"]),
            "activeTrips": entity_ids(&snapshot_json["activeTrips"]),
            "stops": entity_ids(&snapshot_json["transit"]["stops"]),
            "stations": entity_ids(&snapshot_json["transit"]["stations"]),
            "routes": entity_ids(&snapshot_json["transit"]["routes"]),
            "metroLines": entity_ids(&snapshot_json["transit"]["metroLines"]),
            "vehicles": entity_ids(&snapshot_json["transit"]["vehicles"]),
        },
    })
}

#[test]
fn sandbox_templates_match_the_reviewed_characterization_fixture() {
    let actual = serde_json::to_string_pretty(&json!({
        "blankGrid": template_review("blankGrid"),
        "crossroads": template_review("crossroads"),
    }))
    .unwrap()
        + "\n";

    if std::env::var_os("UPDATE_SANDBOX_FIXTURE").is_some() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/sandbox_templates.json");
        std::fs::write(path, actual).unwrap();
        return;
    }

    assert_eq!(
        actual,
        include_str!("fixtures/sandbox_templates.json"),
        "sandbox template characterization changed"
    );
}

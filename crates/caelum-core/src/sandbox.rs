use serde::{Deserialize, Serialize};

use crate::clock::{clock_minutes, day_index};
use crate::ids::tile_id;
use crate::intent::RoadPreset;
use crate::model::{
    DemandMultiplier, EconomyPreset, GameMap, GameRules, GameSnapshot, Heading, Metrics,
    MovementKind, Point, SandboxMapSize, SandboxSettings, SandboxTemplateId, StartingCapital, Tile,
    TransitNetwork, SNAPSHOT_SCHEMA_VERSION,
};
use crate::road::{author_scenario_road_line, junction_id, refresh_all_automatic_junctions};
use crate::road_topology::{RoadState, RoadTopology};
use crate::{areas, buildings};

pub const DEFAULT_STARTING_CAPITAL: i32 = 120_000;

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxCreationRequest {
    pub template_id: String,
    pub map_size: String,
    pub economy_preset: String,
    pub starting_capital: Option<f64>,
    pub demand_multiplier: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ValidatedSandboxCreationRequest {
    pub template_id: SandboxTemplateId,
    pub map_size: SandboxMapSize,
    pub economy_preset: EconomyPreset,
    pub starting_capital: StartingCapital,
    pub demand_multiplier: DemandMultiplier,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SandboxCreationErrorCode {
    UnknownTemplateId,
    UnknownMapSize,
    UnknownEconomyPreset,
    InvalidStartingCapital,
    InvalidDemandMultiplier,
    TemplateInvariantViolation,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxCreationErrorContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempted_value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxCreationError {
    pub code: SandboxCreationErrorCode,
    pub context: SandboxCreationErrorContext,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SandboxResetErrorCode {
    TemplateInvariantViolation,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxResetErrorContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template_id: Option<SandboxTemplateId>,
    /// The original `SandboxCreationErrorCode` that triggered the reset
    /// failure, when the reset path reconstructs sandbox rules and the
    /// reconstruction fails. Only present when the code differs from
    /// `TemplateInvariantViolation` (the expected case), so callers can
    /// distinguish corrupted-state failures from genuine template mismatches.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creation_error_code: Option<SandboxCreationErrorCode>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxResetError {
    pub code: SandboxResetErrorCode,
    pub context: SandboxResetErrorContext,
}

/// Map a `SandboxCreationError` from reconstructing a persisted sandbox's
/// `GameRules` back into a `SandboxResetError`. Only template-invariant
/// violations are expected at this stage: the persisted rules were validated
/// on save, so field-level validation errors should be unreachable here. If
/// an unexpected error code is observed anyway (e.g. corrupted persisted
/// state), it is surfaced as a `TemplateInvariantViolation` using
/// `rules.sandbox.template_id`, and the original `SandboxCreationErrorCode`
/// is preserved in `context.creation_error_code` so the diagnostic is not
/// lost.
fn sandbox_reset_error_from_creation_error(
    error: SandboxCreationError,
    rules: &GameRules,
) -> SandboxResetError {
    let creation_error_code = if error.code == SandboxCreationErrorCode::TemplateInvariantViolation
    {
        None
    } else {
        Some(error.code)
    };
    SandboxResetError {
        code: SandboxResetErrorCode::TemplateInvariantViolation,
        context: SandboxResetErrorContext {
            template_id: Some(rules.sandbox.template_id),
            creation_error_code,
        },
    }
}

pub fn canonical_default_request() -> SandboxCreationRequest {
    SandboxCreationRequest {
        template_id: "crossroads".to_string(),
        map_size: "small".to_string(),
        economy_preset: "standard".to_string(),
        starting_capital: Some(f64::from(DEFAULT_STARTING_CAPITAL)),
        demand_multiplier: Some(1.0),
    }
}

pub fn canonical_default_settings() -> SandboxSettings {
    sandbox_settings_from_validated(
        &validate_request(canonical_default_request())
            .expect("canonical default request must validate"),
    )
}

fn sandbox_settings_from_validated(validated: &ValidatedSandboxCreationRequest) -> SandboxSettings {
    SandboxSettings {
        template_id: validated.template_id,
        map_size: validated.map_size,
        starting_capital: validated.starting_capital,
        demand_multiplier: validated.demand_multiplier,
    }
}

pub fn validate_request(
    request: SandboxCreationRequest,
) -> Result<ValidatedSandboxCreationRequest, SandboxCreationError> {
    let template_id = parse_template(&request.template_id)?;
    let map_size = parse_map_size(&request.map_size)?;
    let economy_preset = parse_economy_preset(&request.economy_preset)?;
    let starting_capital = parse_starting_capital(request.starting_capital)?;
    let demand_multiplier = parse_demand_multiplier(request.demand_multiplier)?;

    Ok(ValidatedSandboxCreationRequest {
        template_id,
        map_size,
        economy_preset,
        starting_capital,
        demand_multiplier,
    })
}

pub fn create_sandbox_snapshot(
    request: SandboxCreationRequest,
) -> Result<GameSnapshot, SandboxCreationError> {
    let SandboxCandidate {
        snapshot,
        road_topology: _road_topology,
    } = create_sandbox_candidate(request)?;
    Ok(snapshot)
}

pub(crate) struct SandboxCandidate {
    pub snapshot: GameSnapshot,
    pub road_topology: RoadTopology,
}

pub(crate) fn create_sandbox_candidate(
    request: SandboxCreationRequest,
) -> Result<SandboxCandidate, SandboxCreationError> {
    let validated = validate_request(request)?;
    let (map, road_topology) = match validated.template_id {
        SandboxTemplateId::BlankGrid => {
            let map = blank_map(validated.map_size);
            let topology = RoadTopology::compile(&map)
                .map_err(|_| template_invariant_error(SandboxTemplateId::BlankGrid))?;
            (map, topology)
        }
        SandboxTemplateId::Crossroads => {
            let mut map = blank_map(validated.map_size);
            let (width, height) = validated.map_size.dimensions();
            let center = crossroads_junction_origin(&map);
            author_scenario_road_line(
                &mut map,
                &(0..i32::from(width))
                    .rev()
                    .map(|x| Point { x, y: center.y })
                    .collect::<Vec<_>>(),
                RoadPreset::OneWay,
            );
            author_scenario_road_line(
                &mut map,
                &(0..i32::from(width))
                    .map(|x| Point { x, y: center.y + 1 })
                    .collect::<Vec<_>>(),
                RoadPreset::OneWay,
            );
            author_scenario_road_line(
                &mut map,
                &(0..i32::from(height))
                    .map(|y| Point { x: center.x, y })
                    .collect::<Vec<_>>(),
                RoadPreset::OneWay,
            );
            author_scenario_road_line(
                &mut map,
                &(0..i32::from(height))
                    .rev()
                    .map(|y| Point { x: center.x + 1, y })
                    .collect::<Vec<_>>(),
                RoadPreset::OneWay,
            );
            refresh_all_automatic_junctions(&mut map)
                .map_err(|_| template_invariant_error(SandboxTemplateId::Crossroads))?;
            let topology = RoadTopology::compile(&map)
                .map_err(|_| template_invariant_error(SandboxTemplateId::Crossroads))?;
            validate_crossroads_candidate(&map, &topology)?;
            (map, topology)
        }
        SandboxTemplateId::SmallTown => return create_small_town_candidate(validated),
    };
    Ok(SandboxCandidate {
        snapshot: snapshot_shell(validated, map),
        road_topology,
    })
}

fn create_small_town_candidate(
    validated: ValidatedSandboxCreationRequest,
) -> Result<SandboxCandidate, SandboxCreationError> {
    let fail = || template_invariant_error(SandboxTemplateId::SmallTown);
    let mut map = blank_map(validated.map_size);
    // The town is authored on the Small map and centered on larger maps.
    let offset = centered_layout_offset(&map);
    let at = |x: i32, y: i32| Point {
        x: x + offset.x,
        y: y + offset.y,
    };

    author_scenario_road_line(
        &mut map,
        &(3..=24).map(|x| at(x, 8)).collect::<Vec<_>>(),
        RoadPreset::TwoWay,
    );
    author_scenario_road_line(
        &mut map,
        &(2..=15).map(|y| at(14, y)).collect::<Vec<_>>(),
        RoadPreset::TwoWay,
    );
    refresh_all_automatic_junctions(&mut map).map_err(|_| fail())?;
    let road_topology = RoadTopology::compile(&map).map_err(|_| fail())?;

    let mut snapshot = snapshot_shell(validated, map);

    for (area, start, end) in [
        ("residential", at(4, 6), at(10, 7)),
        ("commercial", at(18, 6), at(19, 7)),
        ("industrial", at(15, 11), at(17, 12)),
        ("office", at(21, 6), at(22, 7)),
    ] {
        snapshot =
            areas::paint_area_rectangle(&snapshot, area, &start, &end).map_err(|_| fail())?;
    }

    for (building_type, origin) in [
        ("smallHouse", at(4, 7)),
        ("smallHouse", at(8, 7)),
        ("smallHouse", at(6, 7)),
        ("officeTower", at(21, 6)),
        ("supermarket", at(18, 6)),
        ("factory", at(15, 11)),
    ] {
        snapshot = buildings::place_building_core(&snapshot, building_type, &origin, 0)
            .map_err(|_| fail())?;
    }

    Ok(SandboxCandidate {
        snapshot,
        road_topology,
    })
}

pub(crate) fn sandbox_candidate_from_persisted_rules(
    rules: &GameRules,
) -> Result<SandboxCandidate, SandboxResetError> {
    let request = SandboxCreationRequest {
        template_id: match rules.sandbox.template_id {
            SandboxTemplateId::BlankGrid => "blankGrid",
            SandboxTemplateId::Crossroads => "crossroads",
            SandboxTemplateId::SmallTown => "smallTown",
        }
        .to_string(),
        map_size: map_size_id(rules.sandbox.map_size).to_string(),
        economy_preset: match rules.economy_preset {
            EconomyPreset::Standard => "standard",
            EconomyPreset::Creative => "creative",
        }
        .to_string(),
        starting_capital: Some(f64::from(rules.sandbox.starting_capital.value())),
        demand_multiplier: Some(rules.sandbox.demand_multiplier.value()),
    };

    create_sandbox_candidate(request)
        .map_err(|error| sandbox_reset_error_from_creation_error(error, rules))
}

fn blank_map(size: SandboxMapSize) -> GameMap {
    let (width, height) = size.dimensions();
    let tiles = (0..i32::from(height))
        .flat_map(|y| {
            (0..i32::from(width)).map(move |x| Tile {
                id: tile_id(x, y),
                x,
                y,
                kind: "empty".to_string(),
                area: None,
                has_track: false,
                one_way: None,
                road_connections: Vec::new(),
                road_structure_id: None,
            })
        })
        .collect();
    GameMap {
        width,
        height,
        tiles,
        road_structures: Vec::new(),
    }
}

/// Whole-tile offset that centers a layout authored on the Small map.
fn centered_layout_offset(map: &GameMap) -> Point {
    let (small_width, small_height) = SandboxMapSize::Small.dimensions();
    Point {
        x: (i32::from(map.width) - i32::from(small_width)) / 2,
        y: (i32::from(map.height) - i32::from(small_height)) / 2,
    }
}

/// North-west tile of the Crossroads 2x2 center junction.
fn crossroads_junction_origin(map: &GameMap) -> Point {
    let offset = centered_layout_offset(map);
    Point {
        x: 14 + offset.x,
        y: 8 + offset.y,
    }
}

fn validate_crossroads_candidate(
    map: &GameMap,
    topology: &RoadTopology,
) -> Result<(), SandboxCreationError> {
    let fail = || template_invariant_error(SandboxTemplateId::Crossroads);
    let origin = crossroads_junction_origin(map);
    let at = |dx: i32, dy: i32| Point {
        x: origin.x + dx,
        y: origin.y + dy,
    };
    let expected_footprint = [at(0, 0), at(0, 1), at(1, 0), at(1, 1)];
    let expected_ports = vec![
        (at(0, 0), Heading::North),
        (at(0, 0), Heading::West),
        (at(0, 1), Heading::South),
        (at(0, 1), Heading::West),
        (at(1, 0), Heading::North),
        (at(1, 0), Heading::East),
        (at(1, 1), Heading::East),
        (at(1, 1), Heading::South),
    ];
    let expected_id = junction_id(&expected_footprint, &expected_ports);
    let structure = map
        .road_structures
        .iter()
        .find(|structure| structure.id() == expected_id)
        .ok_or_else(fail)?;
    if map.road_structures.len() != 1 || !structure.is_automatic_junction() {
        return Err(fail());
    }
    let mut footprint = structure.footprint().to_vec();
    footprint.sort();
    if footprint != expected_footprint || structure.port_keys() != expected_ports {
        return Err(fail());
    }

    let expected_connections = [Heading::North, Heading::East, Heading::South, Heading::West];
    for point in expected_footprint {
        let Some(tile) = map.tile(point) else {
            return Err(fail());
        };
        if tile.kind != "road"
            || tile.one_way.is_some()
            || tile.road_connections != expected_connections
            || tile.road_structure_id.as_deref() != Some(expected_id.as_str())
        {
            return Err(fail());
        }
    }

    let required = [
        (
            RoadState {
                position: at(0, 0),
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
                position: at(1, 0),
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
                position: at(1, 1),
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
                position: at(0, 1),
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
        for (outgoing, expected_movement) in movements {
            if !topology
                .transition_for(entry, outgoing)
                .is_some_and(|transition| transition.movement == expected_movement)
            {
                return Err(fail());
            }
        }
    }
    Ok(())
}

fn snapshot_shell(validated: ValidatedSandboxCreationRequest, map: GameMap) -> GameSnapshot {
    GameSnapshot {
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        time: 0.0,
        day: day_index(0.0),
        clock_minutes: clock_minutes(0.0),
        speed: 1,
        paused: true,
        budget: validated.starting_capital.value(),
        rules: GameRules {
            economy_preset: validated.economy_preset,
            sandbox: sandbox_settings_from_validated(&validated),
        },
        map,
        buildings: Vec::new(),
        transit: TransitNetwork {
            stops: Vec::new(),
            stations: Vec::new(),
            routes: Vec::new(),
            metro_lines: Vec::new(),
            vehicles: Vec::new(),
        },
        sims: Vec::new(),
        active_trips: Vec::new(),
        trip_sequence_day: day_index(0.0),
        next_trip_sequence: 1,
        // The first move-in mints sim-001, so the high-water mark starts at 1.
        // This matches what `build_world` derives from an empty sim list
        // (`max(empty)+1 = 1`), keeping raw sandbox snapshots equal to engine
        // snapshots.
        next_citizen_ordinal: 1,
        metrics: Metrics {
            late_trips: 0,
            completed_trips: 0,
            unserved_trips: 0,
            total_wait_seconds: 0.0,
            waiting_trip_count: 0,
            average_wait_seconds: 0.0,
        },
    }
}

fn template_invariant_error(template_id: SandboxTemplateId) -> SandboxCreationError {
    SandboxCreationError {
        code: SandboxCreationErrorCode::TemplateInvariantViolation,
        context: SandboxCreationErrorContext {
            field: None,
            attempted_value: None,
            template_id: Some(
                match template_id {
                    SandboxTemplateId::BlankGrid => "blankGrid",
                    SandboxTemplateId::Crossroads => "crossroads",
                    SandboxTemplateId::SmallTown => "smallTown",
                }
                .to_string(),
            ),
        },
    }
}

fn parse_template(value: &str) -> Result<SandboxTemplateId, SandboxCreationError> {
    match value {
        "blankGrid" => Ok(SandboxTemplateId::BlankGrid),
        "crossroads" => Ok(SandboxTemplateId::Crossroads),
        "smallTown" => Ok(SandboxTemplateId::SmallTown),
        _ => Err(creation_error(
            SandboxCreationErrorCode::UnknownTemplateId,
            "templateId",
            value,
        )),
    }
}

fn parse_map_size(value: &str) -> Result<SandboxMapSize, SandboxCreationError> {
    match value {
        "small" => Ok(SandboxMapSize::Small),
        "medium" => Ok(SandboxMapSize::Medium),
        "large" => Ok(SandboxMapSize::Large),
        _ => Err(creation_error(
            SandboxCreationErrorCode::UnknownMapSize,
            "mapSize",
            value,
        )),
    }
}

fn map_size_id(size: SandboxMapSize) -> &'static str {
    match size {
        SandboxMapSize::Small => "small",
        SandboxMapSize::Medium => "medium",
        SandboxMapSize::Large => "large",
    }
}

fn parse_economy_preset(value: &str) -> Result<EconomyPreset, SandboxCreationError> {
    match value {
        "standard" => Ok(EconomyPreset::Standard),
        "creative" => Ok(EconomyPreset::Creative),
        _ => Err(creation_error(
            SandboxCreationErrorCode::UnknownEconomyPreset,
            "economyPreset",
            value,
        )),
    }
}

fn parse_starting_capital(value: Option<f64>) -> Result<StartingCapital, SandboxCreationError> {
    let attempted_value = canonical_numeric(value);
    let Some(value) = value else {
        return Err(creation_error(
            SandboxCreationErrorCode::InvalidStartingCapital,
            "startingCapital",
            &attempted_value,
        ));
    };

    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > f64::from(i32::MAX) {
        return Err(creation_error(
            SandboxCreationErrorCode::InvalidStartingCapital,
            "startingCapital",
            &attempted_value,
        ));
    }

    StartingCapital::new(value as i32).map_err(|_| {
        creation_error(
            SandboxCreationErrorCode::InvalidStartingCapital,
            "startingCapital",
            &attempted_value,
        )
    })
}

fn parse_demand_multiplier(value: Option<f64>) -> Result<DemandMultiplier, SandboxCreationError> {
    let attempted_value = canonical_numeric(value);
    let Some(value) = value else {
        return Err(creation_error(
            SandboxCreationErrorCode::InvalidDemandMultiplier,
            "demandMultiplier",
            &attempted_value,
        ));
    };

    DemandMultiplier::new(value).map_err(|_| {
        creation_error(
            SandboxCreationErrorCode::InvalidDemandMultiplier,
            "demandMultiplier",
            &attempted_value,
        )
    })
}

fn canonical_numeric(value: Option<f64>) -> String {
    match value {
        None => "null".to_string(),
        Some(value) if value.is_nan() => "NaN".to_string(),
        Some(value) if value == f64::INFINITY => "Infinity".to_string(),
        Some(value) if value == f64::NEG_INFINITY => "-Infinity".to_string(),
        Some(value) => value.to_string(),
    }
}

fn creation_error(
    code: SandboxCreationErrorCode,
    field: &str,
    attempted_value: &str,
) -> SandboxCreationError {
    SandboxCreationError {
        code,
        context: SandboxCreationErrorContext {
            field: Some(field.to_string()),
            attempted_value: Some(attempted_value.to_string()),
            template_id: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{
        create_sandbox_candidate, validate_crossroads_candidate, validate_request,
        SandboxCreationErrorCode, SandboxCreationRequest,
    };
    use crate::model::{Heading, Point};
    use crate::road_topology::RoadTopology;

    fn raw_request() -> SandboxCreationRequest {
        SandboxCreationRequest {
            template_id: "crossroads".to_string(),
            map_size: "small".to_string(),
            economy_preset: "standard".to_string(),
            starting_capital: Some(120_000.0),
            demand_multiplier: Some(1.0),
        }
    }

    #[test]
    fn validation_classifies_unknown_strings() {
        let cases = [
            (
                "templateId",
                "unknown",
                SandboxCreationErrorCode::UnknownTemplateId,
            ),
            ("mapSize", "huge", SandboxCreationErrorCode::UnknownMapSize),
            (
                "economyPreset",
                "unknown",
                SandboxCreationErrorCode::UnknownEconomyPreset,
            ),
        ];

        for (field, attempted, code) in cases {
            let mut request = raw_request();
            match field {
                "templateId" => request.template_id = attempted.to_string(),
                "mapSize" => request.map_size = attempted.to_string(),
                "economyPreset" => request.economy_preset = attempted.to_string(),
                _ => unreachable!(),
            }
            let error = validate_request(request).unwrap_err();
            assert_eq!(error.code, code);
            assert_eq!(error.context.field.as_deref(), Some(field));
            assert_eq!(error.context.attempted_value.as_deref(), Some(attempted));
        }
    }

    #[test]
    fn validation_rejects_every_invalid_numeric_class() {
        for (value, attempted) in [
            (None, "null"),
            (Some(-1.0), "-1"),
            (Some(1.5), "1.5"),
            (Some(f64::NAN), "NaN"),
            (Some(f64::INFINITY), "Infinity"),
            (Some(f64::NEG_INFINITY), "-Infinity"),
            (Some(f64::from(i32::MAX) + 1.0), "2147483648"),
        ] {
            let mut request = raw_request();
            request.starting_capital = value;
            let error = validate_request(request).unwrap_err();
            assert_eq!(error.code, SandboxCreationErrorCode::InvalidStartingCapital);
            assert_eq!(error.context.attempted_value.as_deref(), Some(attempted));
        }

        for (value, attempted) in [
            (None, "null"),
            (Some(0.0), "0"),
            (Some(-1.0), "-1"),
            (Some(f64::NAN), "NaN"),
            (Some(f64::INFINITY), "Infinity"),
            (Some(f64::NEG_INFINITY), "-Infinity"),
        ] {
            let mut request = raw_request();
            request.demand_multiplier = value;
            let error = validate_request(request).unwrap_err();
            assert_eq!(
                error.code,
                SandboxCreationErrorCode::InvalidDemandMultiplier
            );
            assert_eq!(error.context.attempted_value.as_deref(), Some(attempted));
        }
    }

    #[test]
    fn crossroads_validator_rejects_a_missing_required_center_connection() {
        let candidate = create_sandbox_candidate(raw_request()).unwrap();
        let mut map = candidate.snapshot.map;
        map.tile_mut(Point { x: 14, y: 8 })
            .unwrap()
            .road_connections
            .retain(|heading| *heading != Heading::West);
        let topology = RoadTopology::compile(&map).unwrap();

        let error = validate_crossroads_candidate(&map, &topology).unwrap_err();
        assert_eq!(
            error.code,
            SandboxCreationErrorCode::TemplateInvariantViolation
        );
        assert_eq!(error.context.template_id.as_deref(), Some("crossroads"));
    }

    #[test]
    fn crossroads_validator_rejects_an_extra_structure() {
        let candidate = create_sandbox_candidate(raw_request()).unwrap();
        let mut map = candidate.snapshot.map;
        // Push a benign second structure so `road_structures.len() != 1`.
        map.road_structures
            .push(crate::model::RoadStructure::AutomaticJunction {
                id: "extra".to_string(),
                footprint: Vec::new(),
                ports: Vec::new(),
            });
        let topology = RoadTopology::compile(&map).unwrap();

        let error = validate_crossroads_candidate(&map, &topology).unwrap_err();
        assert_eq!(
            error.code,
            SandboxCreationErrorCode::TemplateInvariantViolation
        );
        assert_eq!(error.context.template_id.as_deref(), Some("crossroads"));
    }

    #[test]
    fn crossroads_validator_rejects_a_wrong_structure_port_set() {
        let candidate = create_sandbox_candidate(raw_request()).unwrap();
        let mut map = candidate.snapshot.map;
        // Drop one captured port so `structure.port_keys()` no longer matches
        // the expected canonical port set.
        if let crate::model::RoadStructure::AutomaticJunction {
            id,
            footprint,
            mut ports,
        } = map.road_structures[0].clone()
        {
            ports.pop();
            map.road_structures[0] = crate::model::RoadStructure::AutomaticJunction {
                id,
                footprint,
                ports,
            };
        }
        let topology = RoadTopology::compile(&map).unwrap();

        let error = validate_crossroads_candidate(&map, &topology).unwrap_err();
        assert_eq!(
            error.code,
            SandboxCreationErrorCode::TemplateInvariantViolation
        );
        assert_eq!(error.context.template_id.as_deref(), Some("crossroads"));
    }

    #[test]
    fn crossroads_validator_rejects_a_broken_approach_movement() {
        let candidate = create_sandbox_candidate(raw_request()).unwrap();
        let mut map = candidate.snapshot.map;
        // Demolish the approach tile west of the (14,8) footprint tile. The
        // four footprint tiles keep their canonical connections, so the
        // connection check passes, but the (14,8) incoming-South → West
        // transition no longer exists, so a required movement is missing.
        let approach = map.tile_mut(Point { x: 13, y: 8 }).unwrap();
        approach.kind = "empty".to_string();
        approach.one_way = None;
        approach.road_connections.clear();
        approach.road_structure_id = None;
        let topology = RoadTopology::compile(&map).unwrap();

        let error = validate_crossroads_candidate(&map, &topology).unwrap_err();
        assert_eq!(
            error.code,
            SandboxCreationErrorCode::TemplateInvariantViolation
        );
        assert_eq!(error.context.template_id.as_deref(), Some("crossroads"));
    }
}

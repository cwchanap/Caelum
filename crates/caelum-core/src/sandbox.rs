use serde::{Deserialize, Serialize};

use crate::clock::{clock_minutes, day_index};
use crate::ids::tile_id;
use crate::intent::RoadPreset;
use crate::model::{
    DemandMultiplier, EconomyPreset, GameMap, GameMode, GameRules, GameSnapshot, Heading, Metrics,
    MetricsState, MoveInRateSelection, MovementKind, Point, SandboxSettings, SandboxTemplateId,
    ScenarioConfig, StartingCapital, Tile, TransitNetwork, SNAPSHOT_SCHEMA_VERSION,
};
use crate::road::{author_scenario_road_line, refresh_all_automatic_junctions};
use crate::road_topology::{RoadState, RoadTopology};

pub const DEFAULT_STARTING_CAPITAL: i32 = 120_000;
pub const MAP_WIDTH: u8 = 28;
pub const MAP_HEIGHT: u8 = 18;
const CROSSROADS_STRUCTURE_ID: &str = "junction-14,8;14,9;15,8;15,9-14,8:north;14,8:west;14,9:south;14,9:west;15,8:north;15,8:east;15,9:east;15,9:south";

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxCreationRequest {
    pub template_id: String,
    pub economy_preset: String,
    pub starting_capital: Option<f64>,
    pub demand_multiplier: Option<f64>,
    pub move_in_rate: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ValidatedSandboxCreationRequest {
    pub template_id: SandboxTemplateId,
    pub economy_preset: EconomyPreset,
    pub starting_capital: StartingCapital,
    pub demand_multiplier: DemandMultiplier,
    pub move_in_rate: MoveInRateSelection,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SandboxCreationErrorCode {
    UnknownTemplateId,
    UnknownEconomyPreset,
    InvalidStartingCapital,
    InvalidDemandMultiplier,
    UnknownMoveInRate,
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
    UnsupportedGameMode,
    TemplateInvariantViolation,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxResetErrorContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_mode: Option<GameMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template_id: Option<SandboxTemplateId>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxResetError {
    pub code: SandboxResetErrorCode,
    pub context: SandboxResetErrorContext,
}

impl SandboxResetError {
    fn unsupported_game_mode(game_mode: GameMode) -> Self {
        Self {
            code: SandboxResetErrorCode::UnsupportedGameMode,
            context: SandboxResetErrorContext {
                game_mode: Some(game_mode),
                template_id: None,
            },
        }
    }

    fn template_invariant_violation(template_id: SandboxTemplateId) -> Self {
        Self {
            code: SandboxResetErrorCode::TemplateInvariantViolation,
            context: SandboxResetErrorContext {
                game_mode: None,
                template_id: Some(template_id),
            },
        }
    }
}

/// Map a `SandboxCreationError` from reconstructing a persisted sandbox's
/// `GameRules` back into a `SandboxResetError`. Only template-invariant
/// violations are expected at this stage: the persisted rules were validated
/// on save, so field-level validation errors should be unreachable here. If
/// an unexpected error code is observed anyway (e.g. corrupted persisted
/// state), it is surfaced as a `TemplateInvariantViolation` using
/// `rules.sandbox.template_id` rather than panicking.
fn sandbox_reset_error_from_creation_error(
    error: SandboxCreationError,
    rules: &GameRules,
) -> SandboxResetError {
    let _ = error;
    SandboxResetError::template_invariant_violation(rules.sandbox.template_id)
}

pub fn canonical_default_request() -> SandboxCreationRequest {
    SandboxCreationRequest {
        template_id: "crossroads".to_string(),
        economy_preset: "standard".to_string(),
        starting_capital: Some(f64::from(DEFAULT_STARTING_CAPITAL)),
        demand_multiplier: Some(1.0),
        move_in_rate: "paused".to_string(),
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
        starting_capital: validated.starting_capital,
        demand_multiplier: validated.demand_multiplier,
        move_in_rate: validated.move_in_rate,
    }
}

pub fn validate_request(
    request: SandboxCreationRequest,
) -> Result<ValidatedSandboxCreationRequest, SandboxCreationError> {
    let template_id = parse_template(&request.template_id)?;
    let economy_preset = parse_economy_preset(&request.economy_preset)?;
    let starting_capital = parse_starting_capital(request.starting_capital)?;
    let demand_multiplier = parse_demand_multiplier(request.demand_multiplier)?;
    let move_in_rate = parse_move_in_rate(&request.move_in_rate)?;

    Ok(ValidatedSandboxCreationRequest {
        template_id,
        economy_preset,
        starting_capital,
        demand_multiplier,
        move_in_rate,
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
    let (name, map, road_topology) = match validated.template_id {
        SandboxTemplateId::BlankGrid => {
            let map = blank_map();
            let topology = RoadTopology::compile(&map)
                .map_err(|_| template_invariant_error(SandboxTemplateId::BlankGrid))?;
            ("Blank Grid", map, topology)
        }
        SandboxTemplateId::Crossroads => {
            let mut map = blank_map();
            author_scenario_road_line(
                &mut map,
                &(0..i32::from(MAP_WIDTH))
                    .rev()
                    .map(|x| Point { x, y: 8 })
                    .collect::<Vec<_>>(),
                RoadPreset::OneWay,
            );
            author_scenario_road_line(
                &mut map,
                &(0..i32::from(MAP_WIDTH))
                    .map(|x| Point { x, y: 9 })
                    .collect::<Vec<_>>(),
                RoadPreset::OneWay,
            );
            author_scenario_road_line(
                &mut map,
                &(0..i32::from(MAP_HEIGHT))
                    .map(|y| Point { x: 14, y })
                    .collect::<Vec<_>>(),
                RoadPreset::OneWay,
            );
            author_scenario_road_line(
                &mut map,
                &(0..i32::from(MAP_HEIGHT))
                    .rev()
                    .map(|y| Point { x: 15, y })
                    .collect::<Vec<_>>(),
                RoadPreset::OneWay,
            );
            refresh_all_automatic_junctions(&mut map)
                .map_err(|_| template_invariant_error(SandboxTemplateId::Crossroads))?;
            let topology = RoadTopology::compile(&map)
                .map_err(|_| template_invariant_error(SandboxTemplateId::Crossroads))?;
            validate_crossroads_candidate(&map, &topology)?;
            ("Crossroads", map, topology)
        }
    };
    Ok(SandboxCandidate {
        snapshot: snapshot_shell(validated, name, map),
        road_topology,
    })
}

pub(crate) fn sandbox_candidate_from_persisted_rules(
    rules: &GameRules,
) -> Result<SandboxCandidate, SandboxResetError> {
    if rules.game_mode != GameMode::Sandbox {
        return Err(SandboxResetError::unsupported_game_mode(rules.game_mode));
    }

    let request = SandboxCreationRequest {
        template_id: match rules.sandbox.template_id {
            SandboxTemplateId::BlankGrid => "blankGrid",
            SandboxTemplateId::Crossroads => "crossroads",
        }
        .to_string(),
        economy_preset: match rules.economy_preset {
            EconomyPreset::Standard => "standard",
            EconomyPreset::Creative => "creative",
        }
        .to_string(),
        starting_capital: Some(f64::from(rules.sandbox.starting_capital.value())),
        demand_multiplier: Some(rules.sandbox.demand_multiplier.value()),
        move_in_rate: match rules.sandbox.move_in_rate {
            MoveInRateSelection::Paused => "paused",
        }
        .to_string(),
    };

    create_sandbox_candidate(request)
        .map_err(|error| sandbox_reset_error_from_creation_error(error, rules))
}

fn blank_map() -> GameMap {
    let tiles = (0..i32::from(MAP_HEIGHT))
        .flat_map(|y| {
            (0..i32::from(MAP_WIDTH)).map(move |x| Tile {
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
        width: MAP_WIDTH,
        height: MAP_HEIGHT,
        tiles,
        road_structures: Vec::new(),
    }
}

fn validate_crossroads_candidate(
    map: &GameMap,
    topology: &RoadTopology,
) -> Result<(), SandboxCreationError> {
    let fail = || template_invariant_error(SandboxTemplateId::Crossroads);
    let expected_footprint = [
        Point { x: 14, y: 8 },
        Point { x: 14, y: 9 },
        Point { x: 15, y: 8 },
        Point { x: 15, y: 9 },
    ];
    let expected_ports = vec![
        (Point { x: 14, y: 8 }, Heading::North),
        (Point { x: 14, y: 8 }, Heading::West),
        (Point { x: 14, y: 9 }, Heading::South),
        (Point { x: 14, y: 9 }, Heading::West),
        (Point { x: 15, y: 8 }, Heading::North),
        (Point { x: 15, y: 8 }, Heading::East),
        (Point { x: 15, y: 9 }, Heading::East),
        (Point { x: 15, y: 9 }, Heading::South),
    ];
    let structure = map
        .road_structures
        .iter()
        .find(|structure| structure.id() == CROSSROADS_STRUCTURE_ID)
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
            || tile.road_structure_id.as_deref() != Some(CROSSROADS_STRUCTURE_ID)
        {
            return Err(fail());
        }
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

fn snapshot_shell(
    validated: ValidatedSandboxCreationRequest,
    name: &str,
    map: GameMap,
) -> GameSnapshot {
    GameSnapshot {
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        time: 0.0,
        day: day_index(0.0),
        clock_minutes: clock_minutes(0.0),
        speed: 1,
        paused: true,
        budget: validated.starting_capital.value(),
        rules: GameRules {
            game_mode: GameMode::Sandbox,
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
        metrics: Metrics {
            late_trips: 0,
            completed_trips: 0,
            unserved_trips: 0,
            total_wait_seconds: 0.0,
            waiting_trip_count: 0,
            average_wait_seconds: 0.0,
            trip_outcomes: Vec::new(),
            state: MetricsState::Running,
            loss_reason: None,
        },
        scenario: ScenarioConfig {
            name: name.to_string(),
            objectives: None,
            growth_waves: Vec::new(),
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
        _ => Err(creation_error(
            SandboxCreationErrorCode::UnknownTemplateId,
            "templateId",
            value,
        )),
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

fn parse_move_in_rate(value: &str) -> Result<MoveInRateSelection, SandboxCreationError> {
    match value {
        "paused" => Ok(MoveInRateSelection::Paused),
        _ => Err(creation_error(
            SandboxCreationErrorCode::UnknownMoveInRate,
            "moveInRate",
            value,
        )),
    }
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
            economy_preset: "standard".to_string(),
            starting_capital: Some(120_000.0),
            demand_multiplier: Some(1.0),
            move_in_rate: "paused".to_string(),
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
            (
                "economyPreset",
                "unknown",
                SandboxCreationErrorCode::UnknownEconomyPreset,
            ),
            (
                "moveInRate",
                "unknown",
                SandboxCreationErrorCode::UnknownMoveInRate,
            ),
        ];

        for (field, attempted, code) in cases {
            let mut request = raw_request();
            match field {
                "templateId" => request.template_id = attempted.to_string(),
                "economyPreset" => request.economy_preset = attempted.to_string(),
                "moveInRate" => request.move_in_rate = attempted.to_string(),
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

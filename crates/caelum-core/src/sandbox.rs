use serde::{Deserialize, Serialize};

use crate::model::{
    DemandMultiplier, EconomyPreset, MoveInRateSelection, SandboxSettings, SandboxTemplateId,
    StartingCapital,
};

pub const DEFAULT_STARTING_CAPITAL: i32 = 120_000;

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
    SandboxSettings {
        template_id: SandboxTemplateId::Crossroads,
        starting_capital: StartingCapital::new(DEFAULT_STARTING_CAPITAL)
            .expect("default starting capital is valid"),
        demand_multiplier: DemandMultiplier::default(),
        move_in_rate: MoveInRateSelection::Paused,
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
    use super::{validate_request, SandboxCreationErrorCode, SandboxCreationRequest};

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
}

//! Shared persistence bridge contract used by both the WASM and Tauri hosts.
//!
//! The host bridges wrap [`PersistenceError`] with operation/source/phase/host
//! metadata so the frontend persistence layer can classify every failure
//! uniformly. These types are the single source of truth for that wire shape;
//! each host only contributes its own encoding helpers (`JsValue` for WASM,
//! `serde_json::Value` for Tauri).
//!
//! Wire format: `PersistenceBridgeError` is internally tagged by `kind` with
//! `camelCase` variants and field names, matching the frontend
//! `PersistenceOperationError` discriminated union exactly. Changing the serde
//! attributes or variant names is a wire-format break.

use serde::Serialize;

use crate::persistence::PersistenceError;

/// The three public persistence operations exposed by both host bridges.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PersistenceOperation {
    SnapshotForSave,
    ValidateSnapshot,
    RestoreSnapshot,
}

/// Whether a validation failure was observed on the active engine or a
/// restore candidate.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PersistenceValidationSource {
    ActiveEngine,
    Candidate,
}

/// The serialization phase that failed while decoding or encoding a snapshot.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PersistenceSerializationPhase {
    SnapshotDecode,
    SnapshotEncode,
}

/// Host-layer error codes produced outside the core validation/serialization
/// pipeline (e.g. unavailable managed state, malformed success/error payloads).
/// Not every variant is constructed by the Rust host bridges — the frontend
/// persistence layer also emits these codes — but they are part of the closed
/// wire contract and must round-trip identically across hosts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PersistenceHostErrorCode {
    StateUnavailable,
    InvokeFailed,
    MalformedSuccess,
    MalformedError,
}

/// The tagged persistence bridge error shared by both hosts.
///
/// Serializes as `{ "kind": "validation" | "serialization" | "host", ... }`
/// with `camelCase` field names, matching the frontend
/// `PersistenceOperationError` discriminated union.
#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PersistenceBridgeError {
    Validation {
        operation: PersistenceOperation,
        source: PersistenceValidationSource,
        error: PersistenceError,
    },
    Serialization {
        operation: PersistenceOperation,
        phase: PersistenceSerializationPhase,
        diagnostic: String,
    },
    Host {
        operation: PersistenceOperation,
        code: PersistenceHostErrorCode,
        diagnostic: String,
    },
}

impl PersistenceBridgeError {
    /// A core validation failure observed on the active engine or a candidate.
    pub fn validation(
        operation: PersistenceOperation,
        source: PersistenceValidationSource,
        error: PersistenceError,
    ) -> Self {
        Self::Validation {
            operation,
            source,
            error,
        }
    }

    /// A snapshot decode/encode serialization failure.
    pub fn serialization(
        operation: PersistenceOperation,
        phase: PersistenceSerializationPhase,
        diagnostic: impl ToString,
    ) -> Self {
        Self::Serialization {
            operation,
            phase,
            diagnostic: diagnostic.to_string(),
        }
    }

    /// A host-layer failure outside the core persistence pipeline.
    pub fn host(
        operation: PersistenceOperation,
        code: PersistenceHostErrorCode,
        diagnostic: impl ToString,
    ) -> Self {
        Self::Host {
            operation,
            code,
            diagnostic: diagnostic.to_string(),
        }
    }
}

# HPA-341 Persistence Host Parity — Second-Review Amendments

**Status:** Normative companion to
`2026-07-30-persistence-host-parity-design.md`.

**Applicability:** These amendments were accepted after the second design-review pass.
Where this document conflicts with the original design, this document wins. Unchanged
sections of the original design remain authoritative.

**Scope:** Documentation only. No HPA-341 implementation is included.

## Disposition Summary

| Review item | Disposition |
| --- | --- |
| Validation success value was unspecified | Accepted. Only raw `undefined` or `null` means success. |
| Nullable inventory was incomplete | Accepted in principle, but corrected against `model.rs`; the review misclassified `Sim.shiftTemplate`, `Sim.workplace`, and route-plan `lineId`, all of which skip `None`. |
| Tauri save cloned the complete `GameEngine` | Accepted. Capture only `GameSnapshot` under the mutex, then prepare and validate outside it. |
| Restore result must remain a raw wire snapshot | Accepted and made explicit. Backend adapters never call `normalizeRustSnapshot`. |
| `PreparedEngineRestore` should be must-use | Accepted. Dropping it is documented as a no-op. |
| WASM validation has an unused receiver | Accepted as a documentation note; do not introduce a fake engine read. |
| Bridge-error serialization can itself fail | Accepted. Fall back to an opaque host rejection mapped to `invokeFailed`. |
| Add a vocabulary-change checklist | Accepted. |
| Simplify the unsupported-schema fixture | Rejected. A v3-shaped fixture missing a v4 field intentionally proves probe-before-full-decode ordering. |
| Specify benchmark warm-up/sample count | Accepted. |
| Move the large TypeScript union out of the design | No change. The exact closed wire contract remains useful in this docs-only PR. |

## 1. Public Validation-Success Contract

The raw Rust methods continue returning unit on successful validation:

```rust
// WASM
pub fn validate_snapshot(&self, snapshot: JsValue) -> Result<(), JsValue>;

// Tauri
#[tauri::command]
fn game_validate_snapshot(
    snapshot: serde_json::Value,
) -> Result<(), PersistenceBridgeError>;
```

Their JavaScript success representations differ:

- wasm-bindgen returns `undefined` for Rust unit;
- Tauri JSON returns `null` for Rust unit.

`runPersistenceValidationOperation` accepts **exactly** those two raw values:

```ts
export async function runPersistenceValidationOperation(
  invoke: () => Promise<unknown> | unknown,
): Promise<PersistenceValidationResult> {
  try {
    const value = await invoke();
    if (value === undefined || value === null) {
      return { ok: true };
    }
    return {
      ok: false,
      error: malformedSuccess("validateSnapshot", value),
    };
  } catch (error: unknown) {
    return normalizePersistenceFailure("validateSnapshot", error);
  }
}
```

A resolved `true`, `false`, number, string, array, plain object, or snapshot-shaped
object is `host/malformedSuccess`. Validation success never depends on truthiness.

Required tests:

- synchronous WASM-style `undefined` resolves to `{ ok: true }`;
- asynchronous Tauri-style `null` resolves to `{ ok: true }`;
- every other resolved shape maps to `host/malformedSuccess`; and
- known bridge errors and unknown invocation failures retain the existing failure
  mapping.

## 2. Core Save-Snapshot Preparation

Tauri must release the mutex before whole-snapshot validation without cloning the
cached `RoadTopology`. Core therefore adds one narrow helper over an owned snapshot
captured from the active engine:

```rust
pub fn prepare_snapshot_for_save(
    mut committed_snapshot: GameSnapshot,
) -> PersistenceResult<GameSnapshot> {
    committed_snapshot.paused = true;
    validate_snapshot(&committed_snapshot)?;
    Ok(committed_snapshot)
}
```

`GameEngine::snapshot_for_save` delegates to that helper:

```rust
pub fn snapshot_for_save(&self) -> PersistenceResult<GameSnapshot> {
    prepare_snapshot_for_save(self.snapshot())
}
```

The helper is for a trusted committed snapshot captured from a live engine. Import
and restore code must not use it to make an untrusted unpaused candidate loadable.
Candidate validation and restoration still require the candidate itself to be
paused.

### Tauri save order

`game_snapshot_for_save` uses this exact sequence:

1. acquire the engine mutex;
2. call `engine.snapshot()` and retain only the returned `GameSnapshot`;
3. release the mutex;
4. call `caelum_core::prepare_snapshot_for_save(captured_snapshot)`;
5. map failure to `validation/activeEngine`;
6. encode the prepared snapshot to `serde_json::Value`; and
7. return the encoded value.

The save path does **not** clone `GameEngine` or `RoadTopology`. Validation and
response encoding run outside the mutex. Poisoning before capture maps to
`host/stateUnavailable`.

Required core and Tauri tests prove:

- the free helper and `GameEngine::snapshot_for_save` return equal values for the
  same committed snapshot;
- only `paused` changes;
- corrupted active state returns the exact `PersistenceError`;
- Tauri captures only the snapshot under the lock; and
- validation occurs after the lock is released.

## 3. Prepared Restore Token Refinement

The original prepared-restore design remains, with an explicit must-use contract:

```rust
#[must_use = "a prepared restore has no effect until its engine is consumed and assigned by the host"]
pub struct PreparedEngineRestore {
    engine: GameEngine,
}

impl PreparedEngineRestore {
    pub fn snapshot(&self) -> &GameSnapshot;
    pub fn into_engine(self) -> GameEngine;
}
```

Dropping `PreparedEngineRestore` without consuming it is a no-op on host state. The
host still owns the final assignment after successful response encoding.

`GameEngine::from_snapshot` and `GameEngine::restore_snapshot` continue delegating to
this token. This keeps the existing atomic in-place API live while sharing candidate
construction, topology compilation, and accepted-snapshot identity across both
hosts.

## 4. WASM Validation Receiver

`WasmGameEngine::validate_snapshot(&self, ...)` remains an instance method for
`GameBackend` capability symmetry, but it must not read `self.inner`.

Do not add a dummy state read solely to silence a lint. The current lint set does not
require one; if a future `unused_self` lint is enabled, use a narrowly scoped allow
rather than creating a false state dependency.

## 5. Raw Adapter Success Versus Runtime View State

`runPersistenceSnapshotOperation` performs transport-shape recognition only:

- success must be a non-array object;
- `schemaVersion` must be numeric;
- the same raw object/value is returned as `RustGameSnapshot`;
- no defaults are added;
- no `null`/`undefined` conversion occurs;
- no nested objects are rebuilt; and
- `normalizeRustSnapshot` is never called inside either backend adapter.

This check does not replace Rust gameplay validation. It also must not hide the raw
wire distinction that HPA-342 is required to normalize at publication time.

Required tests spy on or otherwise isolate the view normalizer and prove that:

- successful `snapshotForSave` and `restoreSnapshot` return the raw JSON-compatible
  host value;
- adapters never invoke `normalizeRustSnapshot`; and
- HPA-342 remains responsible for
  `normalizeRustSnapshot(result.snapshot)` before runtime publication.

## 6. Exhaustive Schema-v4 Optional-Field Inventory

The inventory is derived from the Serde attributes in
`crates/caelum-core/src/model.rs`, not from TypeScript intuition.

### 6.1 Non-skipped `Option` fields

These fields create the ordinary-WASM `undefined` versus persistence/Tauri `null`
difference when Rust stores `None`:

- `scenario.objectives`;
- route and metro leg `currentPath`;
- route and metro leg `lastValidPath`;
- route and metro leg `estimatedSeconds`;
- vehicle `parkedPosition`;
- active-trip `routePlan`;
- route-plan leg `serviceDirection`;
- route-plan leg `boardItineraryIndex`;
- route-plan leg `alightItineraryIndex`; and
- `metrics.lossReason`.

This is the complete non-skipped schema-v4 inventory.

### 6.2 `Option` fields that skip `None`

These fields are omitted by both hosts and therefore do not create the claimed
cross-host mismatch:

- road-port `direction`;
- tile `area`, `oneWay`, and `roadStructureId`;
- building `transitNodeId`;
- route and metro leg `failureReason`;
- stop `roadAccess`;
- stop-road-access `preferredHeading`;
- sim `shiftTemplate` and `workplace`; and
- route-plan leg `lineId`.

The second-review table incorrectly described `shiftTemplate`, `workplace`, and
`lineId` as non-skipped. Their Rust fields explicitly use
`skip_serializing_if = "Option::is_none"`.

### 6.3 Runtime-view normalization rules

Raw backend wire types must allow `undefined` according to the Rust Serde contract.
The view normalizer then applies these rules:

- every non-skipped field in §6.1 normalizes `undefined` or `null` to the explicit
  nullable `GameState` form;
- route-leg `failureReason` continues normalizing omission to explicit `null`
  because the normalized route-leg domain type requires it;
- `lineId`, `shiftTemplate`, `workplace`, tile/building/stop optionals, and road-port
  direction remain optional when their domain types are optional; and
- TypeScript never invents a gameplay value for an omitted field.

A parity fixture must exercise every field in §6.1 plus the skipped
`failureReason` domain-normalization case. Ordinary-WASM-shaped and
JSON-compatible-shaped inputs must normalize to deeply equal `GameState`.

## 7. Bridge-Error Encoding Fallback

Structured bridge errors remain the normal path. If encoding a
`PersistenceBridgeError` itself fails:

- the host returns or throws an opaque fallback rejection;
- the TypeScript adapter maps it to `host/invokeFailed`;
- it is never reclassified as a core validation error;
- it is never treated as success; and
- save/restore state remains unchanged.

This is a last-resort host failure, not permission to reintroduce message parsing.

## 8. Persistence-Error Vocabulary Checklist

Every Rust persistence vocabulary change must update all five artifacts in one
reviewed change:

1. the Rust enum or nested reason type;
2. the Rust exhaustive vocabulary list and exact wire tests;
3. `tests/fixtures/persistence/persistence-errors.json`;
4. the TypeScript union and strict structural guard; and
5. the TypeScript catalogue test.

The catalogue remains a manual bidirectional tripwire, not source generation.

## 9. Unsupported-Schema Fixture Decision

Keep `unsupported-schema.json` deliberately legacy-shaped:

- `schemaVersion` is an older supported integer, currently `3`; and
- at least one required schema-v4-only field is absent.

The missing v4 field is intentional. It proves the two-phase decoder probes and
rejects the schema before attempting full `GameSnapshot` deserialization. A broken
implementation that full-decodes first would return `snapshotDecode`, causing the
fixture test to fail.

`malformed-current-schema.json` remains the separate fixture for a current schema
whose body cannot deserialize.

## 10. Benchmark Methodology

The ignored/manual benchmark harness records both validation and prepared restore for
native and real-WASM paths on the same machine.

For each path and operation:

1. record one cold invocation separately;
2. run exactly two unmeasured warm-up iterations;
3. run at least 20 measured iterations;
4. report median and p95; and
5. apply the existing review budget to the measured median:

```text
real-WASM median <= max(100 ms, 10 × same-machine native median)
```

The budget remains review evidence, not a shared-CI wall-clock assertion. Exceeding
it requires reporting the evidence and opening a host-execution follow-up; it does
not permit weakened validation or an unreviewed worker expansion.

## 11. Required Test Additions

The implementation plan must include these concrete tests in addition to the
original design:

### Core

- save helper changes only `paused` and delegates consistently from the engine;
- prepared restore is `must_use`, dropping it does not mutate existing state;
- vocabulary checklist coverage remains exhaustive.

### WASM

- validation success resolves as `undefined`;
- the unused receiver is not read;
- bridge-error encoding fallback maps to an opaque host failure;
- raw persistence snapshot success is not view-normalized.

### Tauri

- validation success serializes as `null`;
- save captures only `GameSnapshot` under the mutex;
- no complete-engine/topology clone occurs for save;
- bridge-error encoding fallback preserves managed state;
- raw persistence snapshot success is not view-normalized.

### TypeScript

- validation accepts `undefined` and `null` only;
- all other resolved validation values are `malformedSuccess`;
- adapters return raw snapshot values without invoking the view normalizer;
- the complete §6.1 inventory normalizes identically across raw host shapes; and
- skipped optionals follow the explicit-null versus optional rules in §6.3.

## 12. File-Map Amendments

Add or refine these entries in the implementation file map:

- `crates/caelum-core/src/persistence/mod.rs` —
  `prepare_snapshot_for_save(GameSnapshot)`;
- `crates/caelum-core/src/engine.rs` — engine delegation and must-use
  `PreparedEngineRestore`;
- `crates/caelum-core/src/lib.rs` — deliberate exports for the save helper and
  prepared restore token;
- `src-tauri/src/lib.rs` — snapshot-only save capture;
- `src/runtime/backend/persistence.ts` — nullish unit-success handling and raw
  snapshot transport checks;
- `src/runtime/backend/types.ts` — accurate raw optional/undefined field types;
- `src/runtime/snapshotView.ts` — exhaustive model-derived view normalization; and
- corresponding core, host, adapter, fixture, and parity tests.

## 13. Gate and Acceptance Amendments

Before Gate 1 closes, the contract tests must pin nullish validation success.

Before the core gate closes, both `prepare_snapshot_for_save` and the must-use restore
token must be tested.

Before the Tauri gate closes, save must prove snapshot-only capture and outside-lock
validation.

Before the adapter/view gate closes:

- adapters must return raw persistence values;
- the full model-derived non-skipped inventory must normalize consistently; and
- HPA-342's publication boundary must remain explicit.

The acceptance criterion remains:

> Successful restoration returns the validated canonical raw snapshot.

HPA-341 returns it; HPA-342 normalizes and publishes it.

# HPA-341 Persistence Host Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Implementation status:** Completed on the HPA-341 implementation branch,
including the consolidated final-review fix wave.

**Goal:** Expose persistence-safe save, pure validation, and atomic restoration through equivalent WASM and Tauri backends, with one closed TypeScript result/error contract, JSON-compatible persistence snapshots, exact raw-wire typing, and no TypeScript state-installation bypass.

**Architecture:** `caelum-core` adds two opaque, engine-minted preparation tokens: `SaveSnapshotCapture` for moving a committed snapshot outside the Tauri mutex before validation, and `PreparedEngineRestore` for retaining one validated candidate engine plus its exact accepted snapshot until host encoding succeeds. The WASM and Tauri bridges share the same logical two-phase decoder and tagged bridge-error shape, but each performs its own serializer-specific encode-before-commit transaction. TypeScript owns only strict recognition of Rust errors, host-result normalization, raw Rust wire mirrors, and read-only runtime-view normalization; HPA-342 remains responsible for storage, runtime publication, and UI reset.

**Tech Stack:** Rust 2021 (`rust-version = 1.77.2`), Serde/serde_json, wasm-bindgen, serde-wasm-bindgen 0.6, Tauri 2.11, TypeScript 5.8, Bun, Vitest 3.2.

**Companion design:** `docs/superpowers/specs/2026-07-30-persistence-host-parity-design.md` is the single normative contract. If implementation evidence requires changing an operation name, error variant, preparation boundary, serializer rule, optional-field inventory, or HPA-342 ownership boundary, amend and re-review the design before changing code.

## Global Constraints

- Rust remains the only authority that accepts gameplay state. TypeScript may transport and normalize snapshots for read-only view consumption, but it may not repair, validate semantically, or install imported gameplay state.
- Imported values enter `validateSnapshot` and `restoreSnapshot` as `unknown`.
- The public operations are exactly `snapshotForSave`, `validateSnapshot`, and `restoreSnapshot`.
- Every expected operation failure resolves as `{ ok: false, error }`; consumers do not classify rejected promises or parse diagnostics.
- Every `PersistenceOperationError` carries `operation`.
- Core validation failures preserve the exact serialized `PersistenceError` and distinguish `source: "activeEngine"` from `source: "candidate"`.
- Successful validation accepts only WASM `undefined` or Tauri `null`; every other resolved value is `host/malformedSuccess`.
- Snapshot success requires a plain non-array object with an own `schemaVersion` equal to `SNAPSHOT_SCHEMA_VERSION`.
- `SaveSnapshotCapture` has a private snapshot field and no public constructor from `GameSnapshot`.
- `PreparedEngineRestore` is must-use, retains the compiled topology, and has no effect until consumed and assigned by a host.
- Both hosts encode the exact prepared snapshot before committing a restore candidate.
- Tauri save captures only `SaveSnapshotCapture` under the mutex; it does not clone `GameEngine` or `RoadTopology`.
- Persistence-only WASM serialization uses `Serializer::json_compatible()` with large integer BigInt serialization disabled.
- Ordinary gameplay `snapshot`/`dispatch`/`tick` serialization does not change.
- Backend persistence success remains a raw `RustGameSnapshot`; adapters never call `normalizeRustSnapshot`.
- `normalizeRustSnapshot` must recursively normalize the complete schema-v4 non-skipped `Option` inventory before runtime publication.
- `loadSnapshot`, `game_load_snapshot`, and wasm-bindgen-exported `WasmGameEngine::from_snapshot` are removed.
- Keep core `GameEngine::from_snapshot` and `GameEngine::restore_snapshot`; both delegate through `PreparedEngineRestore`.
- Keep the deliberately legacy-shaped unsupported-schema fixture so probe-before-full-decode ordering is tested.
- The error catalogue is a manual cross-language tripwire, not generated code.
- Do not add storage, `SaveEnvelope`, active-city state, dirty tracking, autosave scheduling, import/export UI, migration, repair, or a worker boundary.
- Performance measurements are review evidence, not shared-CI wall-clock assertions.
- Run repository shell commands through `rtk`, matching the existing implementation-plan convention.

---

## Hard Baseline Gate — Run Before Task 1

- [ ] **Verify the implementation branch contains HPA-340 and the consolidated HPA-341 design**

```sh
rtk git fetch origin
rtk git status --short --branch
rtk ls docs/superpowers/specs/2026-07-30-persistence-host-parity-design.md
rtk rg -n 'pub fn snapshot_for_save|pub fn from_snapshot|pub fn restore_snapshot|pub fn validate_snapshot|pub fn check_schema_version|pub fn check_snapshot_schema' crates/caelum-core/src
rtk rg -n 'SNAPSHOT_SCHEMA_VERSION: u16 = 4|schemaVersion.*SNAPSHOT_SCHEMA_VERSION' crates/caelum-core/src/model.rs src/runtime/backend/types.ts src/domain/types.ts
```

Expected: schema v4 and all HPA-340 core APIs exist; the consolidated HPA-341 design exists. If any core API is absent, stop rather than recreating HPA-340 compatibility behavior.

- [ ] **Record the existing compatibility surface before editing**

```sh
rtk rg -n 'loadSnapshot|game_load_snapshot|WasmGameEngine\.from_snapshot|pub fn from_snapshot' \
  src crates/caelum-wasm src-tauri tests
rtk rg -n 'normalize_snapshot_stops' crates/caelum-core/src
```

Expected: `loadSnapshot` appears only in backend code/tests and old documentation; the wasm-bindgen export appears in `crates/caelum-wasm/src/lib.rs`; core `GameEngine::from_snapshot` remains legitimate; `normalize_snapshot_stops` is reached from live network mutation, not strict persistence restore.

- [ ] **Run the pre-change persistence and host baseline**

```sh
rtk cargo test -p caelum-core --test persistence_snapshot
rtk cargo test -p caelum-core --test persistence_atomicity
rtk cargo test -p caelum-core --test persistence_determinism
rtk cargo test -p caelum-core --test persistence_error_wire
rtk cargo test -p caelum --lib
rtk bunx vitest run tests/runtime/backendContract.test.ts \
  tests/runtime/wasmBackend.test.ts \
  tests/runtime/tauriBackend.test.ts \
  tests/runtime/wasmArtifact.smoke.test.ts
```

Expected: all listed targets pass before HPA-341 edits. Record unrelated baseline failures rather than weakening HPA-341 assertions.

---

## File Map

### Create

- `src/runtime/backend/persistenceContract.ts`
- `src/runtime/backend/persistence.ts`
- `tests/runtime/persistenceContract.test.ts`
- `tests/runtime/snapshotView.test.ts`
- `tests/fixtures/persistence/README.md`
- `tests/fixtures/persistence/valid-paused.json`
- `tests/fixtures/persistence/unsupported-schema.json`
- `tests/fixtures/persistence/unpaused.json`
- `tests/fixtures/persistence/malformed-current-schema.json`
- `tests/fixtures/persistence/late-derived-corruption.json`
- `tests/fixtures/persistence/persistence-errors.json`
- `crates/caelum-core/tests/persistence_fixture_export.rs`
- `scripts/benchmark-persistence-wasm.ts`

### Modify

- `crates/caelum-core/src/engine.rs`
- `crates/caelum-core/src/lib.rs`
- `crates/caelum-core/tests/persistence_snapshot.rs`
- `crates/caelum-core/tests/persistence_atomicity.rs`
- `crates/caelum-core/tests/persistence_determinism.rs`
- `crates/caelum-core/tests/persistence_error_wire.rs`
- `crates/caelum-core/tests/common/persistence_fixtures.rs`
- `crates/caelum-wasm/Cargo.toml`
- `crates/caelum-wasm/src/lib.rs`
- `src-tauri/src/lib.rs`
- `src/runtime/backend/types.ts`
- `src/runtime/backend/shared.ts`
- `src/runtime/backend/wasmBackend.ts`
- `src/runtime/backend/tauriBackend.ts`
- `src/runtime/backend/index.ts`
- `src/runtime/snapshotView.ts`
- `tests/fixtures/rustSnapshot.ts`
- `tests/runtime/backendContract.test.ts`
- `tests/runtime/wasmBackend.test.ts`
- `tests/runtime/tauriBackend.test.ts`
- `tests/runtime/wasmArtifact.smoke.test.ts`
- `tests/runtime/previewCoordinator.test.ts`
- `package.json`
- `docs/architecture.md`

### Delete or retire

- optional `GameBackend.loadSnapshot`
- wasm-bindgen-exported `WasmGameEngine::from_snapshot`
- Tauri `game_load_snapshot`
- stale adapter comments claiming the compatibility loader covers `normalize_snapshot_stops`
- tests for the rejected-promise load contract

---

### Task 1: Static TypeScript Persistence Contract

**Files:**

- Create: `src/runtime/backend/persistenceContract.ts`
- Create: `tests/runtime/persistenceContract.test.ts`
- Reference: `docs/superpowers/specs/2026-07-30-persistence-host-parity-design.md` Sections 2–3

**Interfaces:**

- Consumes: domain `Point` and `Heading`.
- Produces:

```ts
export interface PersistenceSnapshotRequest {
  snapshot: unknown;
}

export type PersistenceOperation =
  | "snapshotForSave"
  | "validateSnapshot"
  | "restoreSnapshot";

export type PersistenceValidationSource = "activeEngine" | "candidate";

export type PersistenceSerializationPhase =
  | "snapshotDecode"
  | "snapshotEncode";

export type PersistenceHostErrorCode =
  | "stateUnavailable"
  | "invokeFailed"
  | "malformedSuccess"
  | "malformedError";

export type PersistenceOperationError =
  | {
      kind: "validation";
      operation: PersistenceOperation;
      source: PersistenceValidationSource;
      error: PersistenceValidationError;
    }
  | {
      kind: "serialization";
      operation: PersistenceOperation;
      phase: PersistenceSerializationPhase;
      diagnostic: string;
    }
  | {
      kind: "host";
      operation: PersistenceOperation;
      code: PersistenceHostErrorCode;
      diagnostic: string;
    };

export type PersistenceSnapshotResultOf<TSnapshot> =
  | { ok: true; snapshot: TSnapshot }
  | { ok: false; error: PersistenceOperationError };

export type PersistenceValidationResult =
  | { ok: true }
  | { ok: false; error: PersistenceOperationError };
```

- Also produces the exact closed definitions from design Sections 3.1–3.3:
  - `PersistenceEntityKind`
  - `PersistenceEntityRef`
  - `PersistenceMapSize`
  - all 83 `PersistenceSnapshotField` strings
  - `PersistenceNumericError`
  - `PersistenceModeError`
  - `PersistenceScenarioError`
  - `PersistenceTileError`
  - `PersistenceRoadStructureError`
  - `PersistenceEntityError`
  - `PersistenceOwnershipError`
  - `PersistenceAssignmentError`
  - `PersistenceDerivedStateError`
  - `PersistenceRoadTopologyError`
  - `PersistenceValidationError`

- [ ] **Step 1: Add failing compile-time contract tests**

Add to `tests/runtime/persistenceContract.test.ts`:

```ts
import { describe, expectTypeOf, it } from "vitest";
import type {
  PersistenceOperationError,
  PersistenceSnapshotRequest,
  PersistenceSnapshotResultOf,
  PersistenceValidationError,
  PersistenceValidationResult,
} from "../../src/runtime/backend/persistenceContract";

describe("persistence contract types", () => {
  it("keeps imported snapshots unknown", () => {
    expectTypeOf<PersistenceSnapshotRequest["snapshot"]>().toEqualTypeOf<unknown>();
  });

  it("requires operation attribution on every error family", () => {
    expectTypeOf<PersistenceOperationError["operation"]>().toEqualTypeOf<
      "snapshotForSave" | "validateSnapshot" | "restoreSnapshot"
    >();
  });

  it("uses explicit snapshot and validation result unions", () => {
    expectTypeOf<PersistenceSnapshotResultOf<{ schemaVersion: 4 }>>().toEqualTypeOf<
      | { ok: true; snapshot: { schemaVersion: 4 } }
      | { ok: false; error: PersistenceOperationError }
    >();
    expectTypeOf<PersistenceValidationResult>().toEqualTypeOf<
      | { ok: true }
      | { ok: false; error: PersistenceOperationError }
    >();
    expectTypeOf<PersistenceValidationError>().toMatchTypeOf<{
      code: string;
      context: object;
    }>();
  });
});
```

- [ ] **Step 2: Run the focused test and confirm the module is missing**

```sh
rtk bunx vitest run tests/runtime/persistenceContract.test.ts
```

Expected: FAIL because `persistenceContract.ts` does not exist.

- [ ] **Step 3: Add the host-neutral contract file**

Create `src/runtime/backend/persistenceContract.ts`. Import only:

```ts
import type { Heading, Point } from "../../domain/types";
```

Add the exact operation/result definitions above and copy the complete closed validation vocabulary verbatim from the companion design. Do not import `RustGameSnapshot`; the generic result type prevents a type cycle.

- [ ] **Step 4: Run type and focused tests**

```sh
rtk bun run check
rtk bunx vitest run tests/runtime/persistenceContract.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the static contract**

```sh
rtk git add src/runtime/backend/persistenceContract.ts \
  tests/runtime/persistenceContract.test.ts
rtk git commit -m "feat: define persistence backend contract"
```

---

### Task 2: Strict Error Guards, Catalogue, and Result Normalization

**Files:**

- Create: `src/runtime/backend/persistence.ts`
- Create: `tests/fixtures/persistence/persistence-errors.json`
- Modify: `tests/runtime/persistenceContract.test.ts`
- Modify: `crates/caelum-core/tests/persistence_error_wire.rs`

**Interfaces:**

- Consumes: Task 1 types and `SNAPSHOT_SCHEMA_VERSION`.
- Produces:

```ts
export function isPersistenceValidationError(
  value: unknown,
): value is PersistenceValidationError;

export function isPersistenceOperationError(
  value: unknown,
): value is PersistenceOperationError;

export function runPersistenceSnapshotOperation(
  operation: "snapshotForSave" | "restoreSnapshot",
  invoke: () => Promise<unknown> | unknown,
): Promise<PersistenceSnapshotResult>;

export function runPersistenceValidationOperation(
  successMarker: null | undefined,
  invoke: () => Promise<unknown> | unknown,
): Promise<PersistenceValidationResult>;
```

- Catalogue root:

```ts
interface PersistenceErrorCatalogue {
  topLevelCodes: string[];
  snapshotFields: string[];
  entityKinds: string[];
  headings: string[];
  reasonKinds: {
    numeric: string[];
    mode: string[];
    scenario: string[];
    tile: string[];
    roadStructure: string[];
    entity: string[];
    ownership: string[];
    assignment: string[];
    derivedState: string[];
    roadTopology: string[];
  };
  embeddedShapes: {
    point: { x: number; y: number };
    heading: string;
    entityRef: { kind: string; id: string };
    mapSize: { width: number; height: number };
  };
  errors: unknown[];
  reasons: Record<string, unknown[]>;
}
```

- [ ] **Step 1: Add failing guard and normalization tests**

Extend `tests/runtime/persistenceContract.test.ts` with:

```ts
import catalogue from "../fixtures/persistence/persistence-errors.json";
import {
  isPersistenceOperationError,
  isPersistenceValidationError,
  runPersistenceSnapshotOperation,
  runPersistenceValidationOperation,
} from "../../src/runtime/backend/persistence";
import { SNAPSHOT_SCHEMA_VERSION } from "../../src/domain/types";

it("accepts every catalogued Rust persistence error", () => {
  for (const error of catalogue.errors) {
    expect(isPersistenceValidationError(error)).toBe(true);
  }
});

it("accepts every catalogued reason through its owning error envelope", () => {
  // Table-drive each `catalogue.reasons` family through the corresponding
  // top-level validation-error context.
});

it("accepts only the selected host validation success marker", async () => {
  await expect(
    runPersistenceValidationOperation(undefined, () => undefined),
  ).resolves.toEqual({ ok: true });
  await expect(
    runPersistenceValidationOperation(null, async () => null),
  ).resolves.toEqual({ ok: true });

  for (const value of [null, true, false, 0, "ok", [], {}, { schemaVersion: 4 }]) {
    const result = await runPersistenceValidationOperation(
      undefined,
      () => value,
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "host",
        operation: "validateSnapshot",
        code: "malformedSuccess",
      },
    });
  }
});

it("requires the exact current schema on snapshot success", async () => {
  await expect(
    runPersistenceSnapshotOperation("snapshotForSave", () => ({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    })),
  ).resolves.toEqual({
    ok: true,
    snapshot: { schemaVersion: SNAPSHOT_SCHEMA_VERSION },
  });

  const wrong = await runPersistenceSnapshotOperation("restoreSnapshot", () => ({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION - 1,
  }));
  expect(wrong).toMatchObject({
    ok: false,
    error: {
      kind: "host",
      operation: "restoreSnapshot",
      code: "malformedSuccess",
    },
  });
});

it("rejects unknown closed vocabulary and malformed embedded shapes", () => {
  const base = {
    kind: "validation",
    operation: "restoreSnapshot",
    source: "candidate",
    error: {
      code: "invalidTile",
      context: {
        tileId: "tile-0-0",
        reason: {
          kind: "connectionToNonRoad",
          details: { neighbor: { x: 1, y: 0 } },
        },
      },
    },
  };
  expect(isPersistenceOperationError(base)).toBe(true);
  expect(
    isPersistenceOperationError({
      ...base,
      error: {
        ...base.error,
        context: {
          ...base.error.context,
          reason: {
            kind: "connectionToNonRoad",
            details: { neighbor: { x: 1, y: 0, z: 2 } },
          },
        },
      },
    }),
  ).toBe(false);
});
```

Add table cases for unknown top-level `code`, unknown `field`, unknown entity kind, unknown heading, missing `details`, inappropriate `details`, `entity: null`, extra keys, malformed `EntityRef`, and malformed `MapSize`.
Export narrow readonly vocabulary arrays used by the production guards. Compare
`topLevelCodes`, `snapshotFields`, `entityKinds`, `headings`, and every `reasonKinds`
family to those arrays, and use compile-time assertions to prove each array's element
union exactly matches its TypeScript closed union. This makes vocabulary drift fail in
either direction.

- [ ] **Step 2: Run the focused test and confirm missing helpers/catalogue**

```sh
rtk bunx vitest run tests/runtime/persistenceContract.test.ts
```

Expected: FAIL because `persistence.ts` and the catalogue do not exist.

- [ ] **Step 3: Create the exhaustive catalogue**

Create `tests/fixtures/persistence/persistence-errors.json` with:

- exactly 14 top-level codes;
- all 83 snapshot field strings;
- all 9 entity kinds;
- all 4 headings;
- every reason kind grouped by the ten reason families;
- round-trippable samples for `Point`, `Heading`, `EntityRef`, and `MapSize`;
- at least one complete payload per top-level code;
- both omitted-entity and present-entity `invalidNumericValue` payloads;
- one sample for every structured `details` shape.

Use no free-form catch-all payload.

- [ ] **Step 4: Implement exact structural helpers**

Create `src/runtime/backend/persistence.ts` with private helpers:

```ts
type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasExactKeys(
  value: PlainObject,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  try {
    const allowed = new Set([...required, ...optional]);
    return required.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key)
    ) && Reflect.ownKeys(value).every(
      (key) => typeof key === "string" && allowed.has(key)
    );
  } catch {
    return false;
  }
}

function isPoint(value: unknown): value is Point {
  return isPlainObject(value) &&
    hasExactKeys(value, ["x", "y"]) &&
    typeof value.x === "number" &&
    typeof value.y === "number";
}

function isHeading(value: unknown): value is Heading {
  return value === "north" ||
    value === "east" ||
    value === "south" ||
    value === "west";
}
```

Add equivalent exact helpers for `PersistenceEntityRef`, `PersistenceMapSize`, finite guaranteed numbers, arrays of points, and tagged reason objects.
Wrap the public guards and snapshot-success recognition so hostile proxy traps or
getters return `false`; normalization must always resolve a typed host fallback rather
than throwing from the unknown boundary.

- [ ] **Step 5: Implement exhaustive reason and top-level guards**

Implement one exhaustive `switch` per reason family and one exhaustive `switch` on `PersistenceValidationError.code`. Each branch must:

- require exact keys;
- distinguish unit reasons from structured reasons;
- recurse into embedded shapes;
- reject `entity: null`;
- reject unknown keys;
- return `false` for every unknown variant.

Do not classify imported snapshots with these helpers; they only recognize bridge output.

- [ ] **Step 6: Implement operation-error and result normalization**

Use these rules:

```ts
function normalizePersistenceFailure(
  operation: PersistenceOperation,
  value: unknown,
): { ok: false; error: PersistenceOperationError } {
  if (
    isPersistenceOperationError(value) &&
    value.operation === operation
  ) {
    return { ok: false, error: value };
  }

  if (isPlainObject(value)) {
    return {
      ok: false,
      error: malformedError(operation, value),
    };
  }

  return {
    ok: false,
    error: invokeFailed(operation, value),
  };
}
```

`runPersistenceSnapshotOperation` accepts only a plain object with an own exact current
schema version. `runPersistenceValidationOperation` accepts only the marker selected by
the adapter: `undefined` for WASM and `null` for Tauri. Diagnostics use safe
stringification and are never parsed.

- [ ] **Step 7: Extend Rust catalogue round-trip tests**

In `crates/caelum-core/tests/persistence_error_wire.rs`, add:

```rust
use std::fs;
use std::path::Path;

use caelum_core::model::{Heading, Point};
use caelum_core::{
    AssignmentError, DerivedStateError, EntityError, EntityKind, EntityRef, MapSize,
    ModeError, NumericError, OwnershipError, PersistenceError, RoadStructureError,
    RoadTopologyError, ScenarioError, SnapshotField, TileError,
};

const PERSISTENCE_FIXTURES_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/fixtures/persistence",
);
```

Load `persistence-errors.json`; deserialize and reserialize every `errors` entry into `PersistenceError`; deserialize every reason-family entry into its exact Rust enum; deserialize all snapshot fields, entity kinds, headings, and embedded shapes; compare the resulting ordered string sets with explicit exhaustive Rust lists.

- [ ] **Step 8: Run cross-language contract tests**

```sh
rtk cargo test -p caelum-core --test persistence_error_wire
rtk bunx vitest run tests/runtime/persistenceContract.test.ts
rtk bun run check
```

Expected: PASS.

- [ ] **Step 9: Commit the guarded contract**

```sh
rtk git add src/runtime/backend/persistence.ts \
  tests/runtime/persistenceContract.test.ts \
  tests/fixtures/persistence/persistence-errors.json \
  crates/caelum-core/tests/persistence_error_wire.rs
rtk git commit -m "feat: guard persistence operation results"
```

---

### Task 3: Accurate Raw Snapshot Types and Runtime-View Normalization

**Files:**

- Modify: `src/runtime/backend/types.ts`
- Modify: `src/runtime/backend/shared.ts`
- Modify: `src/runtime/snapshotView.ts`
- Create: `tests/runtime/snapshotView.test.ts`
- Modify: `tests/fixtures/rustSnapshot.ts`

**Interfaces:**

- Consumes: domain normalized types and schema-v4 Serde optional-field inventory.
- Produces raw mirrors:
  - `RustRouteLegPath`
  - `RustRoute`
  - `RustMetroLine`
  - `RustVehicle`
  - `RustTransitNetwork`
  - `RustRoutePlanLeg`
  - `RustRoutePlan`
  - `RustActiveTrip`
  - complete `RustMetrics`
  - `RustScenarioConfig`
  - complete `RustGameSnapshot`

- [ ] **Step 1: Add failing type and normalization tests**

Create `tests/runtime/snapshotView.test.ts` with a helper that builds two logically equal raw snapshots:

- ordinary WASM form uses `undefined` for every non-skipped `None`;
- JSON-compatible form uses `null`;
- both omit skipped `failureReason`, `lineId`, `shiftTemplate`, and `workplace`.

Assert:

```ts
const ordinary = createNullishWireSnapshot("undefined");
const jsonCompatible = createNullishWireSnapshot("null");

expect(normalizeRustSnapshot(ordinary)).toEqual(
  normalizeRustSnapshot(jsonCompatible),
);
```

Also assert:

```ts
const normalized = normalizeRustSnapshot(ordinary);
expect(normalized.scenario.objectives).toBeNull();
expect(normalized.metrics.lossReason).toBeNull();
expect(normalized.transit.routes[0].legs[0].failureReason).toBeNull();
expect(normalized.activeTrips[0].routePlan?.legs[0]).toMatchObject({
  serviceDirection: null,
  boardItineraryIndex: null,
  alightItineraryIndex: null,
});
expect("lineId" in normalized.activeTrips[0].routePlan!.legs[0]).toBe(false);
expect("shiftTemplate" in normalized.sims[0]).toBe(false);
expect("workplace" in normalized.sims[0]).toBe(false);
```

- [ ] **Step 2: Run the focused test and confirm raw types/normalization are incomplete**

```sh
rtk bunx vitest run tests/runtime/snapshotView.test.ts
rtk bun run check
```

Expected: FAIL because nested raw types and normalization are incomplete.

- [ ] **Step 3: Replace normalized-type reuse with explicit raw mirrors**

In `src/runtime/backend/types.ts`:

- import `ActiveTrip`, `LegFailureReason`, `MetroLine`, `Route`, `RouteLeg`, `RoutePlan`, `ServiceDirection`, `TransitPath`, `TripPosition`, and `Vehicle`;
- define the raw mirrors from design Section 9.1;
- keep skipped fields optional;
- widen only non-skipped `Option` fields to `null | undefined`;
- update `RustGameSnapshot.transit`, `.activeTrips`, `.metrics`, and `.scenario` to use raw types;
- correct the stale schema-v3 comment to schema v4.

Do not use comments such as “existing fields unchanged” in production definitions; spell out every property.

- [ ] **Step 4: Make route-leg normalization consume the raw type**

Change `normalizeRouteLegPath` to:

```ts
export function normalizeRouteLegPath(
  leg: RustRouteLegPath,
): RouteLegPath {
  return {
    ...leg,
    currentPath: leg.currentPath ?? null,
    lastValidPath: leg.lastValidPath ?? null,
    estimatedSeconds: leg.estimatedSeconds ?? null,
    failureReason: leg.failureReason ?? null,
  };
}
```

- [ ] **Step 5: Add recursive active-trip and metrics normalization**

In `src/runtime/snapshotView.ts`, add:

```ts
function normalizeRoutePlan(
  plan: RustRoutePlan | null | undefined,
): RoutePlan | null {
  if (plan == null) return null;
  return {
    ...plan,
    legs: plan.legs.map((leg) => ({
      ...leg,
      serviceDirection: leg.serviceDirection ?? null,
      boardItineraryIndex: leg.boardItineraryIndex ?? null,
      alightItineraryIndex: leg.alightItineraryIndex ?? null,
    })),
  };
}
```

Map:

- route and metro legs through `normalizeRouteLegPath`;
- vehicle `parkedPosition ?? null`;
- every active trip through `normalizeRoutePlan`;
- `metrics.lossReason ?? null`;
- `scenario.objectives ?? null`.

Leave skipped optionals optional.

- [ ] **Step 6: Update fixture builders to the raw graph**

Update `createRustSnapshot` and related helpers so they satisfy the complete raw types without unsafe normalization casts. Keep the default JSON-compatible fixture values as `null`.

- [ ] **Step 7: Run raw-wire and existing backend tests**

```sh
rtk bun run check
rtk bunx vitest run tests/runtime/snapshotView.test.ts \
  tests/runtime/backendContract.test.ts \
  tests/runtime/wasmBackend.test.ts \
  tests/runtime/tauriBackend.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit raw-wire parity**

```sh
rtk git add src/runtime/backend/types.ts \
  src/runtime/backend/shared.ts \
  src/runtime/snapshotView.ts \
  tests/runtime/snapshotView.test.ts \
  tests/fixtures/rustSnapshot.ts
rtk git commit -m "feat: model raw Rust snapshot wire shapes"
```

---

### Task 4: Core Save Capture and Prepared Restore Tokens

**Files:**

- Modify: `crates/caelum-core/src/engine.rs`
- Modify: `crates/caelum-core/src/lib.rs`
- Modify: `crates/caelum-core/tests/persistence_atomicity.rs`
- Modify: `crates/caelum-core/tests/persistence_snapshot.rs`

**Interfaces:**

- Produces:

```rust
#[must_use = "a captured committed snapshot must be prepared or deliberately discarded"]
pub struct SaveSnapshotCapture {
    snapshot: GameSnapshot,
}

impl SaveSnapshotCapture {
    pub fn prepare(mut self) -> PersistenceResult<GameSnapshot>;
}

#[must_use = "a prepared restore has no effect until its engine is consumed and assigned by the host"]
pub struct PreparedEngineRestore {
    engine: GameEngine,
}

impl PreparedEngineRestore {
    pub fn snapshot(&self) -> &GameSnapshot;
    pub fn into_engine(self) -> GameEngine;
}

impl GameEngine {
    pub fn capture_snapshot_for_save(&self) -> SaveSnapshotCapture;
    pub fn prepare_restore(
        snapshot: GameSnapshot,
    ) -> PersistenceResult<PreparedEngineRestore>;
}
```

- [ ] **Step 1: Add failing capture and prepared-token tests**

In `persistence_atomicity.rs`, add tests:

```rust
#[test]
fn save_capture_prepares_only_an_engine_minted_snapshot() {
    let mut engine = GameEngine::new();
    assert!(engine.dispatch(GameIntent::SetPaused { paused: false }).applied);
    let before = engine.snapshot();

    let saved = engine.capture_snapshot_for_save().prepare().unwrap();

    let mut expected = before.clone();
    expected.paused = true;
    assert_eq!(saved, expected);
    assert_eq!(engine.snapshot(), before);
}

#[test]
fn dropping_a_prepared_restore_does_not_mutate_an_existing_engine() {
    let source = GameEngine::new();
    let candidate = source.snapshot_for_save().unwrap();
    let target = GameEngine::new();
    let before = target.snapshot();

    let prepared = GameEngine::prepare_restore(candidate).unwrap();
    drop(prepared);

    assert_eq!(target.snapshot(), before);
}
```

Add a test asserting `prepared.snapshot()` equals the supplied snapshot and `prepared.into_engine()` retains equal topology.

- [ ] **Step 2: Run the core tests and confirm missing APIs**

```sh
rtk cargo test -p caelum-core --test persistence_atomicity
```

Expected: FAIL because `SaveSnapshotCapture` and `PreparedEngineRestore` do not exist.

- [ ] **Step 3: Implement `SaveSnapshotCapture`**

Place the public token beside `GameEngine` in `engine.rs`. Keep its field private. Implement:

```rust
impl SaveSnapshotCapture {
    pub fn prepare(mut self) -> PersistenceResult<GameSnapshot> {
        self.snapshot.paused = true;
        validate_snapshot(&self.snapshot)?;
        Ok(self.snapshot)
    }
}
```

Change `GameEngine::snapshot_for_save` to delegate through `capture_snapshot_for_save()`.

- [ ] **Step 4: Implement `PreparedEngineRestore`**

Use the existing private `prepare_snapshot` exactly once:

```rust
pub fn prepare_restore(
    snapshot: GameSnapshot,
) -> PersistenceResult<PreparedEngineRestore> {
    let prepared = prepare_snapshot(snapshot)?;
    Ok(PreparedEngineRestore {
        engine: Self {
            snapshot: prepared.snapshot,
            road_topology: prepared.road_topology,
        },
    })
}
```

Make `from_snapshot` and `restore_snapshot` delegate through the token. Clone the accepted snapshot before consuming the token in the in-place method.

- [ ] **Step 5: Export only the deliberate token APIs**

Update `lib.rs`:

```rust
pub use engine::{
    GameEngine, PreparedEngineRestore, RoutingContext, SaveSnapshotCapture,
};
```

Do not export `PreparedSnapshot` or `prepare_snapshot`.

- [ ] **Step 6: Run core snapshot and atomicity suites**

```sh
rtk cargo test -p caelum-core --test persistence_snapshot
rtk cargo test -p caelum-core --test persistence_atomicity
rtk cargo test -p caelum-core --test persistence_determinism
rtk cargo clippy -p caelum-core --all-targets -- -D warnings
```

Expected: PASS.

- [ ] **Step 7: Commit core preparation boundaries**

```sh
rtk git add crates/caelum-core/src/engine.rs \
  crates/caelum-core/src/lib.rs \
  crates/caelum-core/tests/persistence_atomicity.rs \
  crates/caelum-core/tests/persistence_snapshot.rs
rtk git commit -m "feat: add persistence preparation tokens"
```

---

### Task 5: Reachable-State Savability and Native Benchmark Contract

**Files:**

- Modify: `crates/caelum-core/tests/persistence_determinism.rs`

**Interfaces:**

- Consumes: Task 4 core APIs.
- Produces:
  - positive savability invariant after every accepted dispatch/applied tick;
  - native validation and prepared-restore cold/median/p95 evidence with two warmups and 25 samples.

- [ ] **Step 1: Add savability assertions to public-operation helpers**

Refactor the local helpers:

```rust
fn assert_savable(engine: &GameEngine, label: &str) {
    engine
        .snapshot_for_save()
        .unwrap_or_else(|error| panic!("{label} produced unsavable state: {error:?}"));
}

fn apply(engine: &mut GameEngine, intent: GameIntent) {
    let label = format!("dispatch {intent:?}");
    let result = engine.dispatch(intent);
    assert!(
        result.applied,
        "fixture intent was rejected or unchanged: {:?}",
        result.rejection
    );
    assert_savable(engine, &label);
}

fn apply_tick(engine: &mut GameEngine, seconds: f64) {
    let result = engine.tick(seconds);
    assert!(result.applied, "tick {seconds} must apply");
    assert_savable(engine, &format!("tick {seconds}"));
}
```

Use `apply_tick` inside `production_fixture()`. In the paired original/restored continuation loop, preserve the existing result equality comparison and then call:

```rust
assert_savable(&original, "original continuation state");
assert_savable(&restored, "restored continuation state");
```

after each matched operation.

- [ ] **Step 2: Make the production fixture exercise a live transit route**

Before zoning/building creation in `production_fixture()`, add:

```rust
apply(
    &mut engine,
    GameIntent::LayRoadLine {
        points: (2..=12).map(|x| Point { x, y: 5 }).collect(),
        preset: RoadPreset::TwoWay,
    },
);
for point in [Point { x: 2, y: 4 }, Point { x: 10, y: 4 }] {
    apply(&mut engine, GameIntent::AddBusStop { point });
}
apply(
    &mut engine,
    GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    },
);
```

Keep the existing zoning, building, resume, and trip-generation sequence. Use `apply_tick` for every applied tick.

- [ ] **Step 3: Add an explicit positive invariant test including route invalidation**

```rust
#[test]
fn every_reachable_production_state_is_savable() {
    let mut engine = production_fixture();

    apply(&mut engine, GameIntent::SetSpeed { speed: 2 });
    apply_tick(&mut engine, 15.0);
    apply(
        &mut engine,
        GameIntent::DeleteRoute {
            route_id: "route-001".to_string(),
        },
    );
    apply(
        &mut engine,
        GameIntent::LayRoad {
            point: Point { x: 12, y: 10 },
        },
    );
    apply_tick(&mut engine, 20.0);
    apply(&mut engine, GameIntent::SetPaused { paused: true });
}
```

The helper-level assertions make this one test cover savability after every accepted road, stop, route, zoning, building, pause, speed, deletion, and tick operation—not only the final state.

- [ ] **Step 4: Run the savability test**

```sh
rtk cargo test -p caelum-core --test persistence_determinism \
  every_reachable_production_state_is_savable -- --nocapture
```

Expected: PASS. Any failure is a core persistence bug; fix the authoritative engine/validator mismatch rather than weakening the test.

- [ ] **Step 5: Replace the benchmark sampling helper**

Add:

```rust
fn percentile(sorted: &[Duration], percentile: usize) -> Duration {
    let rank = (sorted.len() * percentile + 99) / 100;
    sorted[rank.saturating_sub(1).min(sorted.len() - 1)]
}

fn measure(
    label: &str,
    mut operation: impl FnMut(),
) {
    let cold_started = Instant::now();
    operation();
    let cold = cold_started.elapsed();

    for _ in 0..2 {
        operation();
    }

    let mut samples = Vec::with_capacity(25);
    for _ in 0..25 {
        let started = Instant::now();
        operation();
        samples.push(started.elapsed());
    }
    samples.sort();

    let median = samples[samples.len() / 2];
    let p95 = percentile(&samples, 95);
    println!("{label}: cold={cold:?}, median={median:?}, p95={p95:?}, samples=25");
    assert!(median > Duration::ZERO);
}
```

- [ ] **Step 6: Measure validation and prepared restore**

Update the ignored benchmark:

```rust
measure("native validate", || {
    validate_snapshot(&snapshot).unwrap();
});
measure("native prepared restore", || {
    drop(GameEngine::prepare_restore(snapshot.clone()).unwrap());
});
```

- [ ] **Step 7: Run the updated manual benchmark once**

```sh
rtk cargo test -p caelum-core --test persistence_determinism \
  persistence_validation_benchmark --release -- --ignored --nocapture
```

Expected: output contains separate cold, median, and p95 lines for validation and prepared restore.

- [ ] **Step 8: Commit savability and benchmark changes**

```sh
rtk git add crates/caelum-core/tests/persistence_determinism.rs
rtk git commit -m "test: prove reachable states remain savable"
```

---

### Task 6: Shared Snapshot Fixture Corpus

**Files:**

- Modify: `crates/caelum-core/tests/common/persistence_fixtures.rs`
- Create: `crates/caelum-core/tests/persistence_fixture_export.rs`
- Create: `tests/fixtures/persistence/README.md`
- Create: five snapshot JSON fixtures under `tests/fixtures/persistence/`

**Interfaces:**

- Produces one checked-in fixture root shared by Rust and TypeScript:

```rust
const PERSISTENCE_FIXTURES_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/fixtures/persistence",
);
```

- [ ] **Step 1: Add a host-parity fixture helper**

In `persistence_fixtures.rs`, add `host_parity_fixture() -> GameSnapshot` built through public gameplay operations. It must be paused and persistence-valid, and assertions must prove it contains:

- `scenario.objectives == None`;
- `metrics.loss_reason == None`;
- at least one active trip with a route plan;
- at least one route-plan leg with `service_direction`, `board_itinerary_index`, and `alight_itinerary_index` equal to `None`;
- at least one route/metro leg whose non-skipped option serializes as `null`, or a separate valid broken-route state produced through gameplay;
- at least one vehicle with `parked_position == None`.

Do not hand-edit derived fields to manufacture validity.

- [ ] **Step 2: Add the ignored fixture exporter**

Create `persistence_fixture_export.rs` with:

```rust
mod common;

use std::fs;
use std::path::Path;

use caelum_core::{validate_snapshot, DerivedStateError, PersistenceError, SnapshotField};
use serde_json::{json, Value};

use common::persistence_fixtures::host_parity_fixture;

const PERSISTENCE_FIXTURES_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/fixtures/persistence",
);

fn write_json(name: &str, value: &Value) {
    let path = Path::new(PERSISTENCE_FIXTURES_DIR).join(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, format!("{}\n", serde_json::to_string_pretty(value).unwrap())).unwrap();
}
```

The ignored test writes:

- `valid-paused.json` from `host_parity_fixture()`;
- `unsupported-schema.json` by setting `schemaVersion` to `3` and removing `rules.sandbox.startingCapital`;
- `unpaused.json` by changing only `paused` to `false`;
- `malformed-current-schema.json` by replacing `map.tiles` with a string;
- `late-derived-corruption.json` by setting `waitingTripCount` greater than the count of nonterminal active trips.

Assert the late corruption returns:

```rust
PersistenceError::InvalidDerivedState {
    field: SnapshotField::MetricsCounters,
    reason: DerivedStateError::MetricsRelationshipMismatch,
}
```

- [ ] **Step 3: Add regeneration documentation**

`tests/fixtures/persistence/README.md` must contain:

```sh
rtk cargo test -p caelum-core --test persistence_fixture_export \
  -- --ignored --nocapture
```

Document that `persistence-errors.json` is maintained manually with the closed vocabulary, while the five snapshot fixtures are generated from authoritative Rust state.

- [ ] **Step 4: Generate and inspect the fixtures**

```sh
rtk cargo test -p caelum-core --test persistence_fixture_export \
  -- --ignored --nocapture
rtk jq '.schemaVersion, .paused' tests/fixtures/persistence/valid-paused.json
rtk jq '.schemaVersion, .rules.sandbox.startingCapital' \
  tests/fixtures/persistence/unsupported-schema.json
```

Expected: valid fixture is schema 4 and paused; unsupported fixture is schema 3 and the v4 field is absent.

- [ ] **Step 5: Add fixture contract tests**

In `persistence_fixture_export.rs`, add a normal non-ignored test that reads all five files and proves:

- valid fixture fully deserializes and validates;
- unsupported fixture fails schema check before full decode;
- unpaused fixture returns `PersistenceRequiresPaused`;
- malformed current schema passes probe and fails full decode;
- late corruption fully deserializes and fails with the exact late error.

- [ ] **Step 6: Run fixture tests**

```sh
rtk cargo test -p caelum-core --test persistence_fixture_export
rtk cargo test -p caelum-core --test persistence_error_wire
```

Expected: PASS.

- [ ] **Step 7: Commit the fixture corpus**

```sh
rtk git add crates/caelum-core/tests/common/persistence_fixtures.rs \
  crates/caelum-core/tests/persistence_fixture_export.rs \
  tests/fixtures/persistence
rtk git commit -m "test: add shared persistence fixture corpus"
```

---

### Task 7: WASM Persistence Bridge

**Files:**

- Modify: `crates/caelum-wasm/Cargo.toml`
- Modify: `crates/caelum-wasm/src/lib.rs`
- Test: unit tests inside `crates/caelum-wasm/src/lib.rs`

**Interfaces:**

- Consumes: Tasks 2, 4, and 6 contracts.
- Produces wasm-bindgen instance methods:

```rust
pub fn snapshot_for_save(&self) -> Result<JsValue, JsValue>;
pub fn validate_snapshot(&self, snapshot: JsValue) -> Result<(), JsValue>;
pub fn restore_snapshot(&mut self, snapshot: JsValue) -> Result<JsValue, JsValue>;
```

- [ ] **Step 1: Add direct Serde dependency**

```toml
serde = { version = "1.0", features = ["derive"] }
```

- [ ] **Step 2: Add failing pure helper tests**

Before changing exported methods, add native-safe tests for:

- exact bridge-error JSON shape;
- decode category selection using `serde_json::Value` equivalents where possible;
- generic encode-before-commit helper returning no engine when encoding fails;
- all error variants carrying `operation`;
- `PreparedEngineRestore` assignment occurring only after encoder success.

The generic helper signature is:

```rust
fn encode_prepared_restore<T, E>(
    prepared: PreparedEngineRestore,
    encode: impl FnOnce(&GameSnapshot) -> Result<T, E>,
) -> Result<(T, GameEngine), E>;
```

- [ ] **Step 3: Run WASM crate unit tests and confirm missing helpers**

```sh
rtk cargo test -p caelum-wasm --lib
```

Expected: FAIL until helpers and bridge types are added.

- [ ] **Step 4: Add serializer and bridge-error types**

Use `serde::Serialize`. Define private camelCase enums for:

- `PersistenceOperation`;
- `PersistenceValidationSource`;
- `PersistenceSerializationPhase`;
- `PersistenceHostErrorCode`;
- tagged `PersistenceBridgeError`.

Add:

```rust
fn persistence_serializer() -> serde_wasm_bindgen::Serializer {
    serde_wasm_bindgen::Serializer::json_compatible()
        .serialize_large_number_types_as_bigints(false)
}

fn to_persistence_js_value<T: Serialize + ?Sized>(
    value: &T,
) -> Result<JsValue, serde_wasm_bindgen::Error> {
    value.serialize(&persistence_serializer())
}
```

Structured bridge-error encoding falls back to an opaque string `JsValue` if serialization itself fails.

- [ ] **Step 5: Factor one two-phase WASM decoder**

```rust
fn decode_snapshot(
    value: JsValue,
    operation: PersistenceOperation,
) -> Result<GameSnapshot, JsValue> {
    let actual = serde_wasm_bindgen::from_value::<SnapshotSchemaProbe>(value.clone())
        .map(|probe| probe.schema_version)
        .unwrap_or(0);
    check_schema_version(actual)
        .map_err(|error| validation_js_error(operation, Candidate, error))?;
    serde_wasm_bindgen::from_value(value)
        .map_err(|error| serialization_js_error(operation, SnapshotDecode, error))
}
```

Do not parse JSON text.

- [ ] **Step 6: Implement the three instance operations**

- Save delegates to `self.inner.snapshot_for_save()`, maps failures to `validation/activeEngine`, and uses JSON-compatible encoding.
- Validate decodes and calls `caelum_core::validate_snapshot`; it does not read `self.inner`.
- Restore decodes, calls `GameEngine::prepare_restore`, encodes `prepared.snapshot()`, then assigns `self.inner = prepared.into_engine()`.

- [ ] **Step 7: Remove exported direct construction**

Delete wasm-bindgen `WasmGameEngine::from_snapshot`. Retain `from_sandbox_request`.

- [ ] **Step 8: Add bridge unit coverage**

Test exact serialized bridge shapes for:

- unsupported schema candidate validation;
- unpaused semantic candidate validation;
- active-engine save validation;
- snapshot decode failure;
- snapshot encode failure;
- opaque fallback when bridge-error encoding fails.

Use generic or `#[cfg(test)]` seams only; do not add runtime serializer injection.

- [ ] **Step 9: Run Rust and generated-binding checks**

```sh
rtk cargo test -p caelum-wasm --lib
rtk cargo clippy -p caelum-wasm --all-targets -- -D warnings
rtk bun run wasm:build
rtk bun run check
```

Expected: generated bindings expose the three instance methods and no static `from_snapshot`.

- [ ] **Step 10: Commit the WASM bridge**

```sh
rtk git add crates/caelum-wasm/Cargo.toml \
  crates/caelum-wasm/src/lib.rs
rtk git commit -m "feat: expose WASM persistence operations"
```

---

### Task 8: Tauri Persistence Commands

**Files:**

- Modify: `src-tauri/src/lib.rs`

**Interfaces:**

- Produces:

```rust
#[tauri::command]
fn game_snapshot_for_save(
    state: State<'_, EngineState>,
) -> Result<serde_json::Value, EncodedPersistenceBridgeError>;

#[tauri::command]
fn game_validate_snapshot(
    snapshot: serde_json::Value,
) -> Result<(), EncodedPersistenceBridgeError>;

#[tauri::command]
fn game_restore_snapshot(
    state: State<'_, EngineState>,
    snapshot: serde_json::Value,
) -> Result<serde_json::Value, EncodedPersistenceBridgeError>;
```

- [ ] **Step 1: Add failing command-registration and wire tests**

Update the mock app command list to register the three new commands and remove `game_load_snapshot`. Add tests asserting exact error JSON for:

- `validation/candidate`;
- `validation/activeEngine`;
- `serialization/snapshotDecode`;
- `serialization/snapshotEncode`;
- `host/stateUnavailable`.

Add a negative test showing `game_load_snapshot` is not registered.

- [ ] **Step 2: Add failing save-lock tests**

Factor a helper:

```rust
fn capture_save(
    state: &EngineState,
) -> Result<SaveSnapshotCapture, PersistenceBridgeError>;
```

Test:

```rust
let capture = capture_save(&state).unwrap();
assert!(state.try_lock().is_ok(), "capture must release the mutex");
let saved = capture.prepare().unwrap();
assert!(saved.paused);
```

The helper return type proves no complete engine/topology clone escapes the lock.

- [ ] **Step 3: Run Tauri library tests and confirm missing commands**

```sh
rtk cargo test -p caelum --lib
```

Expected: FAIL until commands and bridge types are implemented.

- [ ] **Step 4: Add Tauri bridge-error types and decoder**

Define the same private camelCase operation/source/phase/code enums and tagged `PersistenceBridgeError` shape used by WASM. Add a shared JSON decoder:

```rust
fn decode_snapshot(
    value: serde_json::Value,
    operation: PersistenceOperation,
) -> Result<GameSnapshot, PersistenceBridgeError> {
    check_snapshot_schema(&value)
        .map_err(|error| PersistenceBridgeError::validation(
            operation,
            PersistenceValidationSource::Candidate,
            error,
        ))?;
    serde_json::from_value(value)
        .map_err(|error| PersistenceBridgeError::serialization(
            operation,
            PersistenceSerializationPhase::SnapshotDecode,
            error.to_string(),
        ))
}
```

- [ ] **Step 5: Implement save with snapshot-only capture**

Acquire the mutex only to call `engine.capture_snapshot_for_save()`. Release it before `capture.prepare()` and `serde_json::to_value`.

- [ ] **Step 6: Implement stateless validation**

Decode, call `caelum_core::validate_snapshot`, and return unit. Do not accept `State`.

- [ ] **Step 7: Implement encode-before-swap restore**

Decode and prepare outside the mutex. Encode `prepared.snapshot()` before locking. Acquire the mutex only for:

```rust
*engine = prepared.into_engine();
```

Return the already-encoded `serde_json::Value`.

- [ ] **Step 8: Register new commands and delete the old command**

Update production and mock `generate_handler!` lists. Remove `game_load_snapshot`, `load_snapshot_body`, and tests for its rejected-promise wire contract.

- [ ] **Step 9: Add atomicity and fallback coverage**

Using shared fixtures, prove:

- early and late failures preserve `game_snapshot`;
- success returns the accepted snapshot and subsequent dispatch uses restored rules;
- generic success-encoding failure occurs before swap;
- private generic structured-error encoding failure produces an opaque string fallback
  before any swap;
- poisoned mutex produces `stateUnavailable`;
- an opaque framework/serialization rejection is normalized to `host/invokeFailed` by
  the TypeScript layer in Task 9.

- [ ] **Step 10: Run Tauri tests and clippy**

```sh
rtk cargo test -p caelum --lib
rtk cargo clippy -p caelum --all-targets -- -D warnings
```

Expected: PASS.

- [ ] **Step 11: Commit the Tauri bridge**

```sh
rtk git add src-tauri/src/lib.rs
rtk git commit -m "feat: expose Tauri persistence commands"
```

---

### Task 9: Backend Adapter Cutover and Required `GameBackend` Methods

**Files:**

- Modify: `src/runtime/backend/types.ts`
- Modify: `src/runtime/backend/wasmBackend.ts`
- Modify: `src/runtime/backend/tauriBackend.ts`
- Modify: `src/runtime/backend/index.ts`
- Modify: `tests/fixtures/rustSnapshot.ts`
- Modify: `tests/runtime/backendContract.test.ts`
- Modify: `tests/runtime/wasmBackend.test.ts`
- Modify: `tests/runtime/tauriBackend.test.ts`
- Modify: `tests/runtime/previewCoordinator.test.ts`
- Verify unchanged: `tests/runtime/gameRuntime.test.ts`
- Verify unchanged: `tests/ui/pointerEvents.test.ts`

**Interfaces:**

- Consumes: Tasks 1–3, 7, and 8.
- Produces required `GameBackend` methods and removes `loadSnapshot`.

- [ ] **Step 1: Add failing exact-signature assertions**

In `backendContract.test.ts`:

```ts
expectTypeOf<GameBackend["snapshotForSave"]>().toEqualTypeOf<
  () => Promise<PersistenceSnapshotResult>
>();
expectTypeOf<GameBackend["validateSnapshot"]>().toEqualTypeOf<
  (request: PersistenceSnapshotRequest) => Promise<PersistenceValidationResult>
>();
expectTypeOf<GameBackend["restoreSnapshot"]>().toEqualTypeOf<
  (request: PersistenceSnapshotRequest) => Promise<PersistenceSnapshotResult>
>();
declare const backend: GameBackend;
// @ts-expect-error loadSnapshot is intentionally removed from GameBackend
backend.loadSnapshot;
```

- [ ] **Step 2: Extend the concrete backend interface**

Import contract types into `types.ts`, add:

```ts
export type PersistenceSnapshotResult =
  PersistenceSnapshotResultOf<RustGameSnapshot>;
```

Add all three required methods and delete optional `loadSnapshot`.

- [ ] **Step 3: Wire the stable WASM wrapper instance**

Change `let engine` to `const engine`. Add:

```ts
snapshotForSave() {
  return runPersistenceSnapshotOperation(
    "snapshotForSave",
    () => engine.snapshot_for_save(),
  );
},
validateSnapshot(request) {
  return runPersistenceValidationOperation(
    undefined,
    () => engine.validate_snapshot(request.snapshot),
  );
},
restoreSnapshot(request) {
  return runPersistenceSnapshotOperation(
    "restoreSnapshot",
    () => engine.restore_snapshot(request.snapshot),
  );
},
```

Delete static-constructor replacement and stale migration comments.

- [ ] **Step 4: Wire Tauri commands through the same helpers**

```ts
snapshotForSave() {
  return runPersistenceSnapshotOperation(
    "snapshotForSave",
    () => invoke("game_snapshot_for_save"),
  );
},
validateSnapshot(request) {
  return runPersistenceValidationOperation(
    null,
    () => invoke("game_validate_snapshot", { snapshot: request.snapshot }),
  );
},
restoreSnapshot(request) {
  return runPersistenceSnapshotOperation(
    "restoreSnapshot",
    () => invoke("game_restore_snapshot", { snapshot: request.snapshot }),
  );
},
```

Do not normalize returned snapshots.

- [ ] **Step 5: Update public exports**

Export request, result, operation, error, source, validation vocabulary, and guard types from `index.ts`. Do not export raw bridge DTOs or wrapper constructors.

- [ ] **Step 6: Update shared test stubs once**

Extend `previewBackendStubs()` to include:

```ts
"snapshotForSave" | "validateSnapshot" | "restoreSnapshot"
```

Implement:

```ts
async snapshotForSave() {
  return { ok: true, snapshot: createRustSnapshot({ paused: true }) };
},
async validateSnapshot() {
  return { ok: true };
},
async restoreSnapshot(request) {
  return {
    ok: true,
    snapshot: request.snapshot as RustGameSnapshot,
  };
},
```

Use this only for trusted test fixtures. Production input remains `unknown`.

Update `tests/runtime/previewCoordinator.test.ts` by adding the same `unused` casts for
`snapshotForSave`, `validateSnapshot`, and `restoreSnapshot`; those members must throw if
the preview coordinator ever reaches them. `gameRuntime.test.ts` and
`pointerEvents.test.ts` already spread `previewBackendStubs()` and should compile without
local persistence implementations.

- [ ] **Step 7: Replace WASM adapter load tests**

Update the generated mock class with instance methods and controllable success/error values. Assert:

- exact forwarding;
- nullish validation success;
- known bridge errors remain typed results;
- malformed success/error mapping;
- wrong schema success rejection;
- restore does not replace the JS wrapper instance;
- initialization failure still rejects backend creation and constructs no engine.

- [ ] **Step 8: Replace Tauri adapter load tests**

Assert exact command names/arguments and the same normalization cases as WASM.

- [ ] **Step 9: Run targeted TypeScript tests and fix all complete stubs**

```sh
rtk bun run check
rtk bunx vitest run tests/runtime/persistenceContract.test.ts \
  tests/runtime/backendContract.test.ts \
  tests/runtime/wasmBackend.test.ts \
  tests/runtime/tauriBackend.test.ts \
  tests/runtime/gameRuntime.test.ts \
  tests/ui/pointerEvents.test.ts
```

If `bun run check` reports a complete `GameBackend` object not covered by `previewBackendStubs`, add the three explicit no-op/test implementations in that exact file; do not make the production interface optional.

- [ ] **Step 10: Commit the adapter cutover**

```sh
rtk git add src/runtime/backend \
  tests/fixtures/rustSnapshot.ts \
  tests/runtime/backendContract.test.ts \
  tests/runtime/wasmBackend.test.ts \
  tests/runtime/tauriBackend.test.ts \
  tests/runtime/previewCoordinator.test.ts
rtk git commit -m "feat: cut over persistence backend adapters"
```

---

### Task 10: Real WASM JSON Round-Trip and Performance Evidence

**Files:**

- Modify: `tests/runtime/wasmArtifact.smoke.test.ts`
- Create: `scripts/benchmark-persistence-wasm.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: real generated WASM and shared fixtures.
- Produces:
  - JSON stringify/parse/restore equality proof;
  - recursive unsupported-JavaScript-value check;
  - reproducible cold/median/p95 real-WASM benchmark.

- [ ] **Step 1: Replace real-artifact load tests with result-union tests**

Migrate the current `loadSnapshot` cases to `validateSnapshot` and `restoreSnapshot`. Preserve coverage for:

- creative policy after restore;
- required `objectives` key;
- invalid validated newtypes as `snapshotDecode`;
- unpaused semantic error;
- legacy schema probe;
- malformed current-schema decode.

Assert exact `{ ok: false, error }` objects rather than rejected promises.

- [ ] **Step 2: Add a recursive JSON-compatible value assertion**

```ts
function expectJsonCompatible(value: unknown, path = "$"): void {
  expect(typeof value, `${path} must not be undefined`).not.toBe("undefined");
  expect(typeof value, `${path} must not be bigint`).not.toBe("bigint");
  expect(value instanceof Map, `${path} must not be Map`).toBe(false);
  expect(ArrayBuffer.isView(value), `${path} must not be a typed array`).toBe(false);

  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      expectJsonCompatible(entry, `${path}[${index}]`),
    );
  } else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      expectJsonCompatible(entry, `${path}.${key}`);
    }
  }
}
```

- [ ] **Step 3: Add JSON stringify/parse/restore equality**

Load `valid-paused.json`; obtain a fresh `snapshotForSave`; assert JSON compatibility; stringify and parse; restore into a fresh backend; assert:

```ts
expect(saved.ok).toBe(true);
if (!saved.ok) throw new Error("expected snapshotForSave success");
expect(restored).toEqual({
  ok: true,
  snapshot: saved.snapshot,
});
```

Also validate the checked-in fixture through the real artifact.

- [ ] **Step 4: Add cross-fixture failure cases**

Use `unsupported-schema.json`, `unpaused.json`, `malformed-current-schema.json`, and `late-derived-corruption.json` against both `validateSnapshot` and `restoreSnapshot`; assert exact categories and that a post-failure `snapshot()` equals the pre-failure state.

- [ ] **Step 5: Create the manual WASM benchmark script**

`scripts/benchmark-persistence-wasm.ts`:

- runs `createWasmBackend()`;
- loads `valid-paused.json`;
- measures `validateSnapshot` and `restoreSnapshot`;
- records one cold call;
- runs exactly two warmups;
- runs 25 samples;
- sorts samples and prints median/p95;
- exits nonzero if any operation returns `ok: false`.

Use `performance.now()` and the same percentile calculation as the Rust benchmark.

- [ ] **Step 6: Add the package command**

```json
"benchmark:persistence:wasm": "bun run ensure-wasm && bun run scripts/benchmark-persistence-wasm.ts"
```

- [ ] **Step 7: Run real-artifact tests and evidence command**

```sh
rtk bun run wasm:build:release
rtk bunx vitest run tests/runtime/wasmArtifact.smoke.test.ts
rtk bun run benchmark:persistence:wasm
```

Expected: artifact tests pass; benchmark prints cold, median, and p95 for validate and restore. Record same-machine native and WASM output in the implementation PR.

- [ ] **Step 8: Commit real-WASM evidence**

```sh
rtk git add tests/runtime/wasmArtifact.smoke.test.ts \
  scripts/benchmark-persistence-wasm.ts \
  package.json
rtk git commit -m "test: verify persistence through real WASM"
```

---

### Task 11: Cross-Host Cleanup, Documentation, and Final Verification

**Files:**

- Modify: `docs/architecture.md`
- Modify: any test/docs references to the old compatibility API
- Verify: all files in the design and plan maps

**Interfaces:**

- Produces the final no-bypass repository state and implementation evidence.

- [ ] **Step 1: Document the final authority and transaction boundaries**

Update `docs/architecture.md` with:

- engine-minted save capture;
- pure candidate validation;
- prepared restore token;
- host encode-before-commit;
- JSON-compatible persistence-only serializer;
- raw backend result versus normalized runtime view;
- HPA-342 ownership of storage/publication;
- p95/main-thread autosave handoff.

- [ ] **Step 2: Remove stale compatibility comments and tests**

Delete statements that `loadSnapshot` preserves stop normalization. Keep live network-mutation coverage for `normalize_snapshot_stops`.

- [ ] **Step 3: Run targeted bypass searches**

```sh
rtk rg -n 'GameBackend\.loadSnapshot|loadSnapshot\(|game_load_snapshot|WasmGameEngine\.from_snapshot' \
  src crates/caelum-wasm src-tauri tests
rtk rg -n 'pub fn from_snapshot' crates/caelum-wasm/src/lib.rs
rtk rg -n 'GameEngine::from_snapshot|GameEngine::prepare_restore' \
  crates/caelum-core crates/caelum-wasm src-tauri
```

Expected:

- first two searches return no production compatibility path;
- core construction/preparation calls remain in approved Rust locations and tests.

- [ ] **Step 4: Run formatting and static checks**

```sh
rtk cargo fmt --all --check
rtk cargo clippy --workspace --all-targets -- -D warnings
rtk bun run format:check
rtk bun run check
```

Expected: PASS.

- [ ] **Step 5: Run full Rust and frontend suites**

```sh
rtk cargo test --workspace
rtk bun run test
rtk bun run build
```

Expected: PASS with zero failures. The ignored performance tests remain ignored during normal CI.

- [ ] **Step 6: Run final persistence evidence**

```sh
rtk cargo test -p caelum-core --test persistence_determinism \
  persistence_validation_benchmark --release -- --ignored --nocapture
rtk bun run benchmark:persistence:wasm
```

Record cold, median, and p95 for native validation, native prepared restore, WASM validation, and WASM restore. Compare medians against:

```text
real-WASM median <= max(100 ms, 10 × same-machine native median)
```

If exceeded, report evidence and open a follow-up host-execution issue. Do not weaken validation or add an unreviewed worker.

- [ ] **Step 7: Check the HPA-341 acceptance criteria line by line**

Confirm:

- equal host persistence shape;
- exact typed core error mapping;
- failed restore state preservation;
- successful canonical raw snapshot return;
- no TypeScript direct replacement path;
- unchanged dispatch/tick behavior;
- reachable-state savability;
- JSON text round-trip;
- raw/view normalization parity;
- explicit HPA-342 handoff.

- [ ] **Step 8: Commit documentation and cleanup**

```sh
rtk git status --short
rtk git add docs/architecture.md
rtk git commit -m "docs: finalize persistence host boundary"
```

- [ ] **Step 9: Prepare the implementation PR summary**

Include:

- operation/result contract;
- core capture/prepared-token design;
- WASM/Tauri atomicity;
- error catalogue counts;
- JSON round-trip result;
- bypass-search output;
- full verification commands;
- native/WASM cold, median, and p95 evidence;
- explicit HPA-342 autosave/main-thread follow-up note.

---

## Self-Review Checklist for the Implementer

Before marking the implementation ready:

- [ ] No task introduced storage, UI, migration, repair, autosave scheduling, or a worker.
- [ ] The save-capture token cannot be constructed from arbitrary `GameSnapshot`.
- [ ] `restoreSnapshot` encodes before mutating both hosts.
- [ ] Validation accepts only `undefined`/`null`.
- [ ] Snapshot success checks exact current schema.
- [ ] Every error variant includes `operation`.
- [ ] The strict guard rejects unknown keys at every closed level.
- [ ] The catalogue covers all 14 codes, 83 fields, 9 entity kinds, every reason kind, and embedded shapes.
- [ ] Raw backend snapshots are never view-normalized inside adapters.
- [ ] All non-skipped schema-v4 optionals normalize recursively at the runtime-view boundary.
- [ ] JSON stringify/parse/restore is proven with the real artifact.
- [ ] Reachable public gameplay states remain savable.
- [ ] `loadSnapshot`, `game_load_snapshot`, and exported WASM `from_snapshot` are absent.
- [ ] Full Rust/frontend checks and performance evidence are recorded.

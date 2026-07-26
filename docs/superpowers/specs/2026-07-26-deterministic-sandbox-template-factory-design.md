# HPA-339: Deterministic Sandbox Template Factory

**Status:** Revised after review; awaiting written-spec approval

**Linear:** [HPA-339](https://linear.app/cwchanap/issue/HPA-339/add-a-deterministic-sandbox-template-factory-with-blank-grid-and)

## Outcome

New-city creation can ask the Rust core for a complete initial sandbox snapshot
from a stable template identifier and explicit creation settings. Repeating the
same request produces an equal snapshot with stable IDs in the browser and
Tauri hosts.

HPA-339 ships two 28×18 templates:

- **Blank Grid** contains no authored city entities.
- **Crossroads** contains the current paired one-way arterial scaffold with a
  corrected center junction that supports every legal straight, left, and
  right movement without player repair.

Every sandbox template has no objectives and no growth waves. Sandbox reset
recreates the active city from its complete original creation request instead
of silently returning a different template or a hard-coded set of settings.
Campaign reset is rejected explicitly because this factory cannot reconstruct
campaign objectives or authored growth waves from sandbox settings.

## Current State

HPA-337 added Rust-owned sandbox rules and schema-v3 snapshot fields. The
current model has one `SandboxTemplateId::GrowingSuburb`, a positive
`DemandMultiplier`, and one `MoveInRateSelection::Paused` value. The initial
snapshot is always Standard Sandbox with 120,000 budget.

`create_initial_snapshot()` directly assembles the snapshot and calls
`create_growing_suburb_map()`. That map authors four one-way arterial lanes:

- westbound on row 8;
- eastbound on row 9;
- southbound on column 14; and
- northbound on column 15.

The four authored sequences overlap at the 2×2 center. They do not author the
complete reciprocal facts needed for the center to become a routable junction.
The subsequent automatic-junction refresh is best-effort, so the current
arterial cross is a visual scaffold rather than a guaranteed routing graph.

`GameEngine::new()` and `GameEngine::reset()` always use the same hard-coded
initial snapshot. WASM and Tauri expose that default construction/reset path,
but neither accepts a template creation request. Reset therefore has no active
template contract.

## Decisions

The following decisions were approved during design review:

1. The canonical wire template ID is `"crossroads"`.
   `"growingSuburb"` is removed rather than retained as an alias.
2. Reset replays the complete original creation request, including template,
   economy preset, starting capital, demand multiplier, and move-in rate.
3. Starting capital is persisted in sandbox rules so exact reset remains
   possible after future save/load restoration.
4. Crossroads guarantees straight, left, and right travel from each of its four
   inbound approaches. The same-arm outbound movement is a U-turn and is not
   authored, yielding 12 required center movements.
5. A dedicated Rust sandbox factory owns creation and validation. It does not
   extend `GameplayRejection` or introduce a generic template registry.
6. The existing default snapshot, `GameEngine::new()`, and Rust/WASM `Default`
   implementations remain infallible compatibility paths for the statically
   known default Crossroads request. User-provided creation and reset remain
   fallible.
7. Reset matches on `GameMode`: sandbox performs exact replay, while campaign
   returns a typed `unsupportedGameMode` reset error without changing state.
8. The TypeScript backend returns discriminated creation/reset results for
   expected domain failures. Unexpected transport failures still reject the
   promise.

## Goals

- Define stable Rust-owned Blank Grid and Crossroads identifiers.
- Define one Rust-owned creation request and one validation path.
- Persist every setting needed to reproduce the original sandbox.
- Build complete deterministic snapshots rather than partially initialized
  maps.
- Make Blank Grid structurally empty of authored city content.
- Make Crossroads immediately routable for all 12 required center movements.
- Return typed creation errors for unknown IDs and invalid settings.
- Expose equivalent core, WASM, Tauri, and TypeScript backend operations.
- Make reset reproduce the active sandbox request atomically.
- Reject campaign reset without replacing or converting the campaign.
- Characterize template maps, settings, IDs, host parity, and repeated
  construction with deterministic tests.

## Non-goals

- Small Town content; HPA-350 owns that template.
- Procedural terrain or roads.
- Arbitrary map dimensions.
- A map editor or user-authored templates.
- Population occupancy or gradual move-in.
- New demand profiles or operational move-in rates.
- Saving, storage adapters, city-library UI, or new-city UI.
- Campaign selection or reconstruction of campaign reset state. HPA-339 only
  makes the unsupported reset case explicit and non-destructive.
- Creative purchase behavior. HPA-338 remains responsible for applying the
  Creative cost policy to gameplay mutations.
- A trait-based or dynamic template registry.
- Compatibility aliases or migration for the pre-persistence
  `"growingSuburb"` identifier.

## 1. Ownership and Module Boundaries

### 1.1 Dedicated sandbox creation module

Add a focused Rust module under `caelum-core` for sandbox creation. It owns:

- the raw creation request;
- validated creation settings;
- creation-specific errors;
- reset-specific errors;
- the canonical default Crossroads request and sandbox settings;
- the common initial snapshot shell;
- Blank Grid construction;
- Crossroads construction;
- template invariant validation; and
- reconstruction of a request from persisted sandbox rules.

`scenario.rs` retains campaign-specific Growing Suburb objectives and growth
authoring. It no longer owns the default sandbox map or defines
`growing_suburb_sandbox_settings()`. Its `growing_suburb_campaign()` helper
imports the canonical default Crossroads sandbox settings from the new sandbox
module, then layers campaign mode, objectives, and growth waves over them.
Growing Suburb remains a campaign/scenario name; it is not a sandbox template
identifier.

Existing campaign fixtures may continue to call the infallible
`create_initial_snapshot()` and then replace rules/scenario for focused tests.
Because the compatibility helper stays infallible, HPA-339 does not force the
large existing snapshot-fixture inventory to unwrap a built-in default.

This split keeps the authoritative construction path in Rust without mixing
new-city validation into campaign helpers. It also gives HPA-350 one explicit
place to add Small Town after its authored content is known.

### 1.2 No generic registry yet

The factory uses an exhaustive match over the closed `SandboxTemplateId` enum.
With two templates, a registry or template trait would add indirection without
removing meaningful duplication. Adding Small Town later is one enum case and
one builder; a registry should be considered only if templates eventually need
runtime registration or substantially different lifecycle hooks.

### 1.3 Gameplay mutations remain separate

Template authoring does not dispatch player intents and does not charge
construction costs. It writes deterministic authored map facts through narrow
road-authoring helpers and returns a complete candidate snapshot. Normal
gameplay mutations continue to use `GameEngine::dispatch`.

The requested `economyPreset` is persisted and returned immediately, but
HPA-339 does not implement Creative cost bypass. That remains HPA-338's
independent gameplay-policy slice.

## 2. Creation Contract

### 2.1 Stable identifiers

The Rust enum becomes:

```rust
pub enum SandboxTemplateId {
    BlankGrid,
    Crossroads,
}
```

It serializes as `"blankGrid"` and `"crossroads"`. The TypeScript union mirrors
those strings exactly. `SandboxTemplateId::GrowingSuburb` and the
`"growingSuburb"` wire value are removed.

Campaign fixtures that need an underlying sandbox-template field use
`Crossroads`, because it is the corrected successor to the current arterial
map. Their `ScenarioConfig.name` may remain `"Growing Suburb"`; scenario
identity and sandbox template identity are distinct.

### 2.2 Raw and validated requests

The host-facing request contains primitive values:

```typescript
interface SandboxCreationRequest {
  templateId: string;
  economyPreset: string;
  startingCapital: number;
  demandMultiplier: number;
  moveInRate: string;
}
```

Rust owns the corresponding request type and converts it into an internal
validated request before constructing any map, topology, or engine. Keeping
the raw fields primitive lets Rust classify unknown strings and invalid
numbers. Host-side enum deserialization must not turn an unknown template into
an opaque Tauri or WASM transport failure.

The validated request contains:

- `SandboxTemplateId`;
- `EconomyPreset`;
- `StartingCapital`;
- `DemandMultiplier`; and
- `MoveInRateSelection`.

`StartingCapital` is a validated numeric newtype represented as a plain integer
on the persisted wire. Raw host input is inspected as a JSON/JavaScript number
so Rust can classify fractional, non-finite, negative, and out-of-range values
as `invalidStartingCapital` instead of relying on an early integer
deserialization failure. Validation accepts integral values in
`0..=i32::MAX` and then converts them to the `i32` used by
`GameSnapshot.budget`. Zero is valid in both economy presets.

`DemandMultiplier` retains the HPA-337 rule: it must be finite and greater than
zero. `MoveInRateSelection` supports only `"paused"` in this phase. The only
economy values are `"standard"` and `"creative"`.

### 2.3 Persisted reset settings

`SandboxSettings` adds required `startingCapital`:

```typescript
interface SandboxSettings {
  templateId: "blankGrid" | "crossroads";
  startingCapital: number;
  demandMultiplier: number;
  moveInRate: "paused";
}
```

The initial snapshot sets both `rules.sandbox.startingCapital` and mutable
`budget` to the requested amount. Gameplay may change `budget`; it does not
change `startingCapital`.

Together with `rules.economyPreset`, the sandbox settings contain every field
needed to reconstruct the validated creation request. No hidden host-local
reset configuration is required.

### 2.4 Default request

The compatibility/default request is:

```json
{
  "templateId": "crossroads",
  "economyPreset": "standard",
  "startingCapital": 120000,
  "demandMultiplier": 1.0,
  "moveInRate": "paused"
}
```

`create_initial_snapshot()` becomes a thin infallible compatibility wrapper
around this statically known request. `GameEngine::new()` continues to return
`GameEngine`, and both `GameEngine` and `WasmGameEngine` retain their existing
`Default` implementations.

The compatibility wrapper delegates to the same factory, then asserts that the
built-in default satisfies its compile-time/template invariants. This is a
programmer assertion, not validation of user input. Tauri constructs the
default engine before placing it inside `Mutex`, so an invariant failure cannot
poison an already-managed engine. Requested creation and reset never use this
asserting path; they propagate typed failures and preserve active state.

## 3. Typed Creation Errors

Creation errors are separate from `GameplayRejection`. A rejected creation
request occurs before there is an active snapshot to include in a dispatch
result, and it must not be presented as an in-game mutation failure.

The wire contract is:

```typescript
type SandboxCreationErrorCode =
  | "unknownTemplateId"
  | "invalidEconomyPreset"
  | "invalidStartingCapital"
  | "invalidDemandMultiplier"
  | "unsupportedMoveInRate"
  | "templateInvariantViolation";

interface SandboxCreationError {
  code: SandboxCreationErrorCode;
  context: {
    field?: string;
    attemptedValue?: string;
    templateId?: string;
  };
}
```

`attemptedValue` is diagnostic only. Callers branch on `code`, never by parsing
text. Non-finite numeric values use canonical diagnostic strings such as
`"NaN"`, `"Infinity"`, and `"-Infinity"` so error serialization itself remains
valid JSON.

Validation stops before template construction. A failed request does not
mutate the active WASM or Tauri engine.

`templateInvariantViolation` represents a defect in a built-in template, such
as topology compilation failure or a missing required Crossroads movement. It
is not used for player-provided settings. Debug assertions may make the defect
prominent locally. Requested construction and reset return the typed error
rather than a degraded map. The statically known infallible default wrapper
treats the same defect as a programmer assertion before an active engine is
installed, as defined in section 2.4.

Reset has a separate error contract because an active engine already exists:

```typescript
type SandboxResetErrorCode =
  | "unsupportedGameMode"
  | "templateInvariantViolation";

interface SandboxResetError {
  code: SandboxResetErrorCode;
  context: {
    gameMode?: "sandbox" | "campaign";
    templateId?: "blankGrid" | "crossroads";
  };
}
```

`unsupportedGameMode` is returned when reset is requested for a campaign
snapshot. The engine remains unchanged. Persisted sandbox request fields use
validated Rust types, so reset cannot rediscover an unknown template or invalid
numeric setting after a schema-v4 snapshot has been constructed or
deserialized.

## 4. Deterministic Snapshot Construction

### 4.1 Shared initial snapshot shell

The factory builds a common snapshot shell with:

- the current schema version;
- time `0.0`;
- the normal day/clock values derived from time zero;
- speed `1`;
- paused `true`;
- current budget equal to starting capital;
- sandbox game mode;
- the requested economy and sandbox settings;
- empty buildings;
- empty stops, stations, routes, metro lines, and vehicles;
- empty residents and active trips;
- deterministic trip counters (`tripSequenceDay` at time zero and
  `nextTripSequence` equal to `1`);
- zeroed running metrics; and
- a template-named scenario with `objectives: null` and `growthWaves: []`.

The exact sandbox scenario names are `"Blank Grid"` and `"Crossroads"`.
Growing Suburb campaign snapshots retain the separate `"Growing Suburb"`
scenario name.

The template builder supplies only the deterministic `GameMap`. Snapshot
assembly therefore cannot accidentally give one template different counters,
metrics, transit defaults, or sandbox terminality.

### 4.2 Shared blank grid

Both templates use one 28×18 row-major grid builder. Every tile receives its
canonical `tile_id(x, y)`. A new tile has:

- kind `"empty"`;
- no area;
- no track;
- no one-way direction;
- no road connections; and
- no road-structure ownership.

The map starts with no road structures.

Blank Grid returns this map unchanged. Its completed snapshot therefore has no
authored:

- roads or road structures;
- zoning;
- track;
- buildings;
- residents or trips; or
- transit nodes, routes, lines, or vehicles.

The word "blank" does not exclude the deterministic grid tiles themselves.

### 4.3 Crossroads arterial geometry

Crossroads starts from the same blank grid and authors the current arterial
geometry:

- row 8, westbound;
- row 9, eastbound;
- column 14, southbound; and
- column 15, northbound.

`author_scenario_road_line()` already connects each arm's ordered sequence
through `connect_authored_sequence()`. Crossroads reuses that behavior; the new
authoring is limited to the reciprocal center facts and automatic-junction
structure needed to connect the four otherwise-complete arms.

The center footprint is:

```text
(14,8) (15,8)
(14,9) (15,9)
```

A dedicated Crossroads center helper authors the reciprocal road facts,
structure ownership, and deterministic automatic-junction ports required by
`RoadTopology`. It does not rely on a best-effort whole-map junction refresh
to discover or repair the center after the fact.

The automatic-junction ID is derived from the canonical sorted footprint and
sorted port keys using the same stable identity rule as other automatic
junctions. The builder must not depend on hash-map iteration order.

### 4.4 Required movement matrix

Crossroads has four inbound and four outbound arms. From each inbound arm, the
junction exposes:

- the opposite outbound arm as `Straight`;
- one adjacent outbound arm as `RightTurn`; and
- the other adjacent outbound arm as `LeftTurn`.

The outbound arm on the same side as the inbound arm would be a U-turn and is
not authored. This produces exactly 12 required non-U-turn movements.

The factory compiles `RoadTopology` before returning. It queries the compiled
topology through the existing public `transition_for()` method for the required
matrix and rejects an invalid built-in template with
`templateInvariantViolation`. `transition_for()` is marked `#[doc(hidden)]`,
but it is already a production query used by the network layer; HPA-339 does
not add a second topology-inspection API. This makes the routing graph—not
visual tile occupancy—the acceptance oracle.

## 5. Engine and Reset Lifecycle

### 5.1 Fallible requested construction

Add a `GameEngine` constructor that accepts a raw sandbox request and returns:

```rust
Result<GameEngine, SandboxCreationError>
```

Construction validates the request, builds the snapshot, compiles the topology,
and creates the engine as one operation. There is never an engine whose
snapshot and cached topology came from different template candidates.

The existing zero-argument `GameEngine::new()` delegates to the infallible
default compatibility wrapper and keeps its current signature. Requested
construction uses a separate fallible constructor, so existing direct engine
tests and campaign fixtures do not acquire unrelated result-handling noise.

### 5.2 Exact-request reset

Reset first matches on `snapshot.rules.gameMode`.

For an active sandbox, it:

1. reads `economyPreset` and the persisted sandbox settings;
2. reconstructs the validated creation request;
3. builds a replacement snapshot and topology off to the side;
4. swaps both into the engine only after successful construction; and
5. returns the fresh snapshot in a successful reset result.

Reset discards all player mutations and restores the original starting
capital. It preserves the original template and demand settings. A Blank Grid
reset cannot produce Crossroads, and a Crossroads reset cannot produce Blank
Grid.

For an active campaign, reset returns
`SandboxResetError { code: UnsupportedGameMode, ... }` without constructing or
swapping a candidate. HPA-339 does not guess how to reconstruct objectives or
growth waves, and it no longer allows the existing reset behavior to silently
replace a campaign with the default sandbox.

The reset operation is fallible so both unsupported mode and built-in template
invariant failures can be returned without corrupting the current engine.
These are sandbox lifecycle results, not recoverable gameplay rejections.

## 6. Host and Frontend Boundary

### 6.1 Core operation

The core factory is the sole source of initial snapshots for requested sandbox
creation. Neither host duplicates template geometry, starting settings, or
validation.

### 6.2 WASM

`WasmGameEngine::new() -> WasmGameEngine` and its `Default` implementation keep
their current infallible signatures. Requested construction is a separate
fallible static operation:

```rust
from_sandbox_request(request: JsValue) -> Result<WasmGameEngine, JsValue>
```

That operation:

- converts the JavaScript request into the Rust raw request;
- delegates validation and engine creation to `caelum-core`;
- returns the new engine on success; and
- serializes `SandboxCreationError` on failure.

The WASM reset method delegates to the mode-aware engine reset and serializes
`SandboxResetError` on failure. The WASM backend distinguishes serialized
sandbox errors from unexpected JavaScript/serialization failures.

### 6.3 Tauri

Tauri adds a `game_create_sandbox` command. The command constructs a complete
candidate engine before replacing managed state. It acquires the managed lock
only for the final swap, so invalid input and template defects leave the
current engine unchanged and cannot poison the mutex through a panic.
The command returns `Result<GameSnapshot, SandboxCreationError>`.

`game_reset` delegates to the same mode-aware reset and returns
`Result<GameSnapshot, SandboxResetError>`. Mutex and serialization failures
remain host failures rather than being mislabeled as sandbox-domain errors.

### 6.4 TypeScript backend

The shared backend contract uses discriminated results for expected sandbox
domain failures:

```typescript
type SandboxCreationResult =
  | { ok: true; snapshot: RustGameSnapshot }
  | { ok: false; error: SandboxCreationError };

type SandboxResetResult =
  | { ok: true; snapshot: RustGameSnapshot }
  | { ok: false; error: SandboxResetError };

createSandbox(
  request: SandboxCreationRequest,
): Promise<SandboxCreationResult>;

reset(): Promise<SandboxResetResult>;
```

The WASM backend replaces its local engine only after construction succeeds.
The Tauri backend invokes `game_create_sandbox`, whose command performs the
atomic managed-engine replacement.

Both adapters catch and recognize the serialized Rust domain error, then return
the corresponding `{ ok: false, error }` variant. Unexpected transport,
serialization, module-loading, or mutex failures still reject the promise.
Adapters do not validate template geometry, reinterpret settings, or
manufacture fallback snapshots.

The existing runtime reset path commits the returned snapshot only for
`ok: true`. For `ok: false`, it preserves the current runtime snapshot and
surfaces the reset failure through existing shell/backend error handling.

HPA-339 exposes the backend capability but does not add a runtime controller
or player-facing New City flow. HPA-345 owns that workflow.

## 7. Schema and Compatibility

Adding required `startingCapital` and replacing the only template identifier
changes the persisted snapshot contract. Increment
`SNAPSHOT_SCHEMA_VERSION` from `3` to `4` in Rust and TypeScript.

Schema-v4 sandbox settings require:

- `templateId`;
- `startingCapital`;
- `demandMultiplier`; and
- `moveInRate`.

Do not add Serde defaults that guess missing starting capital or translate
`"growingSuburb"`. Schema-v3 payloads remain rejected by the existing
unsupported-schema probe. Durable player saves and migration do not exist yet;
HPA-340 owns future persistence validation and restoration.

Update:

- Rust model wire tests;
- TypeScript domain/backend types;
- Rust and TypeScript schema constants;
- snapshot fixtures;
- backend normalization tests;
- unsupported-schema expected versions; and
- default-start characterizations.

## 8. Verification

### 8.1 Factory determinism

For each template, construct the same request repeatedly and assert complete
snapshot equality. Repeat with representative valid combinations of:

- Standard and Creative economy;
- zero, default, and maximum starting capital;
- default and non-default positive demand multiplier; and
- paused move-in.

Changing one request setting changes only the expected rules/budget fields,
not the authored template map.

Assert that `create_initial_snapshot()`, `GameEngine::new()`, and the default
WASM constructor all produce the same snapshot as the canonical default
Crossroads request. Campaign helper tests assert that
`growing_suburb_campaign()` reuses those Crossroads sandbox settings while
retaining campaign mode and the `"Growing Suburb"` scenario name.

### 8.2 Characterization fixtures

Check in compact, reviewable template characterizations rather than duplicating
a full 504-tile snapshot blindly. Each characterization records:

- map width and height;
- ordered tile IDs;
- every non-default tile fact;
- road structures, footprints, ports, and IDs;
- rules and starting budget;
- scenario identity and empty campaign content;
- deterministic counters; and
- initial entity ID collections.

The characterization is serialized from deterministic ordered data and
compared byte-for-byte with a checked-in fixture.

### 8.3 Blank Grid

Tests inspect every tile and every authored entity collection. They assert that
Blank Grid has no roads, structures, areas, track, buildings, residents,
active trips, stops, stations, routes, metro lines, or vehicles.

### 8.4 Crossroads

Tests assert:

- exact arterial coordinates and one-way directions;
- reciprocal road connections;
- exact center footprint;
- stable automatic-junction ID and ordered ports;
- successful topology compilation;
- all 12 required straight/left/right transitions; and
- absence of same-arm U-turn transitions.

Routeability tests use `RoadTopology` states or route resolution rather than
checking only that road tiles exist.

### 8.5 Validation and atomicity

Test every creation error code, including:

- unknown template ID;
- unknown economy preset;
- negative and greater-than-`i32::MAX` capital;
- zero, negative, NaN, and infinite demand multipliers; and
- unsupported move-in rate.

For host and engine replacement operations, assert that a failed request leaves
the previous snapshot unchanged. Backend adapter tests also assert that expected
Rust domain errors become `{ ok: false, error }`, while unrelated host failures
still reject.

### 8.6 Reset

Create each template with non-default valid settings, apply representative map
and budget mutations, reset, and compare the result with a freshly constructed
snapshot from the original request.

Add explicit regressions proving:

- Blank Grid reset stays Blank Grid;
- Crossroads reset stays Crossroads;
- starting capital is restored;
- economy and demand settings are preserved; and
- reset produces the same topology as fresh construction;
- campaign reset returns `unsupportedGameMode`; and
- rejected campaign reset leaves the complete campaign snapshot unchanged.

### 8.7 Host parity

WASM and Tauri adapter contract tests submit the same raw requests and compare
their normalized output with the core factory result. They also compare typed
error codes, contexts, and discriminated backend results for the same invalid
requests.

TypeScript backend tests verify operation names, request forwarding, atomic
local-engine replacement, reset forwarding, domain-result normalization, and
preservation of unexpected promise rejections.

### 8.8 Regression suite

Run the focused Rust factory/topology and host contract tests first, followed
by the repository gates:

```sh
cargo fmt --all --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
bun run check
bun run format:check
bun run test
bun run build
```

Playwright is not required to prove a non-UI factory contract, but existing E2E
tests exercise the default start and therefore remain part of the repository
regression gate:

```sh
bun run test:e2e
```

## 9. Delivery Boundaries

HPA-339 is complete when:

- the core factory owns both templates and validation;
- repeated requests produce equal snapshots;
- Blank Grid is structurally blank;
- Crossroads passes its 12-movement topology matrix;
- reset exactly replays active sandbox creation settings;
- campaign reset is rejected without replacing state;
- WASM and Tauri expose equivalent operations and outputs;
- invalid requests return typed errors without replacing active state; and
- schema-v4 fixtures and verification gates pass.

It does not absorb HPA-338, HPA-340, HPA-345, or HPA-350. Those issues consume
the contracts established here.

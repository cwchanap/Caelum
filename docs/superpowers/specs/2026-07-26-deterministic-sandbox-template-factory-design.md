# HPA-339: Deterministic Sandbox Template Factory

**Status:** Revised after topology review; awaiting written-spec approval

**Linear:** [HPA-339](https://linear.app/cwchanap/issue/HPA-339/add-a-deterministic-sandbox-template-factory-with-blank-grid-and)

## Outcome

New-city creation can ask the Rust core for a complete initial sandbox snapshot
from a stable template identifier and explicit creation settings. Repeating the
same request produces an equal snapshot with stable IDs in the browser and
Tauri hosts.

HPA-339 ships two 28×18 templates:

- **Blank Grid** contains no authored city entities.
- **Crossroads** contains the current paired one-way arterial network. Its
  existing automatically discovered center junction is promoted from
  best-effort scenario setup to a required template invariant and verified for
  every straight, left, and right movement.

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

The four authored sequences overlap at the 2×2 center.
`connect_authored_sequence()` delegates each adjacent pair to `connect()`,
which writes both the requested heading and its reciprocal onto the neighboring
tile. The overlapping sequences therefore leave every center tile with North,
East, South, and West road connections. The subsequent
`refresh_all_automatic_junctions()` already discovers a stable 2×2 automatic
junction with eight ports, and `RoadTopology::compile()` exposes the required
four straight, four left-turn, and four right-turn movements.

The current gap is enforcement rather than geometry. Scenario construction
treats automatic-junction refresh as best-effort: an unexpected failure is only
surfaced by `debug_assert!` and degrades to a map without the structure in a
release build. There is also no explicit verification of the required movement
matrix, and the source comment describing the cross as a non-routable visual
scaffold is stale. HPA-339 turns the existing routable layout into a validated
template contract with typed failure.

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
   inbound approaches, yielding 12 required center movements. The shared
   automatic-junction compiler also exposes four same-side U-turn transitions;
   retaining or changing that general compiler behavior is outside HPA-339.
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
- Enforce and verify Crossroads routability for all 12 required center
  movements.
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
`Crossroads`, because it is the canonical successor identifier for the current
arterial map. Their `ScenarioConfig.name` may remain `"Growing Suburb"`;
scenario identity and sandbox template identity are distinct.

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
the public fields primitive lets Rust classify unknown strings and invalid
numbers. Host-side enum or integer deserialization must not turn an unknown
template, fractional capital, or invalid number into an opaque Tauri or WASM
transport failure.

The Rust raw request represents both numeric fields as `Option<f64>` (or an
equivalent missing/null-aware raw value) until validation. WASM preserves
JavaScript non-finite numbers as `f64`; Tauri IPC serializes them through JSON,
where `NaN` and positive or negative infinity arrive as `null`. The Tauri
command therefore accepts nullable raw numeric fields and maps `null` or
missing values to the corresponding typed invalid-value code instead of
failing command argument deserialization.

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
  | "unknownEconomyPreset"
  | "invalidStartingCapital"
  | "invalidDemandMultiplier"
  | "unknownMoveInRate"
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
text. WASM non-finite numeric values use canonical diagnostic strings such as
`"NaN"`, `"Infinity"`, and `"-Infinity"` so error serialization itself remains
valid. Tauri has already normalized those values to `null`, so it reports the
canonical attempted value `"null"`. Exact cross-host context equality is
required only for JSON-representable raw requests; the corresponding typed
error code remains required for null-normalized non-finite input.

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
through `connect_authored_sequence()`, including reciprocal neighbor headings.
Crossroads reuses that behavior unchanged for all four complete arterial lines.

The center footprint is:

```text
(14,8) (15,8)
(14,9) (15,9)
```

After authoring the arms, the template calls
`refresh_all_automatic_junctions()`. This is a required factory step rather than
best-effort repair: a refresh failure becomes
`templateInvariantViolation`, and requested construction returns no snapshot.
The factory does not duplicate structure ownership, port capture, ordering, or
junction-ID generation. The shared refresh pass remains the sole producer of
automatic-junction identity, which also guarantees that the first player road
edit cannot silently rewrite a hand-authored variant.

The resulting automatic junction must have the exact canonical footprint above,
eight ordered ports, stable shared-refresh ID, and `one_way: None` on all four
owned center tiles. These facts are validated after refresh and captured by the
template characterization.

### 4.4 Required movement matrix

Crossroads has four accepted inbound and four accepted outbound ports. An
automatic-junction transition is port-to-port: its entry state is the owned
port tile with `incoming_heading = opposite(entry.edge)`, and one transition
spans the complete 2×2 structure to the tile immediately outside the selected
exit port. It does not produce per-tile internal steps.

From each inbound port, the required matrix contains:

- the opposite outbound arm as `Straight`;
- one adjacent outbound arm as `RightTurn`; and
- the other adjacent outbound arm as `LeftTurn`.

This produces 12 required non-U-turn movements. The general automatic-junction
compiler also emits the accepted same-side entry/exit pair as a U-turn, for 16
current transitions in total. HPA-339 validates the required 12 as a subset and
does not reject the additional U-turn transitions or change shared terminal
reversal behavior.

The factory compiles `RoadTopology` before returning. A private pure invariant
validator queries the compiled topology through the existing public
`transition_for()` method for the required matrix and rejects an invalid
built-in template with `templateInvariantViolation`. `transition_for()` is
marked `#[doc(hidden)]`, but it is already a production query used by the
network layer; HPA-339 does not add a second topology-inspection API. This makes
the routing graph—not visual tile occupancy—the acceptance oracle, while the
pure validator can be unit-tested with an intentionally malformed candidate
without a production injection hook.

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

Changing `GameEngine::reset()` to return a result requires updating every direct
caller rather than only the two hosts. The inventory includes the Rust
`engine_topology` reset test, the WASM wrapper, Tauri `game_reset`, the shared
TypeScript backend signature, both backend adapters, the runtime reset queue,
and their corresponding contract tests.

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

`serde_wasm_bindgen` may pass non-finite JavaScript numbers into the raw
`Option<f64>` values. They reach core validation and produce typed errors.
The WASM reset method delegates to the mode-aware engine reset and serializes
`SandboxResetError` on failure. The WASM backend distinguishes serialized
sandbox errors from unexpected JavaScript/serialization failures.

### 6.3 Tauri

Tauri adds a `game_create_sandbox` command. The command constructs a complete
candidate engine before replacing managed state. It acquires the managed lock
only for the final swap, so invalid input and template defects leave the
current engine unchanged and cannot poison the mutex through a panic.
Both creation and reset use a Tauri-only command error transport:

```rust
#[derive(Serialize)]
#[serde(untagged)]
enum TauriCommandError<E> {
    Domain(E),
    Host(String),
}
```

`game_create_sandbox` returns
`Result<GameSnapshot, TauriCommandError<SandboxCreationError>>`, and
`game_reset` delegates to the same mode-aware reset and returns
`Result<GameSnapshot, TauriCommandError<SandboxResetError>>`. Core
creation/reset errors use `Domain` and therefore reach JavaScript as the plain
serialized Rust error object. Mutex failures use `Host` and reach JavaScript as
strings. Tauri/framework serialization failures remain unexpected command
rejections. The adapters recognize only the domain object; strings and other
unrecognized rejection values are rethrown as host failures.

The command-facing raw request keeps numeric fields nullable so JSON-normalized
non-finite values reach core validation as `None` rather than failing before a
typed creation error can be produced.

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
the corresponding `{ ok: false, error }` variant. Because WASM `Err` values and
Tauri command rejections arrive as untyped JavaScript values, recognition uses
explicit `isSandboxCreationError` and `isSandboxResetError` guards. Each guard
requires a plain object, a `context` object, and membership in the complete
known code set for that operation. Every recognized optional context field must
also have its declared primitive or enum type when present:

- creation `field`, `attemptedValue`, and `templateId` values are strings; and
- reset `gameMode` is `"sandbox"` or `"campaign"`, while reset `templateId` is
  `"blankGrid"` or `"crossroads"`.

Unknown extra context fields may be ignored for forward compatibility, but a
known code paired with a malformed recognized field does not become a domain
result. Unexpected transport, serialization, module-loading, or mutex failures
still reject the promise. Adapters do not validate template geometry,
reinterpret settings, or manufacture fallback snapshots.

This discriminated-result convention applies only to sandbox creation and reset
in HPA-339. Existing `loadSnapshot` schema/gameplay failures retain their
current rejected-promise shape; changing that established host contract is
outside this issue.

`RuntimeSnapshot` adds a non-fatal
`sandboxResetError: SandboxResetError | null` lifecycle channel. The existing
runtime reset path commits the returned snapshot, recreates UI state, and clears
that channel only for `ok: true`. For `ok: false`, it publishes the typed reset
error while preserving the current `GameState`, `UiState`, gameplay rejection,
and null `backendError`. It does not set the runtime's fatal `dead` flag or stop
the animation loop, so later commands remain usable. The error stays available
until the next successful reset; HPA-345 may add player-facing dismissal when
it adds the New City workflow.

An unexpected reset promise rejection continues through the existing fatal
`failBackend` path. Runtime tests distinguish these cases by proving that a
typed reset failure preserves state and UI, leaves the runtime running, and
allows a subsequent backend command, while an unexpected rejection sets
`backendError` and stops further backend work.

HPA-339 exposes `createSandbox` at the backend boundary but does not add a
corresponding `RuntimeController` method or player-facing New City flow.
HPA-345 owns that workflow.

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
- the exhaustive `SANDBOX_TEMPLATE_LABELS` mapping in
  `src/runtime/runtimeSelectors.ts`;
- Rust and TypeScript schema constants;
- snapshot fixtures;
- backend normalization tests;
- unsupported-schema expected versions;
- default-start characterizations;
- sandbox scenario-name expectations in `tests/ui/hudPanels.test.ts`,
  `tests/ui/appShell.test.ts`, and
  `tests/runtime/runtimeSelectors.test.ts`;
- the shared map-dimension module by renaming
  `src/scenario/growingSuburb.ts` to `src/scenario/sandbox.ts` and updating its
  imports and header comment; and
- the sandbox and current-architecture descriptions in `CLAUDE.md` and
  `docs/architecture.md`.

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

Rust tests assert that `create_initial_snapshot()` and `GameEngine::new()`
produce the same snapshot as the canonical default Crossroads request.
Campaign helper tests assert that `growing_suburb_campaign()` reuses those
Crossroads sandbox settings while retaining campaign mode and the
`"Growing Suburb"` scenario name. Default WASM/Tauri constructor parity is
verified at the host boundary in section 8.7.

### 8.2 Characterization fixtures

Check in compact, reviewable template characterizations rather than duplicating
a full 504-tile snapshot blindly. Each characterization records:

- map width and height;
- ordered tile IDs;
- every non-default tile fact;
- road structures, footprints, ports, and IDs;
- `one_way: None` on every automatic-junction-owned center tile;
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
- `one_way: None` on all four center tiles;
- stable automatic-junction ID and ordered ports;
- successful topology compilation;
- all 12 required straight/left/right transitions with their exact
  `MovementKind`.

Routeability tests use `RoadTopology` states or route resolution rather than
checking only that road tiles exist. The factory assertion treats those 12
transitions as a required subset; it does not require the absence of the four
same-side U-turn transitions currently supplied by the shared compiler.

### 8.5 Validation and atomicity

Test every creation error code, including:

- unknown template ID;
- unknown economy preset;
- negative, fractional, greater-than-`i32::MAX`, NaN, and infinite capital;
- zero, negative, NaN, and infinite demand multipliers; and
- unknown move-in rate.

For host and engine replacement operations, assert that a failed request leaves
the previous snapshot unchanged. Backend adapter tests also assert that expected
Rust domain errors become `{ ok: false, error }`, while unrelated host failures
still reject.

Exercise `templateInvariantViolation` through the module-private invariant
validator with an intentionally malformed Crossroads candidate, including a
missing required movement. This tests the typed mapping without exposing a
production test-injection API.

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

Parity is proved at the real host boundaries, not by supplying expected
snapshots through adapter mocks.

Real built-artifact WASM tests submit representative JSON-representable raw
requests through the generated module, then compare the complete normalized
snapshot, typed error code/context, and reset result with the core factory
contract. They also assert that failed creation does not replace the active
local engine.

Real Tauri command tests use the existing `tauri::test::mock_builder` and
`get_ipc_response` harness. They invoke `game_create_sandbox`, `game_reset`, and
`game_snapshot` through IPC and compare decoded complete snapshots with direct
core factory results for the same requests. Those tests cover:

- default and representative non-default Blank Grid and Crossroads requests;
- successful managed-engine replacement and exact-request reset;
- typed invalid and nullable-input creation errors;
- typed campaign reset rejection;
- unchanged managed state after every typed failure; and
- string-shaped unexpected host errors separately from object-shaped domain
  errors.

For JSON-representable inputs, the real WASM and Tauri tests use the same
request cases and require identical normalized snapshots and domain
code/context values. Non-finite WASM inputs and their Tauri `null` equivalents
are tested separately for the same typed code because JSON has already
discarded the original non-finite value before Rust receives the Tauri request.

Mocked TypeScript backend tests remain responsible only for operation names,
request forwarding, local-engine replacement timing, reset forwarding,
domain-result normalization, and preservation of unexpected promise
rejections. They prove that only the complete known creation/reset code sets
with well-typed recognized context fields pass the domain-error guards. Cases
include an unknown code, a non-object context, and a known code with a malformed
recognized field; each remains an unexpected rejection. Mocked `invoke`
responses are not accepted as Tauri host-parity evidence.

Host-boundary tests also assert that the default WASM constructor and Tauri
managed default snapshot equal the canonical default Crossroads factory result.
This parity assertion does not live only in Rust factory tests.

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

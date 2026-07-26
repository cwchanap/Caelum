# HPA-337: Sandbox Rules and Optional Campaign Objectives

**Status:** Revised after review; awaiting written-spec approval

**Linear:** [HPA-337](https://linear.app/cwchanap/issue/HPA-337/model-sandbox-rules-and-optional-campaign-objectives-in-the-shared)

## Outcome

The Rust-owned snapshot distinguishes the open-ended sandbox from optional
campaign rules. A fresh game is a Standard Sandbox that keeps simulating and
collecting metrics without automatic growth, win, or loss. Explicit campaign
snapshots can opt into the existing objective thresholds and scheduled growth
waves.

This is the first implementation slice under HPA-331. It establishes the shared
wire contract that HPA-338 will use for cost policy and HPA-339 will extend with
additional deterministic templates.

## Current State

`GameSnapshot` currently carries a `ScenarioConfig` containing a required
`ObjectiveThresholds` and a growth-wave list. `create_initial_snapshot()` builds
the player-driven Growing Suburb start with no growth waves, but it still
attaches objectives. Advancing far enough can therefore move metrics from
`running` to `won` or `lost`, even though the shipped experience is documented
as a sandbox.

The current objective evaluator also reads module constants rather than the
threshold object serialized in the snapshot. The frontend presents those
serialized values as authoritative, so the evaluation and presentation
contracts can drift.

## Goals

- Add Rust-owned `GameMode` and `EconomyPreset` wire types.
- Persist the underlying sandbox template, demand multiplier, and move-in-rate
  selection.
- Make campaign objectives optional and absent from the default sandbox.
- Keep metrics collection active in sandbox while preventing terminal states.
- Restrict scheduled growth to explicit campaign mode.
- Make campaign evaluation use the thresholds serialized in the snapshot.
- Keep WASM, Tauri, TypeScript backend, and TypeScript domain shapes identical.
- Update the Brief to identify the default game as Standard Sandbox.
- Reject invalid new enum and numeric values at the Rust deserialization
  boundary.

## Non-goals

- Creative-mode cost bypass; HPA-338 owns cost policy.
- Additional maps or template construction; HPA-339 owns the template factory.
- Save envelopes, durable storage, migration, or restoration; HPA-340 onward
  own persistence.
- Population occupancy or active move-in behavior; Phase 2 owns those systems.
- New campaign content or player-facing campaign selection.
- General validation of every existing snapshot number and relationship.
- Numeric validation of fields other than `ObjectiveThresholds` and
  `DemandMultiplier`; HPA-337 requires only structural presence or explicit
  absence for those other fields.

> **Amendment (post-implementation):** During implementation the scope was
> narrowed to also enforce wire-level range and finiteness validation on every
> `ObjectiveThresholds` field, via validated newtypes (`MaxLateRatio`,
> `MaxUnservedRatio`, `MaxAverageWaitSeconds`, `RollingWindowSeconds`,
> `SurvivalTimeSeconds`). Invalid values are rejected at the Rust
> deserialization boundary rather than coerced at evaluation time. This
> supersedes the original §3.2 "does not add wire-level range or finiteness
> rejection" clause and the §3.3 runtime finiteness fallback for
> `rolling_window_seconds` (the newtype makes non-finite/non-positive values
> unreachable, so the 300-second fallback now applies only when objectives are
> inactive or absent, never to a present-but-invalid configured window).
> Stakeholders accepted this tighter contract on review.

## 1. Authoritative Snapshot Model

### 1.1 Rules are separate from campaign content

Add one required `rules` object to `GameSnapshot`:

```typescript
interface GameRules {
  gameMode: "sandbox" | "campaign";
  economyPreset: "standard" | "creative";
  sandbox: SandboxSettings;
}

interface SandboxSettings {
  templateId: "growingSuburb";
  demandMultiplier: number;
  moveInRate: "paused";
}
```

The Rust model uses these concrete types:

- `GameMode::{Sandbox, Campaign}`
- `EconomyPreset::{Standard, Creative}`
- `SandboxTemplateId::GrowingSuburb`
- `MoveInRateSelection::Paused`
- `DemandMultiplier`, a validated numeric newtype serialized through `f64`
  conversions
- `SandboxSettings`
- `GameRules`

All new enums use `#[serde(rename_all = "camelCase")]`, matching the
TypeScript wire strings such as `"growingSuburb"`. `DemandMultiplier` uses
`#[serde(try_from = "f64", into = "f64")]`, so it remains a plain number
rather than a nested object while its deserializer goes through the validated
conversion.

`GameRules` is nested instead of flattening three unrelated fields onto the
already-large snapshot. It also stays separate from `ScenarioConfig`, whose
purpose is authored scenario identity plus optional campaign objectives and
growth events.

`rules.sandbox` is present for both modes. A future campaign layers authored
rules over the same city simulation and therefore still needs a template and
demand settings.

### 1.2 Closed enums establish stable identifiers

HPA-337 defines only identifiers whose behavior exists:

- `SandboxTemplateId` initially serializes only `"growingSuburb"`. HPA-339 adds
  `"blankGrid"` and `"crossroads"` to this same type.
- `MoveInRateSelection` initially serializes only `"paused"`. Phase 2 adds
  operational rates when deterministic occupancy exists.

Unknown enum strings fail Rust deserialization. The TypeScript unions mirror
the Rust wire strings exactly.

### 1.3 Demand multiplier validation

`DemandMultiplier` serializes as a JSON/JS number. Implement `TryFrom<f64>` to
accept only finite values greater than zero, and implement
`From<DemandMultiplier> for f64` for serialization. The Serde
`try_from`/`into` attributes use those same conversions, so direct
construction and deserialization share one validation rule. The default is
`1.0`. The newtype derives `Clone` and `Copy`, which also satisfies Serde's
owned `into` conversion without changing the wire shape.

Zero is not a hidden no-demand mode. Population growth is represented by
`moveInRate`, while demand strength remains a positive multiplier. TypeScript
keeps a plain `number` and is not an independent gameplay validator.

### 1.4 Objectives become optional

`ScenarioConfig.objectives` changes from `ObjectiveThresholds` to
`Option<ObjectiveThresholds>`, serialized as either the existing threshold
object or `null`. Do not add `skip_serializing_if` to this field:
`serde_json`/Tauri must emit the key with `null` for `None`. Section 4 defines
the equivalent WASM boundary normalization.

The default configuration is:

```json
{
  "schemaVersion": 3,
  "rules": {
    "gameMode": "sandbox",
    "economyPreset": "standard",
    "sandbox": {
      "templateId": "growingSuburb",
      "demandMultiplier": 1.0,
      "moveInRate": "paused"
    }
  },
  "scenario": {
    "name": "Growing Suburb",
    "objectives": null,
    "growthWaves": []
  }
}
```

This snapshot identifies the map template independently from the player-facing
mode/preset label.

The rules-and-scenario portion of an explicit campaign snapshot retains the
same underlying sandbox settings while adding authored objectives:

```json
{
  "schemaVersion": 3,
  "rules": {
    "gameMode": "campaign",
    "economyPreset": "standard",
    "sandbox": {
      "templateId": "growingSuburb",
      "demandMultiplier": 1.0,
      "moveInRate": "paused"
    }
  },
  "scenario": {
    "name": "Growing Suburb",
    "objectives": {
      "maxLateRatio": 0.25,
      "maxUnservedRatio": 0.2,
      "maxAverageWait": 180.0,
      "rollingWindowSeconds": 300.0,
      "survivalTime": 1200.0
    },
    "growthWaves": []
  }
}
```

### 1.5 Explicit campaign authoring

`scenario.rs` exposes the standard objective values independently from the
campaign constructor:

```rust
pub fn growing_suburb_objectives() -> ObjectiveThresholds
```

The helper constructs thresholds from the existing public objective constants.
This keeps the constants available for authored defaults without making the
objective evaluator consult them directly.

The module also exposes one construction path for authored Growing Suburb
campaigns:

```rust
pub fn growing_suburb_campaign(
    objectives: ObjectiveThresholds,
    growth_waves: Vec<GrowthWave>,
) -> (GameRules, ScenarioConfig)
```

The returned rules always use `GameMode::Campaign`,
`EconomyPreset::Standard`, `SandboxTemplateId::GrowingSuburb`, demand
multiplier `1.0`, and `MoveInRateSelection::Paused`. The returned scenario
uses the Growing Suburb name, wraps the supplied thresholds in `Some`, and
preserves the supplied growth waves in their authored order.

This helper is the shared authoring and test-fixture path for campaigns with
objectives, not a new player-facing campaign-selection API. A campaign that
intentionally omits objectives can construct the same campaign rules with
`ScenarioConfig { objectives: None, ... }`.

Standard campaign fixtures call
`growing_suburb_campaign(growing_suburb_objectives(), growth_waves)`. Tests
that intentionally exercise custom thresholds continue to pass those
thresholds directly.

Retain `growing_suburb_scenario()` and change its meaning to the default
sandbox scenario: Growing Suburb name, `objectives: None`, and no growth
waves. `create_initial_snapshot()` constructs Standard Sandbox rules and
continues to call `growing_suburb_scenario()`. It does not call
`growing_suburb_campaign`.

### 1.6 Settings intentionally inert in this slice

HPA-337 establishes and validates the rules contract without inventing
downstream systems:

- `EconomyPreset::Creative` has no gameplay consumer in this slice. Its only
  observable difference is the `Creative Sandbox` Brief title; HPA-338 adds
  creative cost behavior.
- `SandboxTemplateId::GrowingSuburb` records the template that produced the
  current map, but it does not dispatch through a template factory until
  HPA-339.
- `DemandMultiplier` is validated and persisted but is not applied to a
  move-in or demand-generation formula in this slice.
- `MoveInRateSelection::Paused` carries the chosen future move-in policy, but
  no simulation code branches on it until deterministic occupancy exists in
  Phase 2.

### 1.7 Rules and scenario combinations

HPA-337 validates the individual wire values but does not add relationship
validation between `rules` and `scenario`. Every structurally valid
combination is accepted:

| Combination | Objective behavior | Growth behavior |
| --- | --- | --- |
| Sandbox plus objectives | Objectives are inert | No change |
| Sandbox plus growth waves | No change | Waves remain unapplied |
| Campaign without objectives plus waves | No win/loss evaluation | Due waves apply |
| Campaign with objectives but no waves | Thresholds evaluate | No automatic growth |

The runtime gates are mode-based. Sandbox-attached objective and growth
content is ignored, including for outcome-history retention. No
`GameplayRejection` is introduced for these combinations. Invalid enum
strings, invalid `DemandMultiplier` values, missing required fields, and
unsupported schema versions still fail at their documented Rust boundaries.

Metrics terminality remains authoritative independently of mode.
`tick_trips_substepped` checks `metrics.state` before advancing the clock or
evaluating mode-specific behavior, so an imported schema-v3 sandbox snapshot
whose metrics are already `won` or `lost` remains frozen. HPA-337 does not
reopen or recover terminal snapshots; persistence validation and migration
remain HPA-340 concerns.

## 2. Schema and Boundary Handling

Increment `SNAPSHOT_SCHEMA_VERSION` from `2` to `3` in Rust and TypeScript.
Schema-v3 `rules`, `scenario`, `scenario.objectives`, and
`scenario.growthWaves` are required keys. `scenario.objectives` may contain
`null`, but it may not be omitted. Remove the current snapshot-level
`#[serde(default = "default_scenario")]` and scenario-level
`#[serde(default)]` for `growth_waves`; do not add serde defaults that guess
the new rules or scenario content for an older payload. Delete the
now-unreferenced private `default_scenario()` helper after removing its only
Serde attribute caller.

Because Serde normally treats a missing `Option<T>` field as `None`,
`scenario.objectives` uses `#[serde(deserialize_with = "...")]` with a
presence-enforcing field deserializer that delegates to
`Option::<ObjectiveThresholds>::deserialize`. Explicit `null` and a present
JavaScript `undefined` become `None`, while an object becomes
`Some(ObjectiveThresholds)`. Because the field has no Serde default, an
omitted key never invokes the field deserializer and remains a missing-field
error. Existing defaults on unrelated snapshot fields, including
`trip_sequence_day`, `next_trip_sequence`, transit-node status, and metric
outcome history, remain unchanged and are outside this schema slice.

Consequences:

- Fresh Rust snapshots always emit the complete schema-v3 shape.
- TypeScript normalization rejects any schema other than `3`.
- A Rust `GameSnapshot` supplied to `GameEngine::from_snapshot` with another
  schema version receives the existing unsupported-schema rejection.
- A raw older or malformed payload that lacks schema-v3 fields fails
  deserialization rather than being silently upgraded.
- HPA-340 remains responsible for typed persistence-load errors, full snapshot
  validation, and any deliberate migration policy.

WASM and Tauri do not define parallel rules models. Both deserialize and
serialize the same `caelum-core` types, so invalid enum values and invalid
`DemandMultiplier` values fail at the Rust boundary before TypeScript
normalization. These malformed raw values surface as serde/host-call
deserialization errors, not as `GameplayRejection`. The existing
`GameplayRejection::unsupported_snapshot_schema` remains reserved for a
successfully deserialized `GameSnapshot` whose `schema_version` is not `3`.

## 3. Tick and Campaign Behavior

### 3.1 Metrics and objectives are separate stages

The trip pipeline continues to advance trips and update metrics in every mode.
After each deterministic substep, objective evaluation follows this order:

1. Return unchanged if metrics are already terminal.
2. Return unchanged unless `rules.game_mode == GameMode::Campaign`.
3. Return unchanged when `scenario.objectives` is `None`.
4. Evaluate the supplied `ObjectiveThresholds`.

The sandbox therefore remains `running` beyond the former survival threshold,
even if it has completed or failed trips. Coarse and fine ticks continue to
produce equivalent metric state. Because objective evaluation never
terminalizes a running sandbox, a coarse sandbox tick consumes its full
requested delta instead of stopping at the former survival threshold.

### 3.2 Serialized thresholds become authoritative

`evaluate_objectives` and its rolling counts use fields from the snapshot's
`ObjectiveThresholds`:

- `max_late_ratio`
- `max_unserved_ratio`
- `max_average_wait`
- `rolling_window_seconds`
- `survival_time`

The existing threshold constants remain public so
`growing_suburb_objectives()` can use them as the standard Growing Suburb
campaign authoring defaults. They are no longer consulted directly during
objective evaluation. `ROLLING_WINDOW_SECONDS` also supplies the 300-second
history-retention fallback for snapshots without a usable active campaign
window, but it does not score or terminate those snapshots.

HPA-337 enforces wire-level range and finiteness validation on every
`ObjectiveThresholds` field via validated newtypes (see the Non-goals
amendment). Each field is a `validated_threshold_newtype!` (`MaxLateRatio`,
`MaxUnservedRatio`, `MaxAverageWaitSeconds` require finite and non-negative;
`RollingWindowSeconds`, `SurvivalTimeSeconds` require finite and strictly
positive). Invalid values are rejected at the Rust deserialization boundary
as serde deserialization errors (see §2), not as `GameplayRejection` —
`GameplayRejection::unsupported_snapshot_schema` remains reserved for a
successfully deserialized `GameSnapshot` whose `schema_version` is not `3`.
Bad authoring therefore fails loudly at load instead of being silently
coerced at evaluation time. Custom-threshold tests use valid finite values;
rejection tests cover NaN, infinity, negative, and (where applicable) zero
values. The rolling window
newtype also replaces the §3.3 point-of-use finiteness guard — the configured
value is guaranteed usable, so `effective_rolling_window_seconds` returns it
directly and the 300-second fallback applies only when objectives are
inactive or absent.

### 3.3 Metrics history remains bounded

Lifetime counters, total wait, current waiting count, and average wait continue
to update in sandbox.

Change `prune_trip_outcomes` to accept the retention window explicitly:

```rust
pub fn prune_trip_outcomes(
    outcomes: &mut Vec<TripOutcome>,
    current_time: f64,
    retention_window_seconds: f64,
)
```

The trip pipeline derives one effective retention window. It considers the
serialized `rolling_window_seconds` only when the snapshot is in campaign mode
and objectives are present. Because `RollingWindowSeconds` is a validated
newtype (finite and strictly positive, enforced at the deserialization
boundary — see §3.2), the configured value is used directly. Sandbox mode and
campaigns without objectives use the existing `ROLLING_WINDOW_SECONDS`
fallback of 300 seconds. A present-but-invalid configured window is
unreachable: it is rejected at load before the trip pipeline ever runs.

`objective_counts` accepts `rolling_window_seconds: f64`, and both
`prune_trip_outcomes` and `evaluate_objectives` receive the same effective
value. Evaluation must not re-read the serialized field after the trip
pipeline has selected the window.

Therefore the recent `trip_outcomes` sample uses:

- the campaign objective's `rolling_window_seconds` when campaign objectives
  exist (guaranteed finite and greater than zero by the newtype);
- the existing 300-second retention window in sandbox and when campaign
  objectives are absent.

This keeps sandbox metrics bounded and inspectable while retaining enough
campaign history to evaluate its configured window. In particular, a
600-second campaign window cannot be truncated to 300 seconds before
evaluation. Rejection tests at the deserialization boundary cover zero,
negative, NaN, and infinity and prove such snapshots never reach evaluation.

### 3.4 Growth waves are campaign-only

`apply_due_growth_waves` returns without applying events unless the snapshot is
in campaign mode. The default sandbox also serializes an empty list, so both
the data and execution contract express the product rule.

Growth-wave tests that exercise authored events must construct an explicit
campaign snapshot. A campaign may omit objectives and still run authored
growth; optional objectives and scheduled events are independent campaign
features.

## 4. TypeScript and Host Data Flow

Update `RustGameSnapshot`, domain `GameState`, and their nested types to mirror
schema version 3:

- `rules: GameRules`
- raw
  `RustScenarioConfig.objectives: RustObjectiveThresholds | null | undefined`
- normalized `Scenario.objectives: ObjectiveThresholds | null`
- the existing Rust-owned `scenario.growthWaves`

The `undefined` union member on the raw Rust interface models a transport
detail, not an optional schema-v3 key:

- `serde_json`/Tauri serializes Rust `None` as `"objectives": null`;
- the repository's default `serde_wasm_bindgen::to_value` serializer exposes
  Rust `None` as JavaScript `undefined`;
- Rust deserialization still requires the field as described in Section 2.

Keep the current global WASM serializer unchanged. Changing it to serialize
every missing value as `null` would broaden HPA-337 to unrelated `Option`
fields.

`normalizeRustSnapshot()` passes `rules` through unchanged and maps the known
scenario fields explicitly while canonicalizing only the transport
representation:

```typescript
scenario: {
  name: snapshot.scenario.name,
  objectives: snapshot.scenario.objectives ?? null,
  growthWaves: snapshot.scenario.growthWaves,
}
```

This follows the existing `parkedPosition ?? null` boundary pattern.
Normalization does not invent threshold defaults, rules, or growth events.
The explicit mapping preserves the boundary's current behavior of discarding
unknown raw scenario properties.
The canonical `GameState` shape is therefore identical for WASM and Tauri even
though their raw `None` encodings differ.

The runtime remains the boundary owner:

```text
caelum-core GameSnapshot
  -> WASM or Tauri backend
  -> RustGameSnapshot
  -> normalizeRustSnapshot
  -> GameState
  -> runtime selectors
  -> Svelte presentation
```

No new TypeScript-only error interpretation or fallback state is introduced.
Backend failures from operations after runtime creation continue through the
runtime's existing `backendError` path. Initial backend construction,
`backend.snapshot()`, or snapshot normalization may reject before a
`RuntimeSnapshot` exists; HPA-337 does not convert those startup failures into
`GameplayRejection` or synthesize a fallback runtime state.

## 5. Brief Presentation

Extend `ShellBriefState` with `context: string`, render that field in the
context row, and remove `BriefPanel.svelte`'s hard-coded `Scenario · 001`.

Keep the existing internal field names and map the rendered labels as follows:

- Goal renders `shell.objective`.
- Note renders `shell.lossNote`.
- Wave renders `shell.nextGrowth`.

`formatObjective` accepts a non-null `ObjectiveThresholds` value rather than a
whole `GameState`. Runtime selectors call it only for a campaign with
objectives, so sandbox selection cannot dereference `null`.

The selector contract is:

| Mode | `title` | `context` | `objective` | Default `lossNote` | `nextGrowth` |
| --- | --- | --- | --- | --- | --- |
| Standard sandbox | `Standard Sandbox` | `Template · Growing Suburb` | `Open-ended city — no campaign objective.` | `Metrics continue without win/loss.` | `No automatic growth` |
| Creative sandbox | `Creative Sandbox` | `Template · Growing Suburb` | `Open-ended city — no campaign objective.` | `Metrics continue without win/loss.` | `No automatic growth` |
| Campaign with objectives | `scenario.name` | `Campaign · Growing Suburb` | `formatObjective(objectives)` | `Within tolerances. Hold the line.` | Pending wave message or `No automatic growth` |
| Campaign without objectives | `scenario.name` | `Campaign · Growing Suburb` | `No campaign objective.` | `Metrics continue without win/loss.` | Pending wave message or `No automatic growth` |

For every row, a non-null `metrics.lossReason` takes priority over the default
`lossNote`. `status` is `metrics.state.toUpperCase()`, so `RUNNING`, `WON`, and
`LOST` retain their existing casing.

Campaign title selection takes priority over economy preset: a campaign with
`EconomyPreset::Creative` still uses `scenario.name`. Sandbox title selection
uses the economy preset. Campaign context is
`Campaign · ${SANDBOX_TEMPLATE_LABELS[templateId]}`; sandbox context is
`Template · ${SANDBOX_TEMPLATE_LABELS[templateId]}`.

Runtime selectors own a local, exhaustive display-name map:

```typescript
const SANDBOX_TEMPLATE_LABELS: Record<SandboxTemplateId, string> = {
  growingSuburb: "Growing Suburb",
};
```

HPA-339 extends this map with each new template identifier. This slice does
not introduce player-facing localization.

Sandbox growth content remains inert in presentation as well as simulation:
the Wave row always says `No automatic growth` in sandbox even if a malformed
but structurally accepted snapshot contains authored waves. The current
`runtimeSelectors.ts` fallback, `Sandbox: paint areas to grow.`, is removed.

All branching lives in runtime selectors. The Svelte component renders
display-ready strings and does not interpret `GameRules` or optional
objectives.

## 6. Test Strategy

### 6.1 Rust model and wire tests

- The default snapshot is schema 3, Standard Sandbox, `growingSuburb`, demand
  `1.0`, paused move-in, `objectives: null`, and `growthWaves: []`.
- The complete rules object and nullable objectives round-trip through serde.
- `serde_json` emits the required objectives key as `null` for `None`; omitting
  the key fails through the presence-enforcing field deserializer.
- Unknown game mode, economy preset, template, and move-in strings fail.
- The fallible Rust `DemandMultiplier` constructor rejects zero, negative,
  infinite, and NaN values. The `TryFrom<f64>` conversion and Serde
  `try_from`/`into` path reject the same values as deserialization errors when
  the host input format can represent them, while serialization remains a
  plain number.
- Omitting `rules`, `scenario`, `scenario.objectives`, or
  `scenario.growthWaves` fails deserialization; the current test that accepts a
  missing growth-wave list is replaced with a required-field rejection test.
- A schema-2 Rust snapshot is rejected by `GameEngine::from_snapshot`.

### 6.2 Rust behavior tests

- Advancing a sandbox beyond the old survival threshold leaves metrics
  `running` while the tick consumes its full requested delta and metrics
  continue.
- Loss-producing sandbox metrics do not transition to `lost`.
- Loading an already terminal schema-v3 sandbox snapshot preserves the current
  frozen behavior; ticking does not reopen it or advance its clock.
- Growth waves do not fire in sandbox.
- Sandbox-attached objectives do not evaluate and do not replace the default
  300-second outcome-retention window.
- A campaign without objectives still applies due authored growth waves.
- Explicit campaign fixtures preserve the existing late, unserved,
  average-wait, and survival gates.
- Custom campaign thresholds prove evaluation reads snapshot values rather
  than module constants.
- Campaign objective windows of zero, a negative value, NaN, and infinity
  prove pruning and scoring use the same deterministic 300-second fallback.
- Campaign rolling-window behavior remains deterministic across coarse and
  fine ticks.
- Existing objective and growth tests opt into campaign rules explicitly
  instead of relying on `create_initial_snapshot()`.

The existing Rust test migration is explicit:

- In `crates/caelum-core/src/growth.rs`, every test that installs non-empty
  authored waves opts into campaign mode. This includes the `seeded()` helper
  and the direct setup in
  `placement_without_zoning_is_skipped_but_wave_marked_applied`,
  `multiple_waves_in_one_tick_all_fire_in_declared_order`, and
  `mid_tick_wave_fires_at_boundary_regardless_of_granularity`. Empty-wave
  no-op tests may remain sandbox. These tests call `tick_trips` without
  objective evaluation, so using standard campaign thresholds does not alter
  their assertions.
- `crates/caelum-core/tests/objectives_metrics.rs` constructs campaign rules
  for every win/loss threshold test and adds sandbox no-op coverage.
- `crates/caelum-core/tests/trip_lifecycle.rs` marks terminal objective
  scenarios as campaign while leaving ordinary trip lifecycle fixtures at the
  default sandbox.
- `crates/caelum-core/tests/golden_sequences.rs` makes the sequence that
  expects `MetricsState::Won` an explicit campaign instead of weakening the
  expectation.
- `crates/caelum-core/tests/model_wire_format.rs` updates schema expectations,
  adds rules/nullable-objective round trips, and replaces serde-default
  assertions for scenario/growth waves with missing-field rejection.
- `crates/caelum-core/tests/stop_migration.rs` replaces its literal schema-2
  expectation and continues to verify unsupported-schema rejection.
- `src-tauri/src/lib.rs` host tests continue to verify structured
  unsupported-schema rejection with a complete schema-v3 snapshot.

### 6.3 TypeScript, host, and UI tests

- Shared schema-v3 snapshot fixtures default to Standard Sandbox.
- Tauri raw snapshots expose `objectives: null`; WASM raw snapshots expose
  `objectives: undefined`; snapshot normalization canonicalizes both to
  `objectives: null` without adding thresholds.
- A real WASM raw snapshot with a present `objectives: undefined` round-trips
  through `loadSnapshot`, while deleting the key from the same raw snapshot
  fails deserialization as a missing required field.
- Unsupported schema versions remain rejected.
- WASM and Tauri backend contract tests assert equivalent normalized
  schema-v3 shapes.
- Runtime selectors cover Standard Sandbox, Creative Sandbox, a campaign with
  objectives, a campaign without objectives, creative campaign title
  precedence, sandbox-attached inert content, and pending/no growth-wave copy.
- Brief component tests cover the supplied context and open-ended sandbox
  wording.

The concrete TypeScript and host test touchpoints are:

- `tests/fixtures/rustSnapshot.ts` and `tests/helpers/gameState.ts` — schema-v3
  rules plus nullable objectives.
- `tests/runtime/backendContract.test.ts` — raw-to-normalized nullability and
  custom threshold pass-through.
- `tests/runtime/wasmArtifact.smoke.test.ts` — schema-v3 wording, real WASM
  `None` behavior, missing-objective-key rejection, and default sandbox shape.
- `tests/runtime/runtimeSelectors.test.ts` — the complete Brief mapping table.
- `tests/ui/appShell.test.ts` — replace the old sandbox growth fallback.
- `tests/ui/hudPanels.test.ts` — supply and render `ShellBriefState.context`.

### 6.4 Verification commands

Run the repository's normal gates:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
bun run format:check
bun run check
bun run lint
bun run test
bun run build
bun run test:e2e
```

## 7. Expected File Areas

The implementation is expected to remain within these boundaries:

- `crates/caelum-core/src/model.rs` — schema version, new wire types,
  required-but-nullable objectives deserialization, and removal of the
  obsolete `default_scenario()` helper.
- `crates/caelum-core/src/scenario.rs` — retain
  `growing_suburb_scenario()` as the default sandbox, add
  `growing_suburb_objectives()`, and add the explicit campaign authoring
  helper.
- `crates/caelum-core/src/state.rs` — default rules construction.
- `crates/caelum-core/src/objectives.rs` — optional, mode-gated evaluation
  using serialized thresholds and the shared effective rolling window.
- `crates/caelum-core/src/growth.rs` and `trips.rs` — campaign growth gate and
  the validated-at-use metrics-retention window.
- `crates/caelum-core/src/engine.rs` — update the stale schema-v2
  `from_snapshot` documentation.
- `crates/caelum-core/src/growth.rs`,
  `crates/caelum-core/tests/objectives_metrics.rs`,
  `crates/caelum-core/tests/trip_lifecycle.rs`,
  `crates/caelum-core/tests/golden_sequences.rs`, and
  `crates/caelum-core/tests/model_wire_format.rs` — explicit campaign fixture
  migration and schema/behavior coverage.
- `crates/caelum-core/tests/stop_migration.rs` and `src-tauri/src/lib.rs` host
  tests — schema-v3 assertions and structured rejection coverage.
- Other Rust model, scenario, engine, and host contract tests affected by the
  required `rules` field.
- `src/domain/types.ts`, `src/runtime/backend/types.ts`, and
  `src/runtime/snapshotView.ts` — schema-v3 TypeScript parity and WASM
  `undefined` to canonical `null` normalization through explicit scenario
  field mapping.
- `src/runtime/runtimeSelectors.ts`, `src/runtime/types.ts`, and
  `src/components/hud/panels/BriefPanel.svelte` — display-ready sandbox and
  campaign copy.
- `tests/fixtures/rustSnapshot.ts`, `tests/helpers/gameState.ts`,
  `tests/runtime/backendContract.test.ts`,
  `tests/runtime/wasmArtifact.smoke.test.ts`,
  `tests/runtime/runtimeSelectors.test.ts`, `tests/ui/appShell.test.ts`, and
  `tests/ui/hudPanels.test.ts` — schema, host, selector, and Brief parity.
- `docs/architecture.md` — required acceptance follow-through for schema
  version 3, the objective-less default sandbox, and the explicit campaign
  boundary.

No new gameplay authority belongs in TypeScript.

## 8. Acceptance Mapping

| HPA-337 acceptance criterion | Design proof |
| --- | --- |
| Fresh default identifies as Standard Sandbox | Required `rules` defaults plus Brief selector copy |
| Sandbox has no objectives or growth waves | Default `ScenarioConfig { objectives: None, growth_waves: [] }` |
| Sandbox remains running beyond survival | Mode/absence gate before objective evaluation |
| Custom campaign thresholds still work | Explicit campaign fixtures prove serialized values override authoring constants |
| WASM/Tauri/TypeScript shapes match | Raw `undefined`/`null` normalize to one schema-v3 domain shape |
| Invalid enums and multipliers fail in Rust | Closed enums plus `try_from`/`into` validated `DemandMultiplier` |
| Brief identifies mode and template | Supplied `context` plus the selector mapping table |

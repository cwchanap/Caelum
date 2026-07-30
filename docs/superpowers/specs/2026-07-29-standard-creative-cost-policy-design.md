# HPA-338: Standard and Creative Cost Policy

**Status:** Approved for implementation

**Linear:** [HPA-338](https://linear.app/cwchanap/issue/HPA-338/apply-standard-and-creative-cost-policy-to-existing-player-purchases)

## Outcome

Every existing player purchase uses one Rust-owned policy derived from
`GameSnapshot.rules.economy_preset`.

Standard Sandbox preserves the current prices, affordability checks, budget
deductions, rejection payloads, and partial road/track stroke behavior.
Creative Sandbox applies the same geometrically and logically valid mutations,
reports the same nominal costs, never rejects solely because the budget is too
low, and leaves the budget unchanged.

Rust remains the only gameplay authority. Existing WASM and Tauri commands
continue to expose the same snapshot, dispatch, preview, warning, and rejection
wire shapes.

## Current State

HPA-337 added the persisted `GameRules` and `EconomyPreset::{Standard,
Creative}` contract. HPA-339 made Standard and Creative available through the
deterministic sandbox factory, and HPA-340 made schema-v4 snapshots strictly
validated and atomically restorable. The economy preset is therefore available
to every authoritative mutation and survives save/load and reset.

The preset does not yet affect purchases. Cost handling is distributed across
the Rust core:

- roads and road strokes deduct `ROAD_COST`;
- tracks and track strokes deduct `TRACK_COST`;
- bus stops and metro stations deduct their node costs;
- roundabouts deduct the size-specific roundabout cost;
- player-placed buildings deduct the selected building definition's cost;
- route creation deducts the implicit first vehicle's cost; and
- later vehicle assignment deducts the selected mode's vehicle cost.

Most atomic paths directly compare `state.budget < cost`, construct an
`insufficientBudget` rejection, clone the snapshot, and subtract the cost.
Road and track strokes instead spend against a running candidate budget and
skip tiles they cannot afford.

Two current reporting paths depend on those deductions:

- `dispatch_context()` derives `DispatchContext.cost` from the difference
  between the old and new budgets; and
- road preview obtains its cost by executing the road mutation against a
  candidate snapshot.

Route preview independently compares the budget with the implicit first
vehicle's price and exposes `initialVehicleCost`, `affordable`, and either an
insufficient-budget rejection or warning. The TypeScript building hover also
marks an otherwise valid footprint invalid when the displayed budget is below
the catalog price.

If Creative merely stopped subtracting the budget, these reporting paths would
incorrectly report zero cost or reject a commit that the policy should allow.
HPA-338 therefore separates nominal cost from actual budget deduction.

## Approved Decisions

1. A focused, non-serialized Rust cost-policy module owns affordability and
   deduction behavior. It is keyed only by `EconomyPreset`.
2. Nominal cost is reported independently from the amount deducted from the
   budget.
3. Existing Rust price constants and building definitions remain authoritative.
   This slice does not reorganize price catalogs.
4. Atomic purchases remain all-or-nothing. A Standard affordability failure
   commits no world, budget, route, or topology changes.
5. Existing road and track stroke semantics are preserved. A Standard stroke
   processes tiles in order and may commit affordable valid tiles while
   skipping invalid or unaffordable tiles.
6. A fully skipped road or track stroke retains the existing
   `invalidRoadStroke` or `invalidTrackStroke` rejection rather than introducing
   a new whole-stroke insufficient-budget rejection.
7. Creative bypasses only affordability and deduction. Every other validation
   and rejection remains authoritative.
8. Existing affordability-aware previews report Creative as affordable while
   retaining nominal prices.
9. TypeScript may adjust read-only hover presentation from the Rust-owned
   `rules.economyPreset`, but it never authorizes or applies a purchase.
10. No snapshot field, schema-version change, host command, rejection code, or
    warning code is added.

## Goals

- Define one Rust-owned Standard/Creative cost policy.
- Route every existing player purchase through that policy.
- Preserve Standard prices and mutation behavior.
- Keep nominal cost visible in both presets.
- Make Creative purchases budget-neutral.
- Keep preview affordability consistent with commit behavior.
- Preserve invalid-placement, topology, ownership, route, and compatibility
  rejections in Creative.
- Keep core, WASM, Tauri, and TypeScript wire behavior equivalent.
- Prove deterministic Standard/Creative world-state parity.
- Preserve strict schema-v4 persistence and atomic restoration.

## Non-goals

- Recurring operating costs, maintenance, fares, subsidies, or income.
- Negative balances or debt.
- Vehicle variants or different mode prices.
- Changing route creation's implicit first vehicle.
- Changing the prices of any existing purchase.
- Making road or track strokes atomic.
- Charging demolition, area painting, route edits, route metadata changes, or
  road direction changes.
- Charging scenario-authored growth/building placement.
- Adding new preview APIs for tools that do not currently expose affordability.
- Moving price catalogs from their existing modules.
- Changing `SetBudget`'s debug-only contract.
- Adding a player-facing New City flow; HPA-345 owns that workflow.

## 1. Cost Policy

### 1.1 Ownership

Add a focused module under `crates/caelum-core/src/` for purchase policy. The
module owns transient types equivalent to:

```rust
pub(crate) enum CostPolicy {
    Standard,
    Creative,
}

pub(crate) struct CostQuote {
    nominal_cost: i32,
    available_budget: i32,
    affordable: bool,
    deduction: i32,
}
```

`CostPolicy` is constructed from `snapshot.rules.economy_preset`. It is not
stored in `GameSnapshot`, serialized, cached in `GameEngine`, or duplicated in a
host adapter. Deriving it from the active snapshot on each operation makes a
restored Creative save immediately use Creative behavior without host
coordination.

The module exposes one quote path used by both previews and commits. A quote
contains:

- the nominal catalog price;
- the budget visible when the quote was made;
- whether the operation is affordable under the selected preset; and
- the amount that an authorized commit deducts.

The quote can produce the existing `GameplayRejection::budget()` payload when
an atomic Standard purchase is unaffordable, and can apply its deduction to a
candidate budget after authorization. Commit code does not independently
recompute affordability or deduction.

After an atomic quote is authorized, that same quote is threaded to the
candidate update and its `deduction` is applied exactly once. Covered mutation
helpers do not retain direct `candidate.budget -= nominal_cost` operations or
recompute a second quote at the deduction site.

All covered prices are internal non-negative values. The policy may enforce
that invariant with a debug assertion; it does not add a player-visible error
for invalid internal catalog data.

### 1.2 Policy table

| Preset | `affordable` | Atomic authorization | Deduction | Reported cost |
| --- | --- | --- | --- | --- |
| Standard | `budget >= nominal_cost` | Reject when false | `nominal_cost` | `nominal_cost` |
| Creative | Always `true` | Never rejects for budget | `0` | `nominal_cost` |

Creative does not set the nominal cost to zero. The nominal price remains useful
for UI labels, previews, dispatch feedback, tests, and future analytics even
though it is not charged.

### 1.3 Snapshot and persistence behavior

The existing budget remains an `i32` snapshot field and continues to be
validated as non-negative. Standard never deducts without first authorizing the
full atomic cost or the next stroke tile. Creative deductions are always zero,
so a Creative purchase cannot create a negative balance.

No schema-v4 field changes. `snapshot_for_save()`, `from_snapshot()`, sandbox
reset, WASM restoration, and Tauri restoration continue to preserve the stored
budget and economy preset exactly.

The policy is keyed only by economy preset. Current persistence validation
allows Creative only for sandbox mode, but the cost module does not add a
second game-mode switch or duplicate that persistence invariant.

## 2. Nominal Cost Results

### 2.1 Costed mutations

Add an internal result type equivalent to:

```rust
pub(crate) struct CostedMutation {
    pub snapshot: GameSnapshot,
    pub cost: i32,
}
```

Cost-bearing helpers return `GameplayResult<CostedMutation>` instead of losing
the nominal price inside a plain `GameSnapshot`. The existing
`RoadMutationResult` remains specialized because it also owns changed/skipped
tiles, but its `cost` field follows the same nominal-cost contract.

Free mutation helpers may continue returning `GameplayResult<GameSnapshot>`.
The engine wraps them with cost zero where it needs a common commit path.

### 2.2 Engine context

`dispatch_context()` accepts the authoritative nominal cost instead of deriving
cost only from `before.budget - after.budget`. It continues deriving changed
tiles, skipped tiles, and structurally affected route IDs from the two
snapshots. Its contract is equivalent to
`dispatch_context(before, after, requested_tiles, cost)`.

Two existing road-specific budget-delta conversions are explicitly part of
this change:

- `apply_linear_tiles_in_order()` accumulates and returns the nominal price of
  successfully authored paid tiles instead of returning
  `original.budget - candidate.budget`; and
- `normalize_road_mutation_result()` passes `RoadMutationResult.cost` into
  `dispatch_context()` and must not overwrite that cost with a derived budget
  delta.

The normalization change is load-bearing even though road mutations already
carry a cost. `place_roundabout()` sets the correct size-specific
`RoadMutationResult.cost`, but the current normalizer immediately replaces it
with the budget delta. Without preserving the result's explicit cost, an
otherwise correct Creative roundabout reports zero.

The non-road engine paths propagate cost explicitly as well:

- `network_candidate_for_tiles()` accepts a costed mutation, or an equivalent
  explicit cost argument, for tracks, stops, stations, and buildings;
- `commit_result()` and `commit_result_for_tiles()` carry the explicit cost for
  route creation and vehicle assignment; and
- every free intent using those shared helpers supplies or is wrapped with cost
  zero.

All three helpers pass that value to `dispatch_context()` rather than asking it
to inspect the budget. This produces:

- the current positive price for a successful Standard purchase;
- the same positive price for the equivalent successful Creative purchase; and
- zero for free mutations.

Rejected dispatches keep the current default context. Required and available
budget remain on the typed rejection, not on a partially populated success
context.

This changes no wire field. Both hosts already serialize
`DispatchContext.cost`.

### 2.3 Prices remain in their current domains

The policy owns how a price affects the budget, not what each item costs.
Existing authoritative sources remain:

- `ROAD_COST` and `TRACK_COST`;
- bus-stop, metro-station, bus, and metro vehicle constants;
- `roundabout_cost(size)`; and
- `building_definition(building_type).cost`.

This avoids a broad catalog migration and keeps cost selection next to the
domain rules that already choose the purchased item.

## 3. Mutation Integration

### 3.1 Covered purchases

| Purchase path | Nominal cost | Atomicity |
| --- | --- | --- |
| Single road tile | `ROAD_COST` for a newly authored tile | Atomic |
| Road stroke | `ROAD_COST` per newly authored tile | Existing partial semantics |
| Single track tile | `TRACK_COST` | Atomic |
| Track stroke | `TRACK_COST` per newly authored tile | Existing partial semantics |
| Bus stop | `BUS_STOP_COST` | Atomic |
| Metro station | `METRO_STATION_COST` | Atomic |
| Roundabout | `roundabout_cost(size)` | Atomic |
| Player-placed building, including bus terminal | Building definition cost | Atomic |
| New bus/metro route | Implicit first vehicle cost | Atomic |
| Additional assigned vehicle | Mode vehicle cost | Atomic |

Every row uses the same policy quote for Standard and Creative. The world
mutation code is not forked by preset.

The existing transit-node intent paths are all covered:

- `GameIntent::AddBusStop` dispatches to `transit::add_bus_stop()`;
- `GameIntent::AddMetroStation` dispatches to
  `transit::add_metro_station()`; and
- `GameIntent::PlaceBuilding` dispatches to `buildings::place_building()`.

The current UI uses the dedicated transit intents for bus stops and metro
stations and uses `PlaceBuilding` for the bus terminal. The generic
`PlaceBuilding` wire path can also receive the existing bus-stop and
metro-station catalog types, so those compatibility calls must use the same
policy rather than becoming an alternate purchase bypass.

### 3.2 Atomic paths

Replace each direct budget comparison/deduction at its current point with the
policy quote and authorization path. Keeping the policy call at the existing
check site preserves Standard rejection precedence:

- single roads, single tracks, stops, stations, buildings, and vehicle
  assignment continue to evaluate affordability where they do today;
- roundabout placement continues to validate its footprint and port mapping
  before the cost check; and
- route creation continues to validate waypoints and connectivity before the
  implicit vehicle cost check.

Each helper mutates a cloned candidate only after its required validations.
The authorized quote applies its deduction to that candidate and the helper
returns the nominal cost beside the snapshot.

If a later fallible candidate step fails, Rust returns the rejection and the
engine commits neither the candidate nor its deduction. Creative follows the
same candidate construction and can therefore surface every non-budget
rejection that Standard would surface when sufficiently funded.

### 3.3 Partial road and track strokes

Road and track strokes retain ordered per-tile processing.

For each tile that would create new paid infrastructure:

1. validate the tile under the existing stroke rules;
2. quote the per-tile price against the candidate's current budget;
3. in Standard, skip the tile when that quote is unaffordable;
4. in Creative, authorize with a zero deduction;
5. apply the tile mutation; and
6. add the nominal per-tile price to the stroke result's cost.

Existing road tiles updated by a preset continue to cost zero. Invalid,
out-of-bounds, occupied, and structure-owned tiles retain their existing skip
behavior. A repeated road point may re-enter the free existing-road overlay
path, while a repeated track point becomes invalid after the first track is
authored; neither incurs a second charge. A dual-bidirectional road stroke
charges only newly authored tiles across both carriageways, just as Standard
does today.

The nominal stroke cost is accumulated from successfully authored paid tiles,
not inferred from the budget delta. Each map tile can therefore contribute a
paid road or track price at most once per stroke: subsequent road occurrences
see an existing road and subsequent track occurrences see an already tracked
tile. This remains true for host-sent duplicate points and overlapping
dual-carriageway points. The fixed map bounds consequently keep the sum within
the existing `i32` cost contract.

If no tile changes, the existing typed stroke rejection remains unchanged.

### 3.4 Cost-exempt paths

The following remain free and do not call the player-purchase policy:

- road/track/infrastructure removal;
- road direction changes;
- area painting;
- route edits and route metadata changes;
- platform assignment;
- route activation/deactivation and deletion; and
- tick-time simulation work.

`place_building_core()` also remains cost-exempt. Scenario and growth code use
that core helper to author buildings without pretending to be a player
purchase. Only the player-facing `place_building()` wrapper quotes and applies
the building price.

## 4. Preview and Presentation

### 4.1 Road mutation preview

Road preview continues to execute the same authoritative road mutation path
against a throwaway candidate. Because that path uses the policy:

- Standard unaffordable atomic road/roundabout previews retain the existing
  `insufficientBudget` rejection and required nominal cost;
- Creative returns no budget rejection;
- both return the same nominal cost for the same successfully previewed world
  mutation; and
- preview never changes the live snapshot or cached topology.

Invalid placement and topology preview rejections are unchanged. A rejected
roundabout preview continues to report its size-specific attempted cost even
when geometry is invalid.

### 4.2 Route preview

Route preview uses the same policy quote as route creation for the implicit
first vehicle:

- `initialVehicleCost` remains the mode's nominal vehicle price for a create
  draft and zero for an edit draft;
- Standard `affordable` remains the budget comparison;
- Creative `affordable` is always true;
- Standard retains the existing insufficient-budget rejection or warning; and
- Creative emits neither an insufficient-budget rejection nor warning.

Preview does not keep a separate vehicle-price selector. It obtains the mode's
nominal price from the same `transit::vehicle_cost()` helper used by route
creation and vehicle assignment. The underlying constants remain in their
current transit domain.

If route geometry is invalid, Creative still receives the route rejection. A
Creative disconnected route does not add an irrelevant budget warning merely
because the displayed budget is below the nominal first-vehicle cost.

`canSaveRouteDraft()` stays a read-only consumer of Rust's preview response. It
does not learn a Creative exception; Rust expresses that exception through
`affordable: true` and the absence of a budget rejection.

### 4.3 Building hover

Building hover is a best-effort TypeScript presentation surface, not an
authoritative preview API. Two render consumers currently combine local
placement validation with a budget comparison:

- `renderBuildingPreview()` in `src/render/overlayRenderer.ts`; and
- `badgeText()` in `src/render/cursorBadge.ts`.

Add one shared, read-only helper alongside the existing render placement
helpers in `src/render/placementValidation.ts`, equivalent to:

```typescript
export function isBuildingAffordableForPresentation(
  state: GameState,
  buildingType: BuildingType,
): boolean {
  const definition = BUILDING_CATALOG[buildingType];
  return (
    state.rules.economyPreset === "creative" ||
    state.budget >= definition.cost
  );
}
```

Both render consumers combine this helper with the existing
`canPlaceBuilding()` footprint check. `canPlaceBuilding()` remains
geometry-only; affordability does not leak into its existing callers. The
actual click always dispatches `PlaceBuilding` to Rust, which revalidates both
geometry and policy. These presentation branches can remove a false red
Creative hover but cannot make Rust accept a mutation.

Cursor-badge and overlay-preview tests cover the same rule. No generic
TypeScript cost-policy layer is introduced.

### 4.4 Other tool cursors

Road and route have authoritative cost-aware preview responses. Building hover
has an existing local affordability marker. Other current tool cursors do not
claim to preview affordability, so HPA-338 does not add new backend preview APIs
for them.

## 5. Errors and Atomicity

### 5.1 Standard

An unaffordable atomic Standard purchase returns:

- `code: "insufficientBudget"`;
- `context.requiredBudget` equal to the full nominal price; and
- `context.availableBudget` equal to the pre-dispatch budget.

The returned snapshot equals the engine's current snapshot, `applied` is false,
and neither cached topology nor route-derived state changes.

### 5.2 Creative

Creative suppresses only the affordability failure. It still rejects:

- out-of-bounds and blocked placement;
- invalid road and track strokes;
- road, track, and road-access requirements;
- structure ownership and unsafe roundabout port mappings;
- invalid building footprints and zoning;
- missing, duplicate, incompatible, disconnected, inactive, or stale routes;
  and
- invalid platform or vehicle assignment.

Against equivalent snapshots where Standard has sufficient budget, the same
invalid mutation produces the same non-budget rejection and context in both
presets and leaves both snapshots unchanged.

When an operation is simultaneously unaffordable and invalid on an existing
budget-first path, rejection precedence intentionally differs. Standard retains
its current `insufficientBudget` rejection; Creative bypasses only that
affordability gate and reaches the underlying placement, topology, route, or
compatibility rejection. Neither preset commits any candidate state. This
dual-failure behavior preserves Standard semantics without treating Creative as
a validation bypass.

### 5.3 Deterministic world parity

For a geometrically valid purchase that Standard can afford, Standard and
Creative produce equal gameplay world state:

- map and authored topology fields;
- buildings;
- stops, stations, routes, lines, platforms, and vehicles;
- stable IDs;
- sims, trips, metrics, and scenario state; and
- changed/skipped/affected-route dispatch metadata.

Budget-limited partial strokes are explicitly outside this whole-world parity
guarantee. When the total price of valid new tiles exceeds the candidate
Standard budget, both dispatches may apply but their authored worlds
intentionally differ. Standard continues scanning the ordered stroke, skips
unaffordable new tiles, and may still process later free existing-road
overlays; Creative authors every geometrically valid new tile.

The intentional differences are:

- `rules.economyPreset`;
- budget after a charged purchase; and
- policy-derived affordability/deduction state that is not serialized.

For the sufficiently affordable paired cases above, both dispatches report the
same nominal `context.cost`.

## 6. Host Boundaries

The core remains the only implementation of purchase policy. WASM and Tauri
continue forwarding the existing `GameIntent` values to `GameEngine` and
serializing the existing `DispatchResult`, `RoutePreviewResponse`, and
`RoadMutationPreviewResponse` types.

No host-side Creative branch is added. Host work consists of parity and
normalization coverage:

- WASM returns nominal dispatch/preview cost with unchanged Creative budget;
- Tauri returns the same values for the same snapshot and intent;
- nullable warning/rejection fields keep their current normalization; and
- no Creative operation produces an `insufficientBudget` value that TypeScript
  must special-case.

A restored snapshot derives policy from its persisted rules on the next
preview or dispatch. There is no host cache to invalidate.

## 7. Testing Strategy

### 7.1 Policy unit tests

The policy module directly characterizes:

- Standard affordable quote and full deduction;
- Standard unaffordable quote and typed rejection context;
- Creative quote with `affordable == true`, zero deduction, and positive
  nominal cost;
- zero-cost operations in both presets; and
- unchanged budget after applying a Creative quote.

### 7.2 Core purchase matrix

Add deterministic Standard/Creative coverage for:

- a road tile and a multi-tile road stroke;
- a track tile and a multi-tile track stroke;
- a bus stop through `AddBusStop`;
- a metro station through `AddMetroStation`;
- compact and standard roundabouts;
- representative ordinary buildings and the bus terminal through
  `PlaceBuilding`;
- direct `PlaceBuilding` compatibility calls for the existing bus-stop and
  metro-station catalog types;
- bus and metro route creation; and
- additional bus and metro vehicle assignment.

The transit-node compatibility cases include price-drift guards:

- `BUS_STOP_COST` equals `building_definition("busStop").cost`;
- `METRO_STATION_COST` equals
  `building_definition("metroStation").cost`; and
- the dedicated transit intent and `PlaceBuilding` compatibility intent report
  the same nominal `context.cost` for each corresponding node type.

These assertions protect the intentionally separate constant and building
catalog sources without consolidating them.

For each atomic category, a low-budget fixture proves:

1. Standard rejects with `insufficientBudget`;
2. Standard commits no partial entity, map, route, budget, or topology change;
3. Creative accepts the same otherwise-valid mutation;
4. Creative leaves budget exactly unchanged; and
5. Creative reports the nominal cost.

Sufficient-budget paired fixtures compare complete deterministic world state
after removing only budget and economy-preset differences.

Stroke tests separately prove:

- Standard input-order partial application is unchanged;
- paired all-new road and track strokes whose valid nominal total exceeds the
  displayed budget make Standard author only the affordable new tiles in input
  order while Creative authors every geometrically valid new tile;
- Standard continues scanning after an unaffordable tile and may still process
  a later free existing-road overlay;
- host-sent duplicate road and track points never increase nominal cost beyond
  one paid authoring per unique new tile;
- both report cost only for newly authored paid tiles; and
- fully skipped strokes preserve their existing rejection codes.

### 7.3 Invalid-operation parity

Creative fixtures exercise representative non-budget failures for placement,
topology, structure ownership, zoning, route connectivity, route activity,
route lookup, and compatibility. Each rejects without mutation. Paired
Standard fixtures with sufficient funds assert the same rejection code and
context.

Separate dual-failure fixtures cover the existing budget-first single-road,
single-track, bus-stop, metro-station, player-building, and vehicle-assignment
paths. Each fixture is both invalid and unaffordable and asserts that:

- Standard retains `insufficientBudget`;
- Creative returns the underlying non-budget rejection; and
- neither engine commits a snapshot, budget, topology, entity, or route change.

Complementary geometry-first dual-failure fixtures cover an unaffordable
roundabout with invalid geometry or port mapping and an unaffordable route
creation with invalid connectivity. Because those paths validate before
quoting their cost, Standard and Creative both return the same non-budget
rejection and context, neither commits any state, and Standard is not expected
to return `insufficientBudget`.

### 7.4 Preview tests

Road-preview tests cover:

- equal nominal Standard/Creative cost;
- Standard budget rejection;
- Creative success at the same low budget;
- unchanged engine snapshot/topology; and
- retained invalid geometry/topology rejection.

Route-preview tests cover:

- equal `initialVehicleCost`;
- Standard `affordable: false` plus existing rejection/warning behavior;
- Creative `affordable: true` without a budget rejection/warning;
- unchanged invalid-route rejection; and
- free route edits in both presets.

### 7.5 Persistence and host parity

Coverage restores a valid Creative schema-v4 snapshot through the core, WASM,
and Tauri boundaries, then performs a purchase and proves:

- policy still follows the persisted Creative preset;
- budget remains unchanged;
- nominal cost is retained; and
- the resulting world state is host-equivalent.

Existing backend normalization tests assert that no new TypeScript shape is
required. Render tests cover Creative building overlay and cursor-badge
affordability while retaining Standard unaffordable feedback.

### 7.6 Regression gates

The completed implementation runs at least:

```sh
rtk cargo fmt --all --check
rtk cargo clippy --workspace --all-targets -- -D warnings
rtk cargo test --workspace
rtk bun run check
rtk bun run lint
rtk bun run format:check
rtk bun run test
rtk bun run build
rtk bun run test:e2e
```

The browser build regenerates the release WASM artifact through the existing
prebuild hook. Tauri-specific tests exercise the managed Rust engine command
boundary; no new Tauri command is required.

## 8. Acceptance Mapping

| Linear acceptance criterion | Design coverage |
| --- | --- |
| Equivalent valid world mutation in Standard and Creative | Shared mutation path plus deterministic paired-state tests |
| Standard unaffordable purchase rejects without partial mutation | Atomic policy authorization and per-category atomicity matrix |
| Creative accepts and leaves budget unchanged | Creative zero-deduction quote and low-budget matrix |
| Creative still rejects invalid operations | Sufficient-budget parity plus intentional dual-failure precedence tests |
| Preview affordability and commit cannot disagree | Shared policy quote in route preview and shared road mutation preview path |
| No TypeScript-only cost bypass | Rust-only commit policy; TypeScript changes are read-only presentation |
| WASM/Tauri parity | Unchanged wire contract plus restored-snapshot host tests |

## 9. Delivery Boundary

HPA-338 is complete when every listed existing player purchase uses the policy,
nominal cost survives Creative dispatch/preview, Standard regression behavior
is preserved, Creative validation and qualified invalid-operation parity are
proven, host-boundary tests pass, and the full verification gates are green.

The implementation does not absorb the New City UI, persistence storage,
operating economy, fleet variants, or transit-operations roadmap work.

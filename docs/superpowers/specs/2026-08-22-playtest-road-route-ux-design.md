# Playtest Road Authoring and Route-Build UX Design

**Roadmap:** HPA-330  
**Tracking:** playtest follow-up after HPA-335 Phase 5 closeout  
**Delivery:** one implementation PR

> Linear issue creation was attempted on 2026-08-22 but the workspace is at its free issue limit. This design remains anchored to HPA-330 until the task can be copied to the replacement tracker.

## Goal

Fix five concrete blockers found while playing the completed transport sandbox, without reopening the roadmap into another subsystem:

1. using the direction tool on an automatic intersection cell shows the confusing `Change the approach lane; structure directions are automatic.` rejection;
2. an active Bus/Metro route draft pins the Lines panel over the map, preventing selection of covered stops/stations;
3. Demolish should use keyboard shortcut **D**, not **X**;
4. a dual-bidirectional × dual-bidirectional crossing can leave an outer cell of the 2×2 automatic-junction footprint without the reciprocal internal connection needed for reliable turning;
5. standalone one-way roads should not be built too close in parallel: their centerlines must be at least **3 tiles apart where their longitudinal spans overlap**, while perpendicular intersections remain legal.

These findings ship as **one implementation PR**. Internal TDD/commit gates are allowed, but the road and UI corrections are one playtest task.

## Review disposition

A second review identified a real same-direction adjacency gap but mixed it with an outdated failure mechanism. This design adopts the useful part and keeps the product decisions explicit:

- **Accepted:** parallel same-axis one-way endpoint links must be prevented when newly authored; links inherited through direction edits are stripped by canonicalization wherever arrow-aligned continuation identifies them, and any structurally indistinguishable residue (downstream lane ends) stays as a dormant, untraversable stub.
- **Accepted with correction:** current two-tile endpoint-join cleanup can preserve the unwanted lateral bridge, so tests target the final graph rather than assuming pruning destroys the through road.
- **Accepted partially:** direction edits and Dual placement bypass the standalone spacing preflight. Instead of coupling a 3-tile build rule into direction-cycle intermediate states, topology normalization keeps those authoring paths structurally safe and the policy is documented as tool-scoped.
- **Rejected:** reducing the requested spacing from 3 tiles to 2. Three tiles is the explicit playtest layout policy; adjacency safety is a separate concern.
- **Accepted:** the route E2E must prove a genuinely occluded map point, not reuse stops already clickable with Lines open.
- **Kept deliberately:** structure-owned direction clicks stay silent; replacing the unwanted tip with another tip would preserve the interruption.

## Verified current behavior and existing contracts

### Structure-owned direction clicks

`crates/caelum-core/src/road.rs::cycle_road_direction` rejects any road tile with `road_structure_id.is_some()` using `RejectionCode::InvalidDirectionChange`. `src/runtime/rejectionMessages.ts` renders that as:

> Change the approach lane; structure directions are automatic.

Structure footprint tiles are topology-owned and have no player-editable direction. Automatic-junction refresh clears their `one_way` values; roundabout footprint tiles are structure-owned too.

Two current tests encode the old rejection and must be rewritten:

- `crates/caelum-core/tests/road_authoring.rs::cycling_a_structure_tile_is_rejected_atomically`;
- `crates/caelum-core/tests/engine_topology.rs::rejected_direction_change_mutates_neither_snapshot_nor_cache`.

The engine already has the desired no-op path: `commit_snapshot_and_topology` returns `DispatchResult::unchanged` when the candidate snapshot equals the current snapshot.

### Parallel one-way lateral-link gap

`connect_neighbor_endpoints` currently suppresses a perpendicular endpoint connection only when adjacent one-way directions are exact opposites. Adjacent **same-direction** one-way lanes on the same axis fall through to `connect`.

Current automatic-junction cleanup has an `is_endpoint_join` preservation rule for reciprocal two-tile endpoint bridges. Therefore the load-bearing current symptom is not assumed to be "pruning destroys the road." The concrete problem is simpler: a lateral connection between parallel one-way lanes can survive as a valid-looking endpoint join and become traversable topology even though the lanes were only placed beside each other.

A connection-time guard alone is insufficient. A lateral endpoint link can be created while both roads are TwoWay and later become a parallel-one-way link after direction edits. `CycleRoadDirection` does not call `connect_neighbor_endpoints`; it changes `one_way` and then runs automatic-junction refresh/canonicalization. The topology contract therefore has three parts:

1. **prevent** new lateral links when both adjacent tiles are already parallel one-way lanes;
2. **strip inherited links** during canonicalization whenever arrow-aligned lane continuation on both sides identifies the edge as a lane-to-lane stub rather than part of a protected ring;
3. **tolerate structurally indistinguishable residue as dormant**: a downstream-end parallel-lane pair (arrows off the lane ends, bridge kept) is the same arrow/edge-labeled graph as the protected 2×2-loop transient, so no structural rule can strip it without serialized stroke provenance — rejected as machinery for an edge that `lane_accepts` makes untraversable in both directions anyway (it is perpendicular to both lanes' arrows).

Retention-time stripping is also load-bearing for through-road integrity: without it, a retained upstream bridge steers direction-cycle rebuilds into pruning the lane's own through edge.

This is independent of the 3-tile player-facing placement policy.

### Standalone OneWay placement policy

`RoadPreset::OneWay` currently has no proximity preflight. The requested **3-tile** separation is an explicit playtest/product rule, not a claim that distance 2 is mechanically unsafe.

The policy is intentionally scoped to standalone `LayRoadLine { preset: OneWay }` authoring:

- it runs before `author_lane_tiles`, so a OneWay stroke overlaying an existing road and reaching `merge_lane_direction` is still checked;
- preview and commit share it through `road::apply_road_mutation`;
- it is not a global map invariant;
- `CycleRoadDirection` remains an edit operation outside this build-tool policy;
- `DualBidirectional` remains exempt so its adjacent paired carriageway stays legal.

Order can therefore matter as a product-authoring rule. A later standalone OneWay beside an existing Dual lane is rejected; a later Dual road is not blocked by the standalone OneWay preflight. The topology normalization above guarantees that this accepted authoring asymmetry does not leave a lateral parallel-one-way connection behind.

Calling the 3-tile preflight from `CycleRoadDirection` is deliberately rejected for this slice. Direction cycling walks through intermediate cardinal states; rejecting an intermediate state can make a later otherwise-valid direction unreachable. A global direction-policy redesign is larger than the observed build-tool request.

### Dual-road intersections

`road.rs` already authors both Dual carriageways and builds automatic-junction structures. `crates/caelum-core/tests/dual_road_routing.rs` proves a representative crossing has a four-tile footprint and supports one legal left turn, but it does not prove all four internal 2×2 adjacencies.

Before production topology changes:

1. assert all four reciprocal internal edges for horizontal-first construction;
2. assert the same four edges for vertical-first construction;
3. keep both build-order tests permanently whether they begin RED or GREEN.

Only a RED missing-edge reproduction inside an already-classified contiguous 2×2 automatic junction justifies a private completion helper. If both orders are green, recapture the actual playtest map/build sequence instead of shipping an unproven mesh.

### Route draft panel gate

Route drafting is modal in three existing seams:

- `createGameRuntime.ts::setCommandDestination` blocks destination changes while a draft exists;
- `CommandShelf.svelte` blocks every destination/tool;
- `App.svelte` makes the Lines `CommandPanel` unclosable while drafting.

The draft itself lives in runtime UI state and continues to render/handle canvas clicks without the panel. No new editor state is needed.

Required contract edits include:

- the route-draft gate in `tests/runtime/gameRuntime.test.ts`;
- `tests/ui/commandShelf.test.ts::blocks every conflicting activation while a route draft pins Lines`;
- the Lines panel contract in `tests/ui/appShell.test.ts`.

`handleEscape` continues to cancel an active draft whether Lines is open or collapsed.

`tests/e2e/helpers.ts::openCommandDestination` also contains a stale comment describing Lines as disabled-but-expanded during a draft; update it with the new contract.

### Demolish shortcut

`App.svelte::handleWindowKeydown` maps X to `setTool("remove")`. `tests/ui/appShell.test.ts` explicitly characterizes the current `B/R/T/X/V` mapping. Replace X with D and lock X off.

### Existing route E2E does not prove occlusion

The current route E2E already clicks simple stops `(3,3)` and `(7,3)` while Lines is open, so those coordinates cannot prove the motivating blocker.

The new E2E must select a stop whose tile center is actually under the rendered command panel. Derive tile viewport centers from the existing board transform, compare them with the panel bounding box, assert `document.elementFromPoint` belongs to the panel while open, then collapse Lines and select that same stop from the canvas.

## Product decisions

## 1. Structure-owned road cells are silent no-ops

When `CycleRoadDirection` targets `road_structure_id.is_some()`:

- snapshot unchanged;
- no rejection;
- `applied == false` through existing snapshot equality;
- save not dirtied;
- topology cache unchanged.

Silence is intentional. The clicked cell is not editable and has no corrective action. Replacing the current tip with another toast would preserve the interruption the playtest asked to remove.

Change:

```rust
fn cycle_road_direction(
    candidate: &mut GameSnapshot,
    point: Point,
) -> GameplayResult<bool>
```

Return `Ok(false)` for structure ownership and `Ok(true)` for a real direction change. Delete `InvalidDirectionChange` from current Rust/TypeScript contracts once it has no producer.

## 2. Parallel one-way lanes never retain traversable lateral links

One small private predicate shared by connection and canonicalization:

```rust
fn is_lateral_parallel_one_way_link(
    current: Option<Heading>,
    current_connections: &[Heading],
    neighbor: Option<Heading>,
    neighbor_connections: &[Heading],
    heading: Heading,
    require_arrow_continuation: bool,
) -> bool { ... }
```

The predicate demands same-axis arrows on both tiles, a perpendicular connecting edge, and same-axis lane evidence in both connection lists. The `require_arrow_continuation` flag additionally demands each tile keep an arrow-aligned edge; canonicalization sets it because loop or corner cells cycled to transient arrows carry same-axis edges that belong to unrelated ring segments, and trusting those would strip real through-edges permanently.

### Prevent new links

In `connect_neighbor_endpoints`, use the predicate (weak evidence) instead of the current opposite-direction-only check. Any adjacent one-way lanes on the same axis skip a perpendicular connection.

### Strip inherited links, tolerate indistinguishable residue

Extend `canonicalize_authored_roads` so a reciprocal connection is retained only when it is both topologically reciprocal **and not** a lateral parallel-one-way link with arrow-aligned continuation on both sides.

This makes the invariant robust when a link already existed between TwoWay endpoints and both endpoint cells are later changed to the same one-way axis, regardless of authoring order. Where continuation evidence cannot distinguish a stub from a protected 2×2-loop transient (downstream lane ends), the bridge stays serialized as a dormant stub: it is perpendicular to both lanes' arrows, so `lane_accepts` rejects crossing movement from either side and no route, trip, or stop access can traverse it. Serialized stroke provenance could separate those worlds exactly but is rejected as machinery outweighing a non-traversable edge.

True one-way intersections remain valid because crossing axes differ, and automatic-junction structure tiles have their own ownership/direction semantics.

## 3. The 3-tile rule is a standalone OneWay build policy

Keep:

```rust
const MIN_PARALLEL_ONE_WAY_SPACING_TILES: i32 = 3;
```

For `RoadPreset::OneWay` only, inspect the pre-mutation map at the same longitudinal coordinate and perpendicular offsets ±1 and ±2. Reject when the nearby tile is road, is one-way, and has the same direction axis as the candidate stroke.

Examples:

```text
existing x=3..10, y=5 + candidate x=3..10, y=6  -> reject
existing x=3..10, y=5 + candidate x=3..10, y=7  -> reject
existing x=3..10, y=5 + candidate x=3..10, y=8  -> allow
existing x=3..6,  y=5 + candidate x=8..12, y=6  -> allow
horizontal OneWay crossing vertical OneWay       -> allow
```

Distance 2 remains rejected because **3 tiles is the explicit playtest layout rule**. Task 2 owns topology safety; this policy owns standalone OneWay authoring UX.

Because the preflight runs before `author_lane_tiles`, it also blocks a OneWay overlay before `merge_lane_direction`.

Add `RejectionCode::OneWayParallelTooClose` with:

> Keep parallel one-way roads at least 3 tiles apart.

Do not duplicate the formula in TypeScript.

## 4. Repair a 2×2 automatic junction only after RED

Always commit build-order tests for:

```text
NW <-> NE
NW <-> SW
NE <-> SE
SW <-> SE
```

If one order is RED specifically on a missing internal edge, add a private `connect_complete_two_by_two_junction` restricted to an already-classified contiguous 2×2 automatic junction. Use existing `connect`; do not alter ports, roundabouts, or public structure types.

If both are green, no production helper. Recapture the playtest topology before claiming the blocker fixed.

## 5. Route drafts may collapse only Lines

While a draft exists:

- destination toggles only between `"lines"` and `null`;
- Build/Data/City blocked;
- Select/Demolish blocked;
- route tool/draft unchanged;
- canvas map selection continues;
- Lines reopens the same editor;
- Save/Cancel unchanged;
- Escape cancels the draft.

Use only existing runtime/shelf/panel seams.

## 6. Demolish is D only

```text
D -> setTool("remove")
X -> no demolish action
```

Keep existing input/contenteditable and modifier guards. No shortcut compatibility alias.

## Required files

### Rust production

- `crates/caelum-core/src/road.rs`
- `crates/caelum-core/src/rejection.rs`

### Rust tests

- `crates/caelum-core/tests/road_authoring.rs`
- `crates/caelum-core/tests/engine_topology.rs`
- `crates/caelum-core/tests/dual_road_routing.rs`
- `crates/caelum-core/tests/model_wire_format.rs`

### Frontend/runtime production

- `src/domain/types.ts`
- `src/runtime/rejectionMessages.ts`
- `src/runtime/createGameRuntime.ts`
- `src/components/hud/CommandShelf.svelte`
- `src/App.svelte`

### Frontend/E2E tests and helpers

- `tests/runtime/rejectionMessages.test.ts`
- `tests/runtime/gameRuntime.test.ts`
- `tests/ui/commandShelf.test.ts`
- `tests/ui/appShell.test.ts`
- `tests/e2e/helpers.ts`
- `tests/e2e/routes.spec.ts`

No new production module, public controller method, dependency, schema field, persistence state, or migration.

## Acceptance criteria

### Structure direction

- automatic junction and roundabout-owned road cells: unchanged/no rejection/cache unchanged;
- ordinary authored road still cycles;
- `InvalidDirectionChange` removed from current contracts.

### Parallel one-way topology

- new adjacent parallel one-way endpoints do not get a lateral edge;
- an existing lateral endpoint edge is removed once both endpoint tiles become parallel one-way lanes, except where it is graph-indistinguishable from a protected ring transient; such residue remains serialized but is untraversable (`lane_accepts` rejects crossing movement from both lanes);
- through-road edges remain intact;
- existing opposite-direction Dual anti-U-turn behavior remains intact;
- perpendicular one-way intersections are unaffected.

### Standalone OneWay spacing

- overlapping distance 1 -> reject;
- overlapping distance 2 -> reject;
- distance 3 -> allow;
- close non-overlapping segments -> allow;
- perpendicular intersection -> allow;
- Dual self-authoring -> allow;
- later standalone OneWay beside existing Dual lane at distance 1/2 -> reject;
- OneWay overlay is checked before merge;
- preview/commit agree;
- rejection atomic.

The spacing policy is explicitly tool-scoped. Direction edits and Dual placement can produce geometry the standalone OneWay tool would refuse; Task 2 guarantees that such geometry never gains a *traversable* lateral parallel-one-way link — new ones are prevented at connection time, inherited ones are stripped by canonicalization, and structurally indistinguishable residue stays dormant.

### Dual intersection

- both build orders permanently assert all four internal reciprocal adjacencies;
- no helper without RED missing edge;
- if RED and fixed, footprint/ports/legal turn/mid-block behavior remain valid;
- if green, recapture actual playtest cause before claiming resolution.

### Route editor

- Lines collapses/reopens without losing draft;
- no other command becomes available;
- Escape cancels open or collapsed draft;
- E2E proves a selected stop is actually under the open panel before collapse and selectable afterward.

### Shortcut

- D activates Demolish;
- X does nothing;
- D in text input/contenteditable does nothing;
- modified D does not trigger bare shortcut.

## Risks and decision boundaries

### Topology safety vs player placement policy

Do not rely on the 3-tile rule for graph correctness. Parallel-one-way lateral links are normalized independently of how the geometry was authored: prevented at connection time, stripped at canonicalization when arrow-aligned continuation identifies them, and left dormant (untraversable) where no structural rule can distinguish them from protected ring transients.

### Tool-scoped spacing asymmetry

The spacing rule is intentionally a standalone OneWay build policy, not a global road invariant. This avoids introducing direction-cycle state skipping or a generalized validator. Revisit only if later playtesting shows the asymmetry itself is confusing.

### Dual 2×2 diagnosis

A green-only mesh helper is forbidden. The tests remain useful invariants even when green; production change requires a concrete RED edge.

### E2E geometry

A draft-survival E2E on an already-exposed stop is insufficient. The test must prove panel ownership at the chosen tile center.

### Silence on structure direction clicks

Silence is deliberate, not swallowed error handling: the target is topology-owned and there is no actionable correction on that cell.

## Non-goals

- Generic road rule/spacing framework.
- Globalizing the 3-tile rule across every way a `one_way` value can exist.
- New lane model or intersection entity.
- New topology representation for the suspected dual bug.
- Traffic lights, priorities, lane arrows, or turn restrictions.
- Generally non-modal route editing or floating editor UI.
- Shortcut preferences.
- Schema/migration/backward-compatibility work.
- New dependencies.

## Delivery rule

Everything remains one implementation PR. Task 4's build-order tests are unconditional; its production helper is conditional on RED. If the dual playtest cause is not reproduced by that bounded test, recapture and rescope rather than widening the PR.
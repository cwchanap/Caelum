# HPA-675 — Fleet price and route corner implementation plan

**Spec:** [2026-11-06-hpa-675-fleet-cost-route-corners-design.md](../specs/2026-11-06-hpa-675-fleet-cost-route-corners-design.md)  
**Linear:** https://linear.app/cwchanap/issue/HPA-675/fix-line-pricing-and-the-route-corner-hook-from-the-second-uat  
**Baseline:** main @ ec2f7e8  
**Delivery:** One PR only. This plan is committed first for review; perform implementation, tests, and cleanup on this same branch/PR. No art generation.

## Existing code to change

| Concern | Primary files |
| --- | --- |
| Rust quote and purchase parity | `crates/caelum-core/src/preview.rs`, `crates/caelum-core/src/service_control.rs`; reuse existing `CostPolicy` |
| Wire/host normalization | `src/runtime/backend/types.ts`, `src/runtime/backend/shared.ts` (existing WASM/Tauri methods unchanged) |
| Draft save behavior | `src/runtime/createGameRuntime.ts`, `src/runtime/runtimeSelectors.ts`, `src/runtime/types.ts` |
| Draft UI | `src/components/hud/panels/RouteEditor.svelte` |
| Common turn geometry and minimal visual join | `crates/caelum-core/src/road_topology.rs`, and `src/render/webgpu/transitBatch.ts` for solid joints only |
| Focused tests | `crates/caelum-core/tests/route_preview.rs`, `crates/caelum-core/tests/road_topology.rs`, `tests/runtime/gameRuntime.test.ts`, `tests/ui/routeEditor.test.ts`, `tests/e2e/routes.spec.ts` (update other fixtures required by the changed wire type) |
| Architecture note | `docs/architecture.md` |

## Task 1 — Add a minimal Rust-only initial-fleet quote

**Write targeted Rust tests first**, reusing the existing route-preview fixture:
- Happy path: a connected new Bus route needing **multiple vehicles** gets a nominal quote matching the same-state Rust fleet purchase; test Metro by reusing existing route preview/service coverage rather than duplicating the matrix.
- Representative negative case: an edit preview has `initialFleet: null`. Reuse existing `CostPolicy` tests for Creative/insufficient budget; do not add another Creative matrix.

1. Add one small helper in `service_control.rs` that takes an already derived, traffic-aware `round_trip_seconds` plus mode and target, then returns the required count and checked **nominal** cost. Call it from **all three** sites: `deploy_initial_fleet`, `metrics` (for `estimated_deployment_cost`), and `preview_route`. The `metrics` path already computes cycle time for display, so do not recalculate it there. Preserve the current deployment error semantics for invalid cycle or overflow.
2. In `preview_route`, after successful new-create leg validation, use Rust's existing road flow and `DEFAULT_TARGET_HEADWAY_SECONDS` (600) to build `initial_fleet: Option<InitialFleetQuote { cost, affordable }>`. Use `CostPolicy.quote(nominal, budget).affordable()`; never show an effective payable $0 for Creative. Do not use `RoutePreviewResponse.total_travel_seconds` or duplicate fleet math in TS.
3. Extend the existing TS route-preview contract with `initialFleet: { cost: number; affordable: boolean } | null`; normalize `?? null` across WASM/Tauri. Update compile-time fixtures for the new required field without multiplying redundant scenario tests.
4. Do not introduce a Rust intent, new host method, extra state owner, purchase reservation, or schema migration.

**Proof:** One structural quote is consistent with existing saved-line estimates and the actual Rust purchase without mutating the city during preview.

## Task 2 — Present the quote and honor Save without fleet

**Use the ticket's two UI cases** in `tests/ui/routeEditor.test.ts`: a connected new Bus draft showing `Save & run · $X` and an unaffordable draft showing the warning and `Save without fleet`. Reuse existing route-editor edit/disabled-state tests; do not add parallel pending/stale/Creative tests.

1. Add one create-only nullable `initialFleet` to `RouteEditorView`, selected from the current-generation preview; reuse `formatBudget` and existing budget. `cost` is **nominal** even in Creative; `affordable` is Rust's `CostPolicy` answer.
2. In `RouteEditor.svelte`, use **Save & run · $X** only when `initialFleet?.affordable === true`; otherwise new drafts say **Save without fleet**. Show needed/available warning only when a real quote exists and affordability is false. A valid draft with null quote can still Save without fleet. Edits remain **Save route**; no new `canSaveRouteDraft` restriction.
3. In existing `saveRouteDraft`, capture `deploy = draft.preview?.initialFleet?.affordable === true` together with its draft token. Continue saving the route in the existing queue. Only skip the post-create `deployInitialFleet` when `deploy` is false. Preserve accepted-create publication, ID diff, token deduplication, and superseded draft behavior.
4. In `tests/runtime/gameRuntime.test.ts`, add **one** unaffordable-create check that sends `createRoute` and **no** `deployInitialFleet`. Rerun the existing happy-path deployment and `keeps a created Bus line and manual Deploy fallback after budget rejection` tests; the latter already exercises a real deployment-time failure.

**Proof:** New drafts' button text matches the actual dispatched operation, and no valid Save becomes disabled merely because a quote is null.

## Task 3 — Reproduce and repair the 90-degree route overlay

**Decision already made from code review: fix the shared Rust source, not a renderer-only path fork.**

1. Replace the existing `right_and_left_turn_geometry_uses_a_non_collinear_incoming_tangent` assertion in `crates/caelum-core/tests/road_topology.rs` with a focused regression: ordinary right/left turns have straight `Line` geometry connecting adjacent tile centres and do **not** bulge past the two endpoints. Preserve the existing continuity test for consecutive steps.
2. In `crates/caelum-core/src/road_topology.rs::transition_geometry`, combine `RightTurn | LeftTurn` with the existing `Straight` line arm. Leave U-turn and roundabout geometry unchanged. With one upstream geometry source, route strokes, highlight halos, draft paths, buses, line picking, and direction arrows stay aligned automatically.
3. Check actual solid-stroke joins in `src/render/webgpu/transitBatch.ts::drawSteps`. If two non-dashed, adjacent steps leave an outer notch because their ends are butt-capped, draw a `SolidGeometry.circle` at their shared point using the existing line width and color. Do **not** add a generic miter system, special picking geometry, a second TS turn representation, or extra render state. Keep broken-route dashes as dashes.
4. Rerun existing route geometry, WebGPU transit/vehicle, and map picking tests. A single Rust corner-shape regression suffices for the source defect; add a render vertex assertion only if the join fix actually requires it.

**Proof:** At an ordinary corner, the route and bus follow exactly the same tile-centre path, with no overshoot. Shared-corridor offset joins may still kink slightly; accept that existing limitation pending UAT.

## Task 4 — Integration, documentation, and checks

1. Update `docs/architecture.md` to describe a read-only, **nominal** initial-fleet quote on new-route previews, while Rust purchase remains authoritative. Keep all other docs and features as-is.
2. Update old `Save & run` button selectors in `tests/e2e/routes.spec.ts` (and other existing E2E files if matched) to allow the `· $X` suffix. Add **one** affordable price-label path; leave the unaffordable branch to the focused UI/runtime tests, not a second E2E case.
3. Run focused tests while implementing; then the standard CI-shaped checks:

```sh
cargo test --workspace
bun run check
bun run test:unit
bun run test:e2e
bun run lint
bun run format:check
bun run build
```

4. Confirm browser/WASM and native/Tauri still use one `previewRoute` contract; no extra host API or full packaged-desktop parity matrix.
5. Re-check the **latest** HPA-675 Linear description before completion. HPA-678, HPA-676, HPA-696, art generation, and other UAT observations remain outside this PR.

**Test scope:** Existing `CLAUDE.md` asks for a happy path plus one representative failure; prioritize important player operations and deterministic invariants, not branch permutations or snapshot screenshots.

## Completion checklist

- [ ] One existing draft PR contains spec, plan, code, and tests.
- [ ] One nullable nominal-price quote on Rust preview uses the 600-second default and existing CostPolicy; preview, deployment and saved-line metrics reuse the price helper.
- [ ] New Bus and Metro drafts display the correct action and cost.
- [ ] Insufficient-budget Save creates the route and does **not** attempt fleet deployment.
- [ ] Creative shows the same nominal price as other Lines UI, and CostPolicy still authorizes a free purchase.
- [ ] Existing route Edit still updates without purchasing a fleet.
- [ ] Old create/deploy rejection and stale-save protections remain intact.
- [ ] Right/left turns use upstream Rust Line geometry shared by route overlay, vehicles, arrows and picking; preserve U-turns/roundabouts and accept existing minor shared-corridor kink risk.
- [ ] Workspace-wide Rust tests and Bun checks pass; record exact commands and results in the PR.
- [ ] No art/SFX, docking, new APIs, save migration, backward compatibility, or extra PR.

## Implementation boundary

Review this design-only draft before coding. Subsequent commits go to **this same PR**. Use the narrowest tested change and prefer editing existing files/tests over adding utilities unless they remove actual duplication.

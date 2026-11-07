# HPA-675 — Fleet price and route corner implementation plan

**Spec:** [2026-11-06-hpa-675-fleet-cost-route-corners-design.md](../specs/2026-11-06-hpa-675-fleet-cost-route-corners-design.md)  
**Linear:** https://linear.app/cwchanap/issue/HPA-675/fix-line-pricing-and-the-route-corner-hook-from-the-second-uat  
**Baseline:** main @ ec2f7e8  
**Delivery:** One PR only. This plan is committed first for review; perform implementation, tests, and cleanup on this same branch/PR. No art generation.

## Existing code to change

| Concern | Primary files |
| --- | --- |
| Rust quote and purchase parity | `crates/caelum-core/src/preview.rs`, `crates/caelum-core/src/service_control.rs`, `crates/caelum-core/src/cost_policy.rs` |
| Wire/host normalization | `src/runtime/backend/types.ts`, `src/runtime/backend/shared.ts` (existing WASM/Tauri methods unchanged) |
| Draft save behavior | `src/runtime/createGameRuntime.ts`, `src/runtime/runtimeSelectors.ts`, `src/runtime/types.ts` |
| Draft UI | `src/components/hud/panels/RouteEditor.svelte` |
| Visual turn repro/fix | `src/render/webgpu/transitBatch.ts`, possibly `src/render/routeGeometry.ts` |
| Tests | `crates/caelum-core/tests/route_preview.rs`, `tests/runtime/gameRuntime.test.ts`, `tests/runtime/runtimeSelectors.test.ts`, `tests/ui/linesPanel.test.ts`, `tests/render/webgpuTransitBatch.test.ts`, `tests/render/routeGeometry.test.ts`, `tests/e2e/routes.spec.ts` |
| Architecture note | `docs/architecture.md` |

## Task 1 — Add a minimal Rust-only initial-fleet quote

**Write failing Rust tests first** in the existing route-preview test module for connected new Bus and Metro drafts. Pin the price for one and multiple vehicles, 600-second target, Standard insufficient budget, Creative $0 effective charge, and null quote on edit/rejected/disconnected drafts. In `model_wire_format.rs`, check the added camelCase nullable response fields.

1. Extract a **small** helper in `service_control.rs` to derive initial required count and nominal purchase price from resolved legs and live road flow using the existing round-trip and fleet-count functions. Make `deploy_initial_fleet` reuse it without changing its atomic budget check or placement behavior. Reuse it for preview; never use `RoutePreviewResponse.total_travel_seconds` for fleet price.
2. Use the existing `CostPolicy` for affordability and payable cost. A read-only getter on `CostQuote` is sufficient if needed; no new purchase policy or domain abstraction.
3. In `preview_route`, after successful create-only leg resolution, compute `initial_fleet_cost` and `initial_fleet_affordable`. Early rejected/edited/invalid responses have explicit `None`.
4. Extend the TS `RoutePreviewResponse` contract and `normalizeRoutePreviewResponse`. Update every compile-time fixture of this response with explicit nulls or real quotes, and cover null normalization in the existing backend shared test if present.

**Proof:** Quote matches same-state Rust fleet purchase and remains geometry-valid without mutating budget or vehicles; existing route preview and deployment tests still pass.

## Task 2 — Present the quote and honor Save without fleet

**Add focused failing selector and UI tests** for:
- new Bus and Metro **Save & run · $X** labels from a fresh Rust quote;
- warning containing price and available budget when quote is unaffordable, plus **Save without fleet**;
- no price while preview is pending or stale, no enabled Save when a valid quote is absent;
- edit draft retains **Save route** and existing controls;
- Creative quote renders as $0 payable, not as the nominal vehicle price.

1. Extend `RouteEditorView` with the create-only quote and warning state, populated only from `draft.preview` of the current generation. Do not hard-code mode prices or count vehicles in a selector.
2. In `RouteEditor.svelte`, replace the two-way label branch with the three create/edit actions described in the spec. Reuse existing UI warning class and `formatBudget`, with a specific test id only where it helps tests.
3. In `saveRouteDraft`, capture whether the clicked valid draft used **Save without fleet**. Keep the existing queue, token de-duplication, accepted-create commit, and ID diff. For this one mode, skip the post-create `deployInitialFleet` call; never skip the `createRoute`.
4. Cover this branch in `tests/runtime/gameRuntime.test.ts`: one saved new line and **no deploy intent** for a known unaffordable quote. Preserve and rerun existing tests for affordable creation + exactly one deploy, failed create, duplicate Saves, and superseded drafts. Add a test that a fresh budget rejection after an apparently affordable preview retains the saved route and correct UI feedback.

**Proof:** Button text describes the exact chosen operation, and the choice matches issued intents. No new backend action or save manager.

## Task 3 — Reproduce and repair the 90-degree route overlay

**First pin the bug, then choose one fix location.**

1. In `tests/render/webgpuTransitBatch.test.ts`, add an L-turn path with an entering straight segment followed by the real Rust-style turn geometry: e.g. from (2,2), quadratic control (2,1.5), to (3,2), following a vertical segment ending at (2,2). This currently makes a visible excursion above the horizontal road. Assert the rendered route-color stroke stays inside the intended right-angle corridor and remains joined at the corner.
2. Inspect the corresponding source geometry, presentation offset, and generated vertices. Also test a mirrored turn and a shared corridor with nonzero offsets so a naive straight-line substitution does not leave a gap. Use the actual `uat2-route-line-corner-hook` image on HPA-675 for a quick manual comparison.
3. Make the **smallest renderer-only correction** at the step drawing seam for ordinary right/left turns. Reuse the same logic for committed routes, halos, dashed broken legs, and new route drafts. If the fixture proves offsets alone cause the defect, fix only `routeGeometry.ts` instead. Avoid touching Rust motion geometry.
4. Keep the existing tests for straight corridor offsets, curved and roundabout paths, dashed legs, geometry sampling, route inspection/picking, and moving vehicles. Add only regressions that describe the observed failure rather than exact per-frame screenshots.

**Proof:** The hooked turn in the UAT is a clean 90-degree map line with no overshoot; displayed connected segments still join under corridor offset. Neither route paths nor vehicle position/progress fields change.

## Task 4 — Integration, documentation, and checks

1. Update the route-preview architecture note in `docs/architecture.md`: geometry plus **read-only Rust initial-fleet quote for create drafts**; the Rust purchase remains authoritative. Do not add a new architecture document.
2. Extend `tests/e2e/routes.spec.ts` for one affordable new-line price and one insufficient-budget save-without-fleet path. Adjust existing `Save & run` role-button selectors to match the price suffix, preferably using an anchored regular expression. Keep E2E scenarios short; use Rust and runtime unit tests for branch permutations.
3. Run focused tests while implementing, then the standard checks:

```sh
cargo test -p caelum-core --test route_preview
bun run check
bun run test:unit
bun run test:e2e
bun run lint
bun run format:check
bun run build
```

4. Verify both browser/WASM and Tauri use the **same existing** `previewRoute` contract; no additional host-specific UI path. A full packaged-desktop E2E matrix is unnecessary.
5. Compare changes against HPA-675's **latest** Linear description. Confirm HPA-678/HPA-676/HPA-696 concerns and all unrelated UAT findings are untouched.

## Completion checklist

- [ ] One existing draft PR contains spec, plan, code, and tests.
- [ ] Rust preview price and affordable flag use existing 600-second and CostPolicy rules.
- [ ] New Bus and Metro drafts display the correct action and cost.
- [ ] Insufficient-budget Save creates the route and does **not** attempt fleet deployment.
- [ ] Creative is free and never blocked solely for money.
- [ ] Existing route Edit still updates without purchasing a fleet.
- [ ] Old create/deploy rejection and stale-save protections remain intact.
- [ ] L-turn route-line geometry is clean; dashed, corridor, and movement paths are preserved.
- [ ] Tests/checks pass; record exact commands and results in the PR.
- [ ] No art/SFX, docking, new APIs, save migration, backward compatibility, or extra PR.

## Implementation boundary

Review this design-only draft before coding. Subsequent commits go to **this same PR**. Use the narrowest tested change and prefer editing existing files/tests over adding utilities unless they remove actual duplication.

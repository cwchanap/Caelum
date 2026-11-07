# HPA-675 — Fleet-price preview and clean route corners — Design

**Linear:** https://linear.app/cwchanap/issue/HPA-675/fix-line-pricing-and-the-route-corner-hook-from-the-second-uat  
**Repository:** cwchanap/Caelum  
**Baseline:** main at ec2f7e8 (2026-11-06 second UAT)  
**Delivery:** One PR for this spec, implementation plan, and eventual implementation. This initial draft is documentation-only.

## Player outcome

A new Bus or Metro draft shows the **nominal initial-fleet price**, consistent with existing Lines prices. A valid, affordable draft offers **Save & run · $X**. A new draft whose fleet is unaffordable warns **Need $X for the initial fleet; available $Y** and offers **Save without fleet**, which creates the line without an automatic fleet purchase. Creative also displays the nominal price but `CostPolicy` authorizes the purchase without charging the budget. Editing an existing route remains **Save route**, without a purchase.

Fix the visible hook at ordinary road corners using **one shared path geometry** for the drawn line, vehicles, and map picking, matching the attached `uat2-route-line-corner-hook` screenshot. Preserve travel timing and game topology; a sharp turn at the tile centre is acceptable.

## Current architecture and verified findings

- `RouteEditor.svelte` currently hard-codes **Save & run** for creates; `RouteEditorView` in `src/runtime/types.ts` has no draft fleet quote.
- `src/runtime/createGameRuntime.ts` already serializes `createRoute` followed by `deployInitialFleet` in one save operation, deduplicates Saves, and identifies the newly added line by diffing accepted scene IDs. Keep this workflow.
- `crates/caelum-core/src/preview.rs` already resolves draft legs in Rust, but its `RoutePreviewResponse` has geometry and timing only. Its `total_travel_seconds` uses stored leg estimates; it is **not** the live congestion-aware cycle time charged by the fleet purchase.
- `crates/caelum-core/src/service_control.rs` owns the default 600-second target, congestion-aware round-trip calculation, `required_fleet`, `vehicle_cost`, and atomic `deploy_initial_fleet`. `CostPolicy` owns Standard-versus-Creative affordability and deduction.
- Both Tauri and WASM already expose `previewRoute`. The smallest seam is an additive nullable quote on that existing response; no new intent, backend API, or command.
- `road_topology::transition_geometry` constructs ordinary right/left turns as quadratic curves with control at `from + 0.5 × incoming`; the curve visibly overshoots even at zero corridor offset. Critically, `presentationForRoute` is used by route strokes **and** vehicle rendering and map picking. A stroke-only correction would make buses and click targets disagree with the line. Change the Rust source geometry instead, with only a small visual joint fill in the renderer.

## 1. Rust-derived quote on the existing draft preview

Add **one** nullable structured field to Rust `RoutePreviewResponse`, mirrored in `src/runtime/backend/types.ts`:

```rust
initial_fleet: Option<InitialFleetQuote> // { cost: i32, affordable: bool }
```

The TS wire field is `initialFleet: { cost: number; affordable: boolean } | null`. `cost` is the **nominal** cost (what every existing Lines price displays), including for Creative. `affordable` comes directly from `CostPolicy::from_snapshot(snapshot).quote(cost, snapshot.budget)` and is true in Creative when a valid quote exists. No new payable-cost getter, special Creative display rule, or duplicate TS fleet formula.

Populate the quote only for new, fully connected, valid Bus/Metro drafts with a calculable service cycle. Edits, rejected/partial drafts, and unavailable cycle/overflow cases return `None`. The saved line's `estimatedDeploymentCost` remains nominal and unchanged. Normalize `initialFleet: response.initialFleet ?? null` in `normalizeRoutePreviewResponse` for WASM/Tauri parity.

Consolidate the current price formula in **all three** Rust callers: `preview_route`, `deploy_initial_fleet`, and `service_control::metrics`. A small `initial_fleet(round_trip_seconds, mode, target_headway_seconds) -> Option<(usize, i32)>` helper can reuse `required_fleet`, `vehicle_cost`, and checked conversion/multiplication. Each caller computes its congestion-aware cycle through the existing `round_trip_seconds(legs, mode, flow)` path and then calls the helper; `metrics()` already needs that cycle for other fields, so avoid calculating it twice. The deploy path maps a missing/overflowing quote to its existing rejection and **re-authorizes** immediately before mutation; no new gameplay intent or host method.

`RoutePreviewResponse.total_travel_seconds` sums stored estimates and must **not** be used to derive the quote. The preview remains read-only: no budget reservation, mutation, caching, or new service-plan abstraction.

## 2. Draft footer and save semantics

Derive a single create-only `initialFleet` in `selectRouteEditorView` from the **current-generation** preview. Reuse existing `formatBudget` and budget display; do not duplicate Rust policy.

- New create + `initialFleet.affordable === true`: **Save & run · $X** where X is the quoted nominal price.
- New create + `initialFleet.affordable === false`: **Save without fleet**, plus a nonblocking warning showing nominal cost and money available.
- New create + **null quote**: **Save without fleet** without inventing a price or warning. Valid route creation remains allowed, as today.
- Edit: **Save route**, unchanged. Pending/rejected/stale previews keep the **existing** `canSaveRouteDraft` gate and Checking route state; a missing quote does **not** create a new disabled-Save condition.

At Save click, capture `deploy = draft.preview?.initialFleet?.affordable === true` with the existing draft token. Keep the queued create, ID diff, accepted-create commit, and duplicate/superseded Save protections. If `deploy` is false, skip only `deployInitialFleet` while still saving the line. If true, keep the existing create-then-deploy sequence.

The quote is only a point-in-time estimate. If budget/flow changes before the actual dispatch, Rust recomputes and authorizes purchase. An unexpected deployment rejection still leaves the created route and existing manual Deploy fallback, with the existing rejection feedback. Do not add a second Save handler or backend mutation.

## 3. Corner rendering: fix only the visible route stroke

**Chosen design:** fix ordinary turn geometry at the Rust source, `crates/caelum-core/src/road_topology.rs::transition_geometry`. Merge `MovementKind::RightTurn | MovementKind::LeftTurn` into the `Straight` line-geometry arm. The line connects the same adjacent tile centres without the current quadratic control-point overshoot.

This is one shared geometry source for the **committed route stroke, highlight halo, broken-route dashes, draft preview, sampled vehicle positions, direction arrows, and map picking**. It does change the displayed vehicle path: buses turn sharply at tile centres instead of swinging outside the road. It does **not** change travel time, route connectivity, turn classifications, economy, or routing decisions. Preserve quadratic U-turns and roundabout behavior.

Replace the existing `right_and_left_turn_geometry_uses_a_non_collinear_incoming_tangent` test in `crates/caelum-core/tests/road_topology.rs` with an assertion that turns have line geometry between their expected centres and cannot bulge outside those endpoints. Do not do a three-layer source/offset/vertex investigation for the already identified bug.

If the adjoining non-dashed solid segments leave a visible outer notch from butt caps, fill that joint with the existing `SolidGeometry.circle` in `transitBatch.ts::drawSteps`. Limit this to genuine solid step joints; no duplicate corner transformation in TypeScript, generic miter system, additional scene state, or new picking geometry. The current independent shared-corridor offsets can already leave minor kinks; accept those until UAT demonstrates a practical problem.

## Non-goals

- No panel docking, new HUD, library/menu styling, map sprites, WebGPU overhaul, art, or SFX. These are HPA-678 / HPA-676 / HPA-696.
- No new save or fleet intent, host method, economy system, schema migration, or backward-compatibility layer.
- No new automatic fleet management, bankruptcy handling, stop dwell times, routing algorithm changes, or unrelated UAT findings.
- No new PR for each implementation phase: all code and tests stay in **this same PR** after design review.

## Acceptance criteria

1. A new connected Bus or Metro draft shows a Rust-derived **nominal** initial-fleet quote and **Save & run · $X** when affordable; Creative displays nominal cost while remaining authorized at zero budget deduction.
2. An unaffordable new draft warns with needed and available amounts, and **Save without fleet** saves one line without an automatic deployment. A valid null-quote draft can still be saved without fleet.
3. Edit Save stays unchanged. Existing rejected-create, duplicate/superseded Save, and deployment-time rejection behavior is preserved.
4. The same Rust fleet cost helper serves preview, deployment, and saved-line metrics; sizing uses the live flow-aware cycle and default 600-second target.
5. Ordinary right/left turns use shared **line** geometry: overlay, bus movement, and map picking agree, with no visible hook. Preserve other movement types and accept minor existing shared-corridor kinks pending UAT.
6. A focused happy path and representative failure, existing regression coverage, workspace Rust tests and standard Bun checks pass; architecture docs describe the new quote.

## Tradeoffs

The quote is informational: budget and traffic can change before the engine re-authorizes deployment; avoiding a reservation system is deliberate. The serious corner regression would be splitting the drawn line from vehicles and map picking; this design prevents that by changing their shared Rust geometry, at the cost of a sharper bus rotation at tile centres. Independent corridor offsets may still leave small kinks at shared corners; accept those until UAT provides evidence, rather than build a new join engine or pixel-perfect screenshot matrix.

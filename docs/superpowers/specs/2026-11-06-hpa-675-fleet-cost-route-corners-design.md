# HPA-675 — Fleet-price preview and clean route corners — Design

**Linear:** https://linear.app/cwchanap/issue/HPA-675/fix-line-pricing-and-the-route-corner-hook-from-the-second-uat  
**Repository:** cwchanap/Caelum  
**Baseline:** main at ec2f7e8 (2026-11-06 second UAT)  
**Delivery:** One PR for this spec, implementation plan, and eventual implementation. This initial draft is documentation-only.

## Player outcome

Creating a new Bus or Metro line tells the player what the initial fleet will **actually cost** before they save. A valid, affordable draft offers **Save & run · $X**. A draft without enough money says **Need $X for the initial fleet; available $Y** and offers **Save without fleet**. That action saves the route as today, but deliberately skips an unaffordable deployment. An existing route edit continues to say **Save route** and never purchases a fleet.

Draw route lines through ordinary road corners without the visible overshoot/hook shown in the attached `uat2-route-line-corner-hook` screenshot. Do not change transit movement or road routing merely to alter the overlay.

## Current architecture and verified findings

- `RouteEditor.svelte` currently hard-codes **Save & run** for creates; `RouteEditorView` in `src/runtime/types.ts` has no draft fleet quote.
- `src/runtime/createGameRuntime.ts` already serializes `createRoute` followed by `deployInitialFleet` in one save operation, deduplicates Saves, and identifies the newly added line by diffing accepted scene IDs. Keep this workflow.
- `crates/caelum-core/src/preview.rs` already resolves draft legs in Rust, but its `RoutePreviewResponse` has geometry and timing only. Its `total_travel_seconds` uses stored leg estimates; it is **not** the live congestion-aware cycle time charged by the fleet purchase.
- `crates/caelum-core/src/service_control.rs` owns the default 600-second target, congestion-aware round-trip calculation, `required_fleet`, `vehicle_cost`, and atomic `deploy_initial_fleet`. `CostPolicy` owns Standard-versus-Creative affordability and deduction.
- Both Tauri and WASM already expose `previewRoute`. The smallest seam is an additive nullable quote on that existing response; no new intent, backend API, or command.
- `src/render/webgpu/transitBatch.ts` draws each route step from the source geometry after shared-corridor offsetting. `src/render/routeGeometry.ts` owns those offsets. Rust `road_topology::transition_geometry` emits a quadratic for right/left turns with a control point extending along the entering heading; a turn whose endpoints lie on the outgoing road row can consequently bulge beyond that row, matching the reported hook. Confirm with a real path fixture before selecting the final change.

## 1. Rust-derived quote on the existing draft preview

Add two explicit nullable fields to Rust `RoutePreviewResponse`, mirrored in `src/runtime/backend/types.ts`:

- `initialFleetCost: number | null`: **effective amount payable on Save & run**, after the existing economy preset. Standard displays the authoritative required-fleet purchase price; Creative displays $0 because the charge is waived.
- `initialFleetAffordable: boolean | null`: `CostPolicy`'s affordability decision using the same snapshot as the quote. In Creative, this is true when a valid fleet quote exists.

Populate these only for a **new**, fully connected, valid Bus/Metro draft with a calculable service cycle. Edits, rejected/partial drafts, and non-service modes return explicit nulls. Return null rather than manufacture a numeric price when requirements cannot be computed.

Use one small Rust helper shared by the preview quote and `deploy_initial_fleet` to compute the **initial fleet requirement and nominal price** using existing service-control logic: live `vehicle_step_seconds` and `round_trip_seconds`, `required_fleet(..., DEFAULT_TARGET_HEADWAY_SECONDS)`, checked multiplication by the existing vehicle price. Make the actual quote through `CostPolicy::from_snapshot(snapshot).quote(nominal, snapshot.budget)`. Expose a tiny read-only payable amount accessor on the existing quote if needed. Avoid duplicating fleet sizing or economy rules in TypeScript and avoid introducing a service-plan abstraction.

Keep the saved line's existing `estimatedDeploymentCost` and its current semantics unchanged; this ticket is about the new-draft purchase before saving. The preview quote is informational. The real deployment still recomputes and authorizes against current gameplay state.

Normalize nullable quote fields across WASM/Tauri in `normalizeRoutePreviewResponse` (a WASM `None` may arrive as `undefined`). All preview fixtures must use the same explicit null contract.

## 2. Draft footer and save semantics

Derive a minimal create-only `initialFleetCost` and `initialFleetAffordable` view from the **current-generation** draft preview in `selectRouteEditorView`. Reuse `formatBudget`, the current route status/warnings, and current game budget for the explanatory copy; the displayed price and affordability always come from Rust.

- Valid + affordable + quote present: primary button **Save & run · $X**; no warning.
- Valid + unaffordable + quote present: clear non-blocking warning with both quoted cost and available money, and button **Save without fleet**. Saving must still be enabled.
- Still checking/rejected/disconnected/quote unavailable: retain the disabled Save and useful status; do not display an invented zero price.
- Edit source: existing **Save route** action, unchanged by the quote fields.

At Save-click time, capture the **current, valid preview's** affordability decision together with the existing draft instance/generation token. For a new draft that the player explicitly saved **without** fleet, perform the existing `createRoute` and commit the accepted route, but **skip** `deployInitialFleet`. For **Save & run**, keep the current accepted-create-then-deploy flow. Do not build a second save handler or change `CreateRoute`'s fleet-free Rust contract.

If cash or traffic changes between preview and deployment, Rust remains authoritative. An initially affordable preview can still encounter a real deployment rejection: retain the created line, show the existing budget failure, and leave manual Deploy available. An outdated preview response cannot replace the current draft because the runtime already checks its epoch, instance, and generation. Preserve the existing Save de-duplication and superseded-draft behavior.

## 3. Corner rendering: fix only the visible route stroke

Start with the UAT's L-corner and a simple Rust-style two-step right/left-turn fixture. Capture (a) source turn geometry, (b) `offsetForRoute` result and (c) final `buildTransitBatch` vertices. This identifies whether the visible bulge originates in the source quadratic, the corridor offset, or both.

The expected fix is **render-only**, localized to the transit route stroke geometry/drawing helper in `src/render/webgpu/transitBatch.ts` (or one small adjacent pure function): render ordinary 90-degree turn steps as a clean turn through the adjoining road-tile point, without the quadratic control-point excursion, while maintaining a continuous path when neighboring corridor offsets differ. Apply consistently to committed lines, emphasized halos, broken-line dashes, and draft strokes as relevant. Preserve line width and existing shared-corridor separation; avoid a new generic stroke/join engine.

Do **not** alter the Rust `PathGeometry` used by vehicle movement, change routes, change the map topology, or modify roundabout/U-turn geometry unless a targeted reproduction proves it necessary. If the minimal isolated test shows the real problem is solely in an existing offset helper, fix that helper instead and retain original movement geometry. Use the test to justify the final choice; do not blindly change both layers.

## Non-goals

- No panel docking, new HUD, library/menu styling, map sprites, WebGPU overhaul, art, or SFX. These are HPA-678 / HPA-676 / HPA-696.
- No new save or fleet intent, host method, economy system, schema migration, or backward-compatibility layer.
- No new automatic fleet management, bankruptcy handling, stop dwell times, routing algorithm changes, or unrelated UAT findings.
- No new PR for each implementation phase: all code and tests stay in **this same PR** after design review.

## Acceptance criteria

1. A new connected Bus and Metro draft shows a Rust-derived effective price and offers **Save & run · $X** when affordable.
2. Insufficient-budget Standard drafts warn with needed and available amounts **before Save**, and **Save without fleet** creates one line with zero vehicles and no attempted deployment. Creative can start service for $0 effective charge.
3. Edit Save stays unchanged. Rejected create, duplicate click, superseded draft, and deployment-time budget rejection keep their existing safe behavior.
4. The price/required fleet uses Rust's current traffic-aware cycle rule and stays consistent with a same-state actual fleet purchase, including a route needing multiple vehicles.
5. L-corner route strokes have no bump/hook, including under shared-corridor offsets; straight lines, roundabout arcs, dashed broken legs, and draft visibility remain correct.
6. Focused Rust, TS selector/UI/runtime, WebGPU vertex, and existing browser route tests pass. Architecture docs describe the new read-only route-preview quote.

## Tradeoffs

The quote is a point-in-time estimate: the engine re-authorizes at the actual deployment. This is appropriate for a hobby game and avoids new reservation/transaction infrastructure. The corner change should stay visual unless tests show that movement geometry itself is invalid. No screenshots need to become brittle golden-image tests.

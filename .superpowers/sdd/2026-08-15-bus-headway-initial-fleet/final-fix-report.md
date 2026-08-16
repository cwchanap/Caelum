# HPA-624 Final Fix Wave Report

Base branch state: `1e99ba3` (`agent/hpa-624-bus-headway-fleet-plan`)

## Finding 1 — deployment rejection precedence

### What changed

Moved the `vehicle_ids` check in `crates/caelum-core/src/bus_service.rs` to immediately follow route lookup. `DeployBusFleet` now returns `FleetAlreadyAssigned` before checking inactive, disconnected, missing-target, or invalid-target state whenever a bus is already assigned.

The existing zero-fleet/no-target case remains `HeadwayNotSet`.

### Covering tests

- Added `deployment_rejects_existing_fleet_before_target_or_route_state` in `crates/caelum-core/tests/bus_service.rs`.
- The test covers `AssignVehicle` before target setup, a paused route with an existing fleet, and a broken route with an existing fleet.
- Existing `deployment_requires_target_and_existing_route_state` continues to assert `HeadwayNotSet` for a connected route with no target and no fleet.

## Finding 2 — Lines-panel setup and Deploy gating

### What changed

`src/components/hud/panels/LinesPanel.svelte` now renders the Target/Set/Required setup block for bus rows whose authoritative assigned fleet is zero, regardless of paused or broken status. The Deploy button alone requires `noFleet`, a set target, and a Rust-derived required fleet; `noFleet` supplies the active-and-connected gate.

### Covering tests

- Added a LinesPanel test covering paused and broken zero-fleet bus rows: setup controls remain visible and Deploy is absent.
- Added an App shell test covering a paused zero-fleet bus route through the real selector-to-panel path.
- The required routes e2e suite passed, including the Set → Deploy → running-service flow.

## Finding 3 — runtime fake fleet-free bus creation

### What changed

Updated the `createRoute` bus branch in `tests/runtime/gameRuntime.test.ts` to match the real backend: bus creation returns an empty `vehicleIds` list and does not append a vehicle. The Metro branch still creates its initial vehicle. The existing `assignVehicle` fake path remains available for tests that need a running bus service.

### Covering tests

- Migrated the concurrent-save assertion to require one route with zero bus vehicles and zero transit vehicles.
- The full runtime game test file passed with the migrated fleet-free contract.

## Finding 4 — authoritative selector fleet facts

### What changed

`src/runtime/runtimeSelectors.ts` now derives `noFleet` status and `assignedFleet` from `route.vehicleIds.length`. Optional `serviceMetrics` is used only for Rust-derived timing and required/nominal values.

### Covering tests

- Added a selector regression where a bus has a vehicle but `serviceMetrics` is unavailable; the row is Running and reports one assigned vehicle.
- Updated deployed-fleet and Rust-metrics fixtures to explicitly assign vehicles instead of encoding fleet state only in metrics.

## Verification commands and output summaries

Commands were run in the requested order after the fixes:

1. `cargo test -p caelum-core`
   - Exit 0.
   - Core unit tests, bus service (9), economy (11), engine smoke (13), golden sequences (10), and all remaining integration/doc-test suites passed with zero failures.

2. `bun run test:unit`
   - Exit 0.
   - 54 Vitest files passed; 720 tests passed.
   - The WASM artifact was rebuilt because Rust sources changed; only existing wasm-pack metadata/update warnings were emitted.

3. `bun run check`
   - Exit 0.
   - TypeScript passed; `svelte-check found 0 errors and 0 warnings`.

4. `bun run lint:svelte`
   - Exit 0.
   - ESLint completed with no findings.

5. `bun run test:e2e -- tests/e2e/routes.spec.ts`
   - Exit 0.
   - 8 Playwright route tests passed.

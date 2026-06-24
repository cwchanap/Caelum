# Rust Simulation And Commute Requirements Design

## Context

Caelum currently keeps gameplay state and simulation in TypeScript. The Svelte
runtime owns `GameState`, `tickSimulation` advances pure TypeScript helpers,
and the Tauri Rust crate is only a thin desktop host. That boundary has served
the browser-first implementation, but the next direction is to make the
simulation live in Rust while keeping both the browser and Tauri builds
playable.

The current citizen model is also one-shot: a citizen has a home, a destination,
a route plan, and a terminal outcome. Housing and growth waves create citizens,
destination buildings provide deterministic targets, and the first tick attempts
to plan the trip. The new model should separate "a sim exists" from "this sim
has a travel requirement right now" so commute demand can recur by day and later
expand to entertainment, errands, school, or other off-peak travel.

## Goals

- Make Rust the single authority for gameplay state and mutation.
- Keep both browser and Tauri builds playable from the same Rust simulation
  core.
- Preserve the current gameplay surface through the first vertical slice.
- Add daily commute requirements with standard hours and deterministic variation.
- Model a real 24-hour game clock with one in-game day equal to 1,200 real
  seconds at `1x` speed.
- Keep simulation deterministic and testable.
- Reduce TypeScript to UI, rendering, event handling, selectors, and host
  adapter code.

## Non-Goals

- Rewriting the visual design or canvas renderer.
- Adding full citizen life simulation, happiness, wealth, health, or employment
  balancing.
- Adding entertainment, school, errands, or non-commute travel requirements in
  the first pass.
- Improving routing or vehicle behavior beyond what is needed for parity and
  daily commute scheduling.
- Supporting two active simulation authorities long term.

## Recommended Architecture

Introduce a shared Rust simulation crate that owns the gameplay model,
validation, intent handling, ticks, routing, commute scheduling, objectives, and
metrics. This crate is the authoritative implementation for both hosts.

TypeScript remains the frontend coordinator:

- Svelte components collect player input and render shell state.
- Canvas rendering remains imperative and consumes snapshots.
- The runtime manages subscriptions, animation-frame scheduling, canvas
  mounting, and conversion from UI events into Rust intents.
- The runtime no longer edits gameplay state directly.

The Rust core exposes an engine-style facade rather than many scattered
functions. The host API should be shaped around these operations:

```ts
engine.snapshot(): GameSnapshot
engine.dispatch(intent: GameIntent): DispatchResult
engine.tick(deltaSeconds: number): DispatchResult
engine.reset(): GameSnapshot
```

The browser build uses the Rust core through WebAssembly. The Tauri build links
the same Rust crate natively through a thin command/state adapter. Both paths
must call the same core functions and share Rust-level behavior tests so host
adapters cannot drift.

## Host Boundary

The browser adapter should use `wasm-bindgen` for the engine facade and
serde-backed values for structured snapshots and intents. The generated
TypeScript-facing module becomes the runtime's gameplay backend.

The Tauri adapter should keep native Rust state in managed application state or
an equivalent thin wrapper. Tauri commands should delegate to the same
`GameEngine` methods used by the WASM build. Tauri must not grow a second copy
of simulation logic.

The TypeScript runtime may keep reference-equality publishing for UI snapshots,
but gameplay reference equality is no longer its contract. It receives a fresh
`GameSnapshot` or a structured no-op result from Rust and publishes based on
that adapter result.

## Core Data Contracts

### `GameSnapshot`

`GameSnapshot` is the complete read model TypeScript needs to render and select
game state. It should include:

- Game clock and day information.
- Budget, speed, pause state, scenario state, and objective state.
- Map tiles, area assignments, roads, tracks, and road directions.
- Placed buildings and transit node links.
- Transit stops, stations, routes, metro lines, platforms, and vehicles.
- Sims, active travel requirements, active trips, positions, statuses, and
  route plans.
- Metrics and trip outcomes.
- Scenario messages.

The snapshot should prefer stable ids and explicit fields over derived UI-only
state. Expensive UI derivations can stay in TypeScript selectors when they only
depend on snapshot data.

### `GameIntent`

`GameIntent` is a typed command enum for every player action that mutates
gameplay state. The first Rust-owned vertical slice must cover the current
gameplay surface:

- Set pause and speed.
- Paint an area rectangle.
- Place a building with type, origin, and rotation.
- Place road, cycle road direction, place track, and remove at tile.
- Create bus stops, bus routes, metro stations, and metro lines.
- Assign vehicles.
- Rename, recolor, toggle, delete, and otherwise modify routes or lines when
  those operations affect gameplay state.
- Assign routes to platforms.
- Reset the scenario.

Pure UI state such as open panels, hover tile, selected HUD category, and drag
preview may remain in TypeScript. A drag commit becomes one Rust intent; preview
validity can be derived either from snapshot data or from a read-only Rust
validation query if duplication becomes risky.

### `DispatchResult`

Invalid player actions should not throw for normal gameplay failures. Dispatch
returns:

- The current or next `GameSnapshot`.
- Whether the intent was applied.
- A structured rejection reason when the intent was invalid.

Examples of invalid intents include insufficient budget, occupied footprint,
area mismatch, off-map placement, invalid route ids, broken route creation, or
attempting to assign a vehicle to a missing line. Existing silent no-op behavior
can remain silent in the UI, but tests should be able to assert the rejection
reason.

## Commute Requirement Model

Each sim gets a durable travel profile when created. By default, 90% of sims are
workers and 10% are non-workers, assigned deterministically from stable ids.
Non-workers have no commute requirement yet, which leaves room for later
entertainment, errands, or other travel purposes without pretending every sim
has the same daily life.

Worker sims receive one deterministic shift template based on stable id-derived
assignment. These shares apply within the worker population:

| Template | Share | Behavior |
| --- | ---: | --- |
| Standard | 70% | Morning outbound, evening return |
| Early | 10% | Earlier outbound and earlier return |
| Late | 10% | Later outbound and later return |
| Off-peak | 10% | Travel outside the main rush windows |

Leave-time jitter is deterministic. It should be derived from stable ids and
scenario constants, not `Math.random`, wall-clock time, or host-specific random
number generators.

Every in-game day has a real 24-hour clock. At `1x`, one game day lasts 1,200
real seconds, so one real second advances 72 in-game seconds. Existing speed
controls multiply this clock.

Each worker generates recurring daily travel requirements:

1. Outbound requirement: home to assigned workplace during the shift start
   window.
2. Return requirement: workplace to home during the shift end window.

The return requirement for a day is generated only if the outbound requirement
arrived at work that same day. If the outbound trip fails, the sim stays home
for return-trip logic and only the missed outbound demand is counted.

## Trip Lifecycle

The Rust model should distinguish a sim from an active trip.

A sim has stable identity and durable profile data:

- `id`
- `home`
- worker or non-worker profile
- shift template for workers
- assigned workplace for workers when a valid destination exists
- current place or position
- daily commute state

An active travel requirement represents a scheduled demand instance:

- `id`
- `simId`
- purpose, initially `commuteOutbound` or `commuteReturn`
- origin and destination
- scheduled departure window
- deadline
- status
- route plan and current leg when active

This separation avoids terminal one-shot citizens. Completed or failed trips
produce outcomes and metrics, while the sim remains available for future daily
requirements.

## Destination And Workplace Assignment

Housing creates sims deterministically. Destination buildings provide workplace
candidates. Worker sims should be assigned workplaces deterministically from
available destination building tiles.

If no destination exists when a worker is created, the worker has no assigned
workplace and no outbound commute is generated. When a destination is later
placed, unassigned workers can receive deterministic workplace assignments and
start generating future commute requirements. This replaces the current
home-as-destination fallback with a clearer "no requirement yet" state.

When a destination building is removed, workers assigned to its occupied tiles
must be retargeted deterministically to remaining destinations. If no
destination remains, affected workers become unassigned and future commute
requirements pause until a new workplace exists. Active trips affected by the
removed destination are invalidated and resolved according to the same
unserved/failed-demand rules used for broken transit paths.

## Gameplay Parity Scope

The first implementation milestone is a full vertical slice with current
surface parity. Rust must own:

- Area painting and paintability rules.
- Area-gated building placement.
- Housing and destination building effects.
- Budget changes.
- Roads, one-way road presets, track placement, and remove behavior.
- Bus stops, metro stations, bus routes, metro lines, vehicles, route path
  recomputation, and broken-path handling.
- Vehicle movement, boarding, disembarking, transfers, platform capacity, and
  waiting behavior.
- Retargeting after destination changes.
- Route management: names, colors, active toggles, deletion, vehicle assignment,
  and platform assignment.
- Objectives, trip metrics, lateness, unserved demand, and win/loss state.

The Rust implementation does not need to mirror the TypeScript module layout.
It should preserve public gameplay outcomes, not line-by-line internals. Internal
differences are acceptable when tests prove equivalent player-visible behavior.

## Migration Strategy

Migrate as a playable vertical slice:

1. Add the Rust simulation crate and shared boundary types.
2. Build the WASM and Tauri adapters around the same engine facade.
3. Port current state models and player intents needed for the existing tools.
4. Port map, area, building, transit, routing, objectives, and metrics behavior.
5. Add the daily clock, sim profiles, shift templates, recurring commute
   requirements, and active trip lifecycle.
6. Replace TypeScript mutation calls in `createGameRuntime` with Rust engine
   calls.
7. Update selectors/rendering to consume `GameSnapshot`.
8. Retire or isolate old TypeScript simulation code once parity tests cover the
   Rust path.

During migration, TypeScript may retain read-only helpers or fixtures, but it
must not remain an alternate gameplay authority after the vertical slice lands.

## Error Handling

Invalid intents return unchanged state plus a structured rejection reason.
Simulation ticks should be total over normal game states: missing destinations,
broken paths, inactive lines, capacity pressure, invalidated plans, and
unassigned workers are gameplay states, not exceptions.

Host adapter failures are separate from gameplay rejection. WASM initialization
failure, Tauri command failure, serde boundary mismatch, or corrupted snapshot
data should surface as shell/runtime errors because the frontend cannot safely
continue without a valid simulation backend.

## Testing

Rust tests should cover:

- 24-hour clock conversion and speed scaling.
- Day rollover.
- Worker/non-worker profile assignment.
- Shift-template distribution and deterministic jitter.
- Outbound commute generation.
- Return-trip gating after successful outbound arrival.
- Skipping return generation after failed outbound demand.
- Workplace assignment, retargeting, and unassignment.
- Area painting and area-gated placement.
- Building effects and budget changes.
- Road/track placement, route pathing, broken paths, and removals.
- Route creation, management, platform assignment, vehicle assignment, boarding,
  capacity, transfers, and disembarking.
- Metrics, objectives, late demand, unserved demand, and trip outcomes.
- Golden intent sequences that compare important snapshots against checked-in
  fixtures.

TypeScript tests should cover:

- Runtime adapter calls emit the intended `GameIntent`.
- UI-only state remains local and does not mutate gameplay directly.
- Renderers and selectors consume `GameSnapshot` fixtures.
- Browser E2E can play the Rust-backed loop: paint zones, place housing and a
  destination, build transit, run time through commute windows, and observe
  completed commute trips.

## Approved Direction

Use a Rust engine facade shared by WASM and Tauri. Rust owns gameplay state,
intents, ticks, and commute requirements. TypeScript remains the UI and rendering
host. The first milestone should preserve the current gameplay surface while
adding recurring daily commute demand with deterministic worker profiles,
shift-template variation, and a 24-hour compressed game clock.

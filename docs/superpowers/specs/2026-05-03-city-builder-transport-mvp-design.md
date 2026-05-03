# City Builder Transport MVP Design

## Summary

This MVP is a browser-first 2D tile-based scenario game about planning and managing public transport around a growing city. The first scenario is **Growing Suburb**: new neighborhoods appear over time, and the player must keep demand served by building and adjusting buses, metro lines, and a small number of civic anchors that influence growth.

The MVP is not a full sandbox city builder. It is a compact transport scenario with visible individual citizens, readable tile-board visuals, and real-time simulation with pause and speed controls.

## Goals

- Make public transport planning the primary minute-to-minute activity.
- Use a tile-based city board with visible roads, districts, buildings, stops, stations, vehicles, and citizens.
- Support buses and metro as meaningfully different transport modes.
- Simulate individual citizens with simplified trips so the city feels alive without requiring full life simulation.
- Give the player light city-shaping control through civic anchors.
- Win or lose based on meeting transport demand during city growth.

## Non-Goals

- No full road construction.
- No zoning system.
- No utilities, taxes, freight, emergency services, or detailed building economics.
- No full citizen life simulation with households, wealth, health, or complex schedules.
- No procedural infinite sandbox for the MVP.
- No art-heavy pixel animation requirement.

## First Scenario: Growing Suburb

The scenario starts with a small city containing residential districts, job or service destinations, roads, and a limited starting budget. The city grows in waves. Each wave adds new neighborhoods, increases population, or shifts demand toward newly developed areas.

The player must keep the city moving by expanding and tuning the transit network. Growth should feel predictable enough to plan around, but dynamic enough that the player needs to react.

Scenario success is based on demand service:

- Win by surviving all growth waves while keeping late arrivals, unserved citizens, and average wait time below target thresholds.
- Lose if late arrivals or unmet demand stays above allowed thresholds for a rolling time window.
- Use rolling windows so a brief spike creates pressure without instantly ending the scenario.

## Core Loop

1. Inspect city demand, coverage gaps, crowding, late arrivals, and growth forecasts.
2. Pause or slow time.
3. Add or adjust bus stops, bus routes, metro stations, metro lines, vehicle counts, and civic anchors.
4. Resume simulation.
5. Watch citizens travel from homes to jobs or services.
6. Respond when growth milestones add new neighborhoods or shift demand.

## Player Tools

### Inspect

Select tiles, citizens, stops, stations, vehicles, routes, lines, and districts. The side panel shows details and relevant actions for the selected object.

### Bus Stop

Place or remove bus stops on valid road-adjacent tiles. Invalid placements should be blocked by preview feedback before committing.

### Bus Route

Create and edit ordered stop loops. The player assigns buses to a route, which indirectly controls frequency. Routes have colors, occupancy stats, average wait time, and missed boarding counts.

### Metro Station

Place or remove metro stations at valid tiles. Metro stations are expensive and high capacity. They should have a larger service radius than bus stops.

### Metro Line

Connect stations into metro lines and assign trains. Metro ignores road congestion, carries more passengers, and costs more to build and operate.

### Civic Anchor

Place a limited number of anchors such as schools, offices, clinics, or parks. Anchors influence future growth patterns and create additional destination demand. This gives the player light city-shaping control without adding full zoning.

### Remove

Delete player-built transit objects and anchors. Refund rules can be conservative; the MVP only needs predictable behavior, not a deep economy.

## Transport Modes

### Walking

Walking is the baseline access mode. Citizens walk from home to the nearest viable stop or station, between nearby transfer points if needed, and from the final stop or station to the destination.

### Bus

Buses are cheap, flexible, and lower capacity. They run on ordered stop loops using existing roads. The MVP does not need detailed road traffic, but bus travel time should be slower than metro and affected by route length.

### Metro

Metro is expensive, fixed, and high capacity. Metro lines connect placed stations. Metro offers faster travel over longer distances and should become valuable as the suburb expands.

## Citizen Simulation

Citizens are individual agents with simplified state:

- Home tile.
- Destination tile.
- Current position.
- Current trip state.
- Patience or maximum wait tolerance.
- Route plan.
- On-time, late, or unserved outcome.

For the MVP, most trips are commute-style trips between residential and job or service destinations. Citizens do not need broader daily lives.

Citizen trip flow:

1. A trip is generated when scenario time triggers demand.
2. The citizen walks from home to a reachable stop or station.
3. The citizen waits for a vehicle.
4. The citizen boards if capacity is available.
5. The citizen transfers if the route plan requires it.
6. The citizen walks from the final stop or station to the destination.
7. The trip is scored as on-time, late, or unserved.

If a citizen's route disappears, the citizen recalculates once. If no route exists after recalculation, the citizen becomes unserved.

## Routing

Routing should be simple, deterministic, and testable. Citizens choose paths based on estimated travel time across walking, bus, and metro edges.

The router should support:

- Walking from origin to nearby stops or stations.
- Riding bus routes between stops.
- Riding metro lines between stations.
- Transfers between nearby stops and stations.
- Recalculation when the transit network changes.

Advanced traffic modeling, behavior learning, and stochastic route choice are out of scope for the MVP.

## UI Layout

The first screen is the playable board, not a landing page.

Layout:

- Main map canvas dominates the screen.
- Top bar shows money, day/time, population, late arrivals, unserved citizens, average wait, and speed controls.
- Toolbar exposes inspect, bus stop, bus route, metro station, metro line, civic anchor, remove, and overlay tools.
- Side panel changes based on active tool or selected object.
- Scenario panel shows current objective, next growth wave, and win/loss trend.

Interactions:

- Click to select.
- Hover to preview valid placements.
- Click sequence or drag interaction to define routes and lines.
- Escape cancels the active tool.
- Pause and speed controls are always accessible.

Overlays:

- Coverage.
- Crowding.
- Demand.
- Lateness.
- Growth forecast.

## Visual Direction

Use a tile-based city board with visible roads and buildings. District types should be distinct by color and shape. Transit lines should be bold colored overlays. Animated vehicles and citizens provide immediate feedback, but visuals should remain production-light.

The design should prioritize readability over decorative detail. The player should be able to understand coverage, crowding, and failed trips at a glance.

## Architecture

Use a small TypeScript browser game architecture with canvas rendering. Keep simulation state separate from rendering so core behavior can be tested without a browser.

Core modules:

- **Scenario:** Loads the Growing Suburb map, starting city, objectives, growth waves, budget, and win/loss thresholds.
- **Map:** Owns tile data, roads, district and building positions, valid placement checks, and neighborhood expansion.
- **Transit Network:** Owns stops, stations, bus routes, metro lines, vehicles, capacities, and line stats.
- **Citizens:** Owns citizen generation, trip state, walking, waiting, boarding, transfers, lateness, and unserved outcomes.
- **Router:** Computes estimated travel paths across walking, bus, and metro edges.
- **Simulation:** Advances time, applies growth waves, moves citizens and vehicles, collects metrics, and evaluates objectives.
- **UI State:** Owns active tool, selection, overlays, previews, and panel state.
- **Renderer:** Draws the map, overlays, entities, route lines, panels, and interaction previews.

## Data Flow

1. User input mutates UI state or requests a game action.
2. Game actions validate against map and scenario rules.
3. Valid actions update game state.
4. Simulation ticks advance citizens, vehicles, growth, metrics, and objectives.
5. Renderer reads current state and draws the frame.
6. UI panels read state-derived selectors rather than duplicating simulation logic.

## Error And Edge Handling

- Invalid placements show previews and are blocked before committing.
- Broken routes are marked inactive rather than crashing the simulation.
- Citizens whose route disappears recalculate once, then become unserved if no route exists.
- Vehicles with deleted lines despawn safely.
- Scenario thresholds use rolling windows so one brief spike does not immediately lose the game.
- Capacity overflow leaves citizens waiting and records missed boardings.

## Testing Strategy

Testing should focus on simulation correctness and deterministic scenario behavior.

Unit tests:

- Placement validation for stops, stations, and anchors.
- Route creation and route invalidation.
- Citizen trip lifecycle.
- Vehicle capacity and boarding.
- Transfer handling.
- Growth wave application.
- Win/loss threshold evaluation.
- Router path choice across walking, bus, and metro.

Integration tests:

- Run the Growing Suburb scenario for fixed simulated time with seeded data.
- Verify growth waves apply in order.
- Verify metrics change predictably when a basic bus route exists.

Browser smoke test:

- Load the board.
- Place a bus stop.
- Create a simple bus route.
- Toggle overlays.
- Start and pause simulation.

## MVP Acceptance Criteria

- The game opens directly to the Growing Suburb board.
- The player can pause, resume, and change simulation speed.
- The city grows through at least three scenario waves.
- The player can place bus stops, create bus routes, assign buses, and see buses move.
- The player can place metro stations, create metro lines, assign trains, and see trains move.
- The player can place limited civic anchors that affect future growth.
- Citizens generate trips, move through the network, wait, board vehicles, transfer, arrive, become late, or become unserved.
- The UI shows late arrivals, unserved citizens, average wait, crowding, coverage, and next growth wave.
- The scenario can be won or lost based on demand service thresholds.
- Core simulation behavior is covered by deterministic tests.

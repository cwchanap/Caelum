# Building Menu Footprints Design

## Summary

The building workflow will move from a flat tool list to a two-step placement model: the player chooses a building from the Build menu, then chooses a grid tile to place it. Buildings can occupy different footprint sizes, can rotate in 90-degree steps before placement, and can have active simulation effects.

Route creation will move to a separate Route Planning menu so placement and route authoring are distinct interactions.

## Goals

- Split building placement from route planning in the Control Tower.
- Support five initial building types with explicit tile footprints.
- Allow 90-degree rotation before placement.
- Validate the full building footprint before committing placement.
- Make Small House and Large House active by adding deterministic citizens.
- Make Bus Terminal a larger bus-route-compatible transit node.
- Keep the change compatible with the current runtime-owned state, pure simulation helpers, and canvas renderer.

## Non-Goals

- No refunds or construction cost balancing beyond simple placement costs.
- No road construction.
- No dragging or painting building footprints.
- No terminal capacity UI.
- No deep residential economy, household simulation, or zoning system.
- No Civic Anchor placement in the first Build catalog. Existing scenario civic tiles remain, but the old Civic Anchor tool is not exposed in the new menu unless it is added to the building catalog later.
- No route-planning redesign beyond moving existing route tools into their own menu.

## Player Interaction

The Control Tower will group actions into clearer sections:

- **Build:** Bus Stop, Bus Terminal, Metro Station, Small House, Large House.
- **Route Planning:** Bus Route, Metro Line.
- **Global tools:** Inspect and Remove remain available outside Build and Route Planning.
- **Overlay:** Coverage, Crowding, Demand, Lateness, and Growth remain separate.

The previous Civic Anchor menu action is intentionally omitted from the first Build catalog. Existing civic tiles and destination behavior remain part of the scenario.

The building flow is:

1. Player chooses a building in the Build menu.
2. Player optionally clicks Rotate to advance the selected building by 90 degrees.
3. Player hovers the board and sees the whole footprint preview.
4. Player clicks a grid tile to attempt placement.
5. Valid placement commits the building and applies its effect.
6. Invalid placement leaves state unchanged and keeps the building selected.

The clicked tile is the footprint origin. For the first implementation, this origin is the top-left tile of the rotated footprint.

Route Planning keeps the existing sequence interaction: select Bus Route or Metro Line, then click compatible stops or stations to create the route or line.

Escape keeps the current reset behavior and clears selected building, selected route tool, route drafts, hover preview, and rotation back to default.

## Building Catalog

The first catalog contains:

| Building | Base Footprint | Rotated Footprint | Active Effect |
| --- | ---: | ---: | --- |
| Bus Stop | 1 x 1 | 1 x 1 | Creates a normal bus stop node. |
| Bus Terminal | 3 x 2 | 2 x 3 | Creates a bus-route-compatible terminal node with larger coverage. |
| Metro Station | 1 x 1 | 1 x 1 | Creates a normal metro station node. |
| Small House | 2 x 1 | 1 x 2 | Adds 4 citizens. |
| Large House | 3 x 2 | 2 x 3 | Adds 10 citizens. |

Rotation is stored as `0`, `90`, `180`, or `270` degrees. Rectangular buildings use their base footprint at `0` and `180`, and swap width and height at `90` and `270`.

## State Model

Placed buildings become first-class game-state objects with:

- stable id,
- building type,
- origin tile,
- rotation,
- occupied tiles.

Transit node effects remain in the transit network. Bus Stop and Bus Terminal create stop-like nodes. Metro Station creates a station node. The building record owns the physical footprint and rendering; the transit record owns route compatibility, queues, and vehicle interaction.

UI state adds the selected building type and current building rotation. Route drafts remain separate from building selection.

## Placement Rules

Building placement validates the full occupied footprint:

- every footprint tile must be inside the map,
- every footprint tile must currently be `empty`,
- no footprint tile may overlap another placed building,
- no footprint tile may contain an existing stop, terminal, station, or other player-built object.

These rules apply to all Build-menu buildings, including Bus Stop and Metro Station. This intentionally replaces the current road-based Bus Stop and road-or-empty Metro Station placement rule for player-built buildings in this workflow.

Invalid placement returns the original game state and UI state, except hover state may continue to update as the pointer moves.

## Building Effects

Bus Stop creates a normal bus stop node using the existing stop behavior.

Bus Terminal creates a larger bus-compatible node. It can be selected while planning Bus Routes, has a larger coverage radius than a Bus Stop, and renders as a multi-tile footprint. Deeper terminal-specific capacity behavior is out of scope for this pass.

Metro Station creates a metro station node using the existing station behavior.

Small House and Large House create citizens immediately:

- Small House adds 4 citizens.
- Large House adds 10 citizens.

New citizens use one occupied house tile as their home and choose existing job or civic destination tiles deterministically, following the style of scenario growth citizen creation. This keeps test runs stable and avoids adding random seeds.

## Rendering And Preview

The canvas renderer will draw placed building footprints as part of the map layer or a building layer that runs before transit and citizens. Multi-tile buildings should be visually distinct from base district tiles while preserving board readability.

Hover preview draws the whole selected footprint:

- valid preview uses positive placement styling,
- invalid preview uses warning styling,
- preview follows the current rotated footprint,
- preview does not commit state until click.

Coverage overlay must include Bus Terminal coverage with a larger radius than Bus Stop coverage.

## Removal

Remove deletes the whole placed building when any occupied footprint tile is clicked.

If the removed building created a transit node, dependent routes, metro lines, and vehicles are cleaned up the same way current stop and station removal works. Removing a house does not remove already created citizens in this pass; this avoids retroactively invalidating active trips and keeps the first implementation deterministic.

## Data Flow

1. Svelte emits Build, Route Planning, Rotate, Inspect, Remove, or Overlay intents.
2. Runtime updates UI state for tool and building selection.
3. Hover updates UI state with the tile under the pointer.
4. Canvas derives a rotated footprint preview from the selected building and hover tile.
5. Tile click asks UI actions to place, route, inspect, or remove.
6. Placement helpers validate the footprint against map, buildings, and transit occupancy.
7. Valid placement updates game state and applies building-specific effects.
8. Simulation ticks continue to use transit, citizens, map, and objectives from the updated state.

## Error And Edge Handling

- Out-of-bounds footprints are invalid.
- Footprints overlapping non-empty tiles are invalid.
- Footprints overlapping existing player-built objects are invalid.
- A route click on a non-compatible tile is ignored.
- A failed placement does not spend budget or create citizens.
- A failed route creation due to budget keeps the route draft, matching current behavior.
- Escape resets transient UI state to Inspect with no selected building and default rotation.

## Testing Strategy

Unit and integration tests should cover:

- footprint calculation for unrotated and rotated buildings,
- valid placement only when the full footprint is in bounds and empty,
- invalid placement leaving state unchanged,
- Bus Terminal creating a bus-route-compatible node,
- coverage radius including Bus Terminal,
- Small House and Large House adding deterministic citizens,
- Remove deleting a whole building footprint,
- Remove cleaning dependent transit for Bus Stop, Bus Terminal, and Metro Station,
- Escape resetting selected building and rotation,
- Svelte shell rendering Build and Route Planning as separate menus.

The existing smoke test should be updated from direct Bus Stop placement on a road tile to the new Build-menu empty-tile placement workflow.

## Acceptance Criteria

- The Control Tower separates Build and Route Planning.
- The player can select Bus Stop, Bus Terminal, Metro Station, Small House, or Large House before choosing a grid tile.
- The player can rotate selected buildings in 90-degree increments.
- Multi-tile buildings preview and place using their rotated footprint.
- Invalid footprints are blocked without changing state.
- Bus Terminal can participate in Bus Route planning.
- Small House and Large House immediately add deterministic citizens.
- Remove deletes whole building footprints and cleans dependent transit where applicable.
- Core behavior is covered by deterministic tests.

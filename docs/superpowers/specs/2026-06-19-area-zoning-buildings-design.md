# Area Zoning And Building Catalog Design

## Context

Caelum currently treats district identity as tile kind: `residential`, `jobs`,
`civic`, and `park` are prebuilt into the Growing Suburb map alongside a fixed
road grid. Buildings are manually placed through the Build panel, but placement
mostly depends on empty ground, track state, occupancy, and budget. Citizens use
hard-coded starting homes and destination tiles from the prebuilt districts.

This design changes the early city loop so the player allocates areas first,
then places buildings that are valid for those areas. Roads and transit remain
player-managed infrastructure.

## Goals

- Remove the prebuilt residential, jobs, civic, park, and road layout.
- Start the scenario with only a small prebuilt two-lane arterial cross.
- Let players allocate areas by dragging a rectangle on the map.
- Require houses to be built only inside residential areas.
- Add Commercial, Industrial, and Office area types.
- Add representative buildings for the new area types.
- Keep the simulation deterministic and preserve the runtime as the single owner
  of mutable frontend state.

## Non-Goals

- Automatic building growth inside areas.
- Land value, tax, pollution, employment balancing, or happiness systems.
- New raster art assets or detailed building sprites.
- Broad objective redesign beyond keeping the no-starting-citizens scenario
  stable.

## Area Model

Area identity should be separated from infrastructure. The current `TileKind`
mixes terrain, road infrastructure, and district semantics. The implementation
should introduce an explicit area field on tiles, while roads and track remain
infrastructure state.

The player-facing area types are:

- Residential
- Commercial
- Industrial
- Office
- Civic
- Park

Painting an area does not overwrite roads, track, placed buildings, bus stops,
metro stations, or other transit nodes. Invalid tiles are skipped. A tile can be
empty ground with an area assignment, while roads remain roads and tracks remain
a separate layer.

## Scenario Start

The Growing Suburb map starts mostly empty and unallocated. It no longer seeds
residential, jobs, civic, or park blocks. It also no longer seeds the current
multi-column/multi-row road grid.

The only prebuilt infrastructure is a small two-lane arterial cross:

- One horizontal two-lane road through the middle of the map.
- One vertical two-lane road through the middle of the map.
- The roads use the existing dual-bidirectional lane semantics: opposite
  one-way lanes placed side by side.

There are no starting citizens. Citizens enter the simulation when the player
places residential buildings.

## Area Painting UX

The Build panel gets an Area section with one button per area type. Selecting an
area activates an area-paint tool. Dragging from press to release paints the
axis-aligned rectangle bounded by the start and end tiles.

Preview behavior:

- The rectangle is shown before release.
- Valid tiles use the existing green build preview tint.
- Blocked tiles use the existing red invalid preview tint.
- A single-tile drag paints one tile.

Commit behavior:

- On pointer release, the runtime applies one immutable map update for all valid
  tiles.
- Skipped tiles remain unchanged.
- The runtime publishes a new snapshot once, matching the existing road/track
  drag pattern.

The HUD active-tool chip should make the mode explicit, for example
`AREA RESIDENTIAL`.

## Building Catalog

Buildings remain manually placed. Each building definition declares an allowed
area type. Placement requires every footprint tile to be in that area, plus the
existing constraints for budget, occupancy, track, footprint bounds, and transit
node conflicts.

Initial catalog:

| Area | Buildings | Role |
| --- | --- | --- |
| Residential | Small House, Large House | Creates citizens |
| Commercial | Supermarket, Cinema | Creates destination targets |
| Industrial | Factory, Warehouse | Creates destination targets |
| Office | Office Tower, Business Park | Creates destination targets |
| Civic | Clinic, School | Creates destination targets |
| Park | Park Plaza | Creates destination targets |

Residential buildings create citizens deterministically, as current house
buildings do. Non-residential buildings become deterministic destination
candidates for citizen trips. Destination selection should prefer placed
destination buildings instead of old `jobs` or `civic` map tiles.

If a residential building is placed before any destination building exists, new
citizens use their home tile as a deterministic fallback destination. Existing
fallback citizens are not automatically retargeted when a destination building
is later placed; future residential placements use the destination catalog that
exists at placement time. This keeps the first pass deterministic and avoids
unserved trips caused solely by an empty destination catalog.

## Runtime And Data Flow

The runtime remains the only owner of mutable frontend state.

1. The player selects an area type in the Build panel.
2. The runtime records the selected area-paint tool in `UiState`.
3. Pointer down starts an area drag gesture.
4. Pointer move updates the gesture current tile for preview rendering.
5. Pointer release computes the rectangle and applies the area update through a
   pure helper.
6. `commit()` swaps in the new state, redraws the canvas, and publishes a
   snapshot.

Area painting should share the existing drag lifecycle where practical, but it
uses rectangle geometry instead of road drag's axis-locked line geometry.

Building placement stays on the existing selected-building path. The placement
helper becomes area-aware, so the canvas preview and final commit use the same
validity predicate.

## Rendering

Map rendering should show area colors on empty ground without confusing them
with roads, track, and building footprints. Roads remain visually dominant.
Buildings remain filled on top of the map.

Area palette:

- Residential: light green, `#8bcf8b`
- Commercial: warm yellow, `#d8b45f`
- Industrial: muted gray-violet, `#8d7f99`
- Office: blue, `#82a7d8`
- Civic: calm teal, `#5fb8a6`
- Park: dark green, `#4f9a61`

These colors should remain readable with the existing road, track, transit,
preview, and overlay colors.

## Error Handling And Invalid Actions

Invalid area painting is non-fatal and silent: blocked tiles preview red and are
skipped on commit.

Invalid building placement behaves like existing placement failures: no state
change occurs. The preview should explain validity visually by turning red when
the footprint is outside the required area or violates an existing placement
rule.

If the destination catalog is empty, residential placement must still be safe
and deterministic. It must not introduce random destinations, wall-clock
behavior, or nondeterministic citizen IDs.

## Testing

Add focused tests for:

- Growing Suburb starts with no pre-zoned areas.
- Growing Suburb starts with only the starter two-lane arterial cross.
- Area rectangle painting updates valid empty tiles and skips roads, buildings,
  tracks, and transit nodes.
- Single-tile area painting works.
- Building placement succeeds only when every footprint tile matches the
  building's allowed area.
- Small House and Large House create citizens only in residential areas.
- Commercial, Industrial, Office, Civic, and Park buildings become deterministic
  destination candidates.
- Existing road drag, route drafting, and metro placement behavior still pass.

End-to-end coverage should include one smoke flow that paints residential and
commercial/office areas, places a house and destination building, then confirms
the player can still build roads or transit from the starter road network.

## Approved Direction

Use zone-gated manual building placement for this pass. Area painting defines
where buildings are allowed; buildings create the actual population and
destination demand. Automatic growth is left for a later feature.

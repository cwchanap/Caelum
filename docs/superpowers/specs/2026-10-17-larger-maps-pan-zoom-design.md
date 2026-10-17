# Larger maps with pan and zoom design

## Context

Every sandbox was a fixed 28×18 map drawn to fit the board. The engine was
already benchmarked well past what that map can hold (HPA-347, HPA-348,
HPA-640), so the map itself had become the ceiling on how big a transport
network a player can build. The next gameplay slice (service-driven city
growth) also needs room to grow into.

## Goal

Let the player choose a bigger map on New City and move around it with
familiar pan and zoom controls, without changing any gameplay rule.

## Product rule

New City gains one **Map size** choice, stored as
`rules.sandbox.mapSize`:

| Size   | Tiles | Template offset |
| ------ | ----- | --------------- |
| Small  | 28×18 | (0, 0)          |
| Medium | 56×36 | (14, 9)         |
| Large  | 84×54 | (28, 18)        |

Small is the default and is exactly the previous map. Medium and Large place
the same authored template at the center of the map with whole-tile offsets,
so Small Town and Crossroads look and play the same, surrounded by empty
ground. Crossroads' arterials still run edge to edge.

## Rust core

- `SandboxMapSize { Small, Medium, Large }` with `dimensions()` lives in
  `model.rs`; `SandboxSettings.map_size` stores it.
- `SandboxCreationRequest.map_size` is a string validated like the template
  and economy fields (`unknownMapSize`).
- `blank_map(size)` builds the row-major tiles; template authoring goes through
  one centered offset. Crossroads' junction id is computed from its origin.
- Reset rebuilds from the stored rules, so it keeps the size.
- Persistence validates map dimensions against the stored size.
- `SNAPSHOT_SCHEMA_VERSION` becomes 12. Older development saves are rejected,
  not migrated.

## Camera

The camera is `{ zoom, center }` in tiles, or `null` for the fitted
whole-map view.

- It is local view state on `RuntimeSnapshot.camera`. It is never saved and
  never crosses into Rust.
- It lives outside `UiState`, because `resetUi` and Escape rebuild `UiState`
  and the view should not jump when a tool is cancelled.
- It resets to `null` when a city is created or loaded.
- Zoom is clamped to between fit (1) and 96 CSS px per tile. On an axis where
  the whole map fits, the map stays centered; otherwise the view stays on the
  map.
- `getBoardTransform(board, map, camera)` is the one tile↔pixel mapping used
  by the GPU host, pointer mapping, the DOM text overlay, and the e2e helpers.
  With no camera it is exactly the previous fit transform.

### Input

The host owns pointer input and the board's CSS size, so it owns camera input
and reports changes through `onCameraChange`:

- the mouse wheel or trackpad pinch zooms around the cursor;
- the middle button, or Space with the left button, pans under every tool;
- with a click tool (Select, building, stop, demolish click), a left drag
  past 4 px pans, and the click that ends it is swallowed. A press that does
  not move is still an ordinary click. Drag tools (roads, zoning, track) keep
  their strokes.

Buttons and keys go through `RuntimeController.adjustCamera`:

- zoom in, zoom out, and **Fit** buttons in the board's corner;
- arrow keys pan when the map or nothing in particular has focus;
- `+`/`=`, `-`, and `0` zoom in, zoom out, and fit.

## Measured

Small Town, speed 4, Chromium on SwiftShader in this container (software
rendering, so frame times are pessimistic):

| | Small | Large |
| --- | --- | --- |
| One road tile, click to published update | 6 ms | 27 ms |
| Main-thread busy while running | 10% | 21–23% |

Profiling Large found a browser-only bug: serde-wasm-bindgen writes a `None`
scene as `undefined`, so every WASM tick looked like a scene change. The host
re-tessellated the whole map at 10 Hz and dropped vehicle interpolation on
every tick. The WASM backend now normalizes a missing scene to `null`
(Tauri JSON already sends `null`). That cut Large main-thread busy time from
about 60% to 21%.

The largest remaining per-frame cost is the CPU clip-space transform of
the cached map vertices, about 2 ms per frame on Large here. It is left as is
until a real device shows it matters.

## Out of scope

- Free-form or custom map sizes, and resizing an existing city.
- Saving the camera with the city.
- Minimap, follow-vehicle, or rotation.
- New templates authored for the larger sizes.

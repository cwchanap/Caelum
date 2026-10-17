# Larger maps with pan and zoom plan

Design: `docs/superpowers/specs/2026-10-17-larger-maps-pan-zoom-design.md`.

1. **Core map size.** Add `SandboxMapSize` and `SandboxSettings.map_size`;
   validate `SandboxCreationRequest.map_size`; build `blank_map(size)` and
   center the templates; validate dimensions on load; bump the schema to 12;
   regenerate `tests/fixtures/sandbox_templates.json` (only schema and
   `mapSize` change for Small).
2. **Core tests.** Larger sizes center the templates, reset keeps the size,
   and mismatched dimensions are rejected.
3. **Frontend contract.** Add `mapSize` to the TS rules, request, error
   codes, `NewCityRequest`, and fixtures; replace `MAP_WIDTH`/`MAP_HEIGHT`
   with `MAP_SIZES`.
4. **Camera math.** Camera types, clamping, cursor-anchored zoom, pan, and
   button/key actions in `boardTransform.ts`; `getBoardTransform` and
   `canvasToTile` take the camera.
5. **Runtime and host.** `RuntimeSnapshot.camera`, `adjustCamera`, reset on
   create and load; host wheel/drag/Space input, camera-aware drawing and
   vehicle culling.
6. **UI.** Map size picker on New City, zoom buttons on the board, arrow and
   `+`/`-`/`0` keys, camera-aware map text overlay.
7. **Tests.** Camera math, host wheel and pan gestures, runtime camera
   lifecycle, New City size submission, zoom buttons, overlay placement,
   and one Playwright flow that creates a Large city, wheel-zooms, clicks a
   building, drag-pans, and fits. The e2e helpers use the real board
   transform, so the duplicate transform and its test are deleted.
8. **Measure Large.** Profile a running Large city; fix the WASM
   frame-only scene normalization found there.
9. **Docs.** Update `CLAUDE.md` and `docs/architecture.md`.

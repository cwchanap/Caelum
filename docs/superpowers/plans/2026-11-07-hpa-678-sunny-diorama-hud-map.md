# HPA-678 — Sunny Diorama HUD and map — Implementation plan

**Spec:** [2026-11-07-hpa-678-sunny-diorama-hud-map-design.md](../specs/2026-11-07-hpa-678-sunny-diorama-hud-map-design.md)  
**Linear:** https://linear.app/cwchanap/issue/HPA-678/give-the-game-its-new-hud-and-map-look  
**Baseline:** `main` @ `70e0b78`  
**Delivery:** **One PR for HPA-678.** This draft starts as design/plan only; implementation and tests are committed onto the same branch/PR after review. HPA-676 remains a separate art-only task.

## Existing ownership and change map

| Responsibility | Primary files | Keep intact |
| --- | --- | --- |
| Visual tokens and fonts | `src/styles.css`, `index.html`, `package.json`, `bun.lock` | Existing component contracts; offline Tauri fonts |
| Active shell + top bar | `src/App.svelte`, `src/components/Topbar.svelte` | `RuntimeSnapshot` data, pause/speed actions, save ownership |
| Dock/feedback/zoom | `src/components/hud/CommandShelf.svelte`, `src/components/ActionFeedback.svelte`, `src/components/GameCanvas.svelte` | Keyboard/focus semantics, route-draft gate, live region |
| Camera + labels | `src/render/boardTransform.ts`, `src/runtime/createWebGpuHost.ts`, `src/components/MapTextOverlay.svelte` | One view transform for drawing, picking, text and culling |
| Structural map | `src/render/colors.ts`, `src/render/webgpu/mapBatch.ts` | Current SolidGeometry and scene-cache lifecycle |
| Transit/vehicles | `src/render/webgpu/transitBatch.ts`, `vehicleInstances.ts`, `renderer.ts` | Existing route paths and single instanced vehicle pipeline |
| Tests | `tests/ui/appShell.test.ts`, `tests/ui/commandShelf.test.ts`, `tests/render/boardTransform.test.ts`, `tests/render/webGpuHost.test.ts`, `tests/render/webgpuMapBatch.test.ts`, `tests/render/webgpuTransitBatch.test.ts`, `tests/render/webgpuVehicleInstances.test.ts`, `tests/e2e/topbarViewport.spec.ts` | Focus on player outcomes and deterministic invariants |

## Task 1 — Set the visual foundation without building a design framework

1. Add locally bundled Bricolage Grotesque and Inter through Bun (for example, `@fontsource` packages), import only used weights and keep assets included in the Vite/Tauri bundle. Update the HTML document title to `Caelum`.
2. Replace the obsolete dark-console root variables with the warm, light token set. Keep old variable names where they are currently depended on, but remove dead variables and superseded rules in the **same change**. Avoid parallel themes and compatibility shims.
3. Add a small contiguous group of `ui-` CSS styles for button, card, chip, segmented control and field, reused by actual HUD elements. Avoid five independent Svelte component abstractions or a design-system dependency.
4. Check existing central panels still have legible text, sufficient button contrast and visible focus rings after token changes. Their markup/layout remains HPA-696.

**Proof:** offline fonts render with the network disabled; existing panels stay operational. No need to add art or screenshot tests.

## Task 2 — Float the HUD over the existing canvas

1. Refactor only the active-city branch in `App.svelte` to make `GameCanvas` fill the shell, with a top overlay, floating bottom dock and local feedback overlay. Keep all runtime callbacks and other city screens unchanged.
2. In `Topbar.svelte`, add a simple city/save input from `snapshot.persistence` (name, busy, dirty) and build the three visual clusters. Reuse `ShellTopbarState` directly for money, cost, clock, residents, wait, late and unserved. Do not parse and recompute time or gameplay metrics in Svelte.
3. Restyle `CommandShelf.svelte` as a compact bottom-center dock, reordering the two existing tool buttons after the four destinations. Keep the same command-destination toggling, line badges, route-draft gate, shortcuts, `aria-pressed`/`aria-expanded`, focus and test hooks.
4. In `GameCanvas.svelte`, place the current three zoom buttons vertically at bottom left, keeping their existing runtime camera actions.
5. Convert `ActionFeedback`'s visible region into a positioned under-clock toast. Preserve the **always-mounted** sr-only live region, details, dismiss action and route-draft suppression; remove CSS and comments that assume a 72px scrolling strip.
6. Keep `CommandPanel` floating and functional by adjusting only positioning to avoid the new dock and header. Do not dock panels, redesign their bodies or alter route editing.

**Focused tests:** update `tests/ui/appShell.test.ts`, `tests/ui/commandShelf.test.ts` and `tests/ui/actionFeedback.test.ts` to assert real city/save content, actions, accessibility announcements, toast close and route-draft gating. Replace the old grid-specific assumptions, not the underlying gameplay assertions. Update `tests/e2e/topbarViewport.spec.ts` to check the new clusters across its existing 1024, 1280 and 1440 widths with long currency labels.

**Proof:** the HUD floats without stealing map pointer events, no empty feedback band remains, and the old gameplay controls still work.

## Task 3 — Make full-window Fit safe using the single map transform

**Do this before cosmetics that rely on on-screen tile positions.** Full-window rendering must not invalidate the current shared drawing/picking contract.

1. Define one small presentation-only usable viewport derived from the top/bottom HUD layout; expose the same safe insets to the WebGPU host and DOM text overlay using the existing board's geometry/CSS. Avoid adding runtime gameplay state or a second camera owner.
2. Extend `getBoardTransform` and the existing camera helpers as needed to fit/center within the usable rectangle while returning offsets relative to the **full canvas**. Keep `Camera | null` and tile/world coordinates unchanged. Account for the inset when anchoring wheel zoom and keyboard/zoom-button actions.
3. Thread that transform through `createWebGpuHost.ts` drawing, pointer target, pan/zoom and culling, and `MapTextOverlay.svelte` label placement. Board `ResizeObserver` remains the size-change trigger; avoid a per-frame DOM-measurement loop.
4. Check the interaction overlay and zoom controls do not block tiles outside their own hit areas. Leave map picking and Rust route geometry unchanged.

**Focused tests:** add one `boardTransform.test.ts` safe-fit geometry assertion, one host test for pointer/hover mapping under an inset and one `MapTextOverlay` alignment assertion (reuse existing fixtures). Add one e2e player assertion: on a Small map at Fit, a bottom-row tile can still be clicked without the dock hiding it. Keep existing camera pan/zoom tests rather than duplicating an exhaustive view matrix.

**Proof:** Fit shows every map edge outside HUD; the same selected tile maps to the same text anchor after zoom and pan.

## Task 4 — Redraw the structural map in existing geometry

1. Change `colors.ts` and `renderer.ts` clear colour to the Sunny Diorama daytime palette; keep one render palette rather than CSS-reading colours per GPU frame.
2. In `mapBatch.ts`, add subtle stable grass variation, vacant-zone dashed borders, curb/lane hints, roundabout planted island, track sleepers, building roof colour and a small shadow. Use current tile and building data only; no simulation or schema changes.
3. Use an inexpensive coordinate hash to emit sparse primitive trees only for genuinely unused, unzoned cells that are not occupied by buildings, track or other constructions. Do not add state or random number generation to the engine. Existing map revision invalidation automatically removes trees when the world changes.
4. Add a small `gridMode` argument (hidden, faint, normal, or equivalent) to the structural batch. Derive it from the active placement tool and **discrete** on-screen tile-size bands. Include mode in the existing scene-cache key in `createWebGpuHost.ts`; rebuilding on tool or threshold transitions is enough. Avoid changing structural geometry every animation frame.
5. Keep routes, selected paths, overlay colours, cursor badges and text readable against the lighter map.

**Focused tests:** in `tests/render/webgpuMapBatch.test.ts` check hidden vs visible grid, lower alpha at small scale, deterministic trees and removal of trees on a built/zoned tile. Adapt obsolete exact-colour expectations to new palette definitions. In `tests/render/webGpuHost.test.ts`, check structural rebuild on grid-mode change without rebuild on ordinary ticks/pan.

**Proof:** map meaning is immediately readable, decorative placement is stable, and structural tessellation is not coupled to the render frame rate.

## Task 5 — Improve transit markers and vehicles without adding a pipeline

1. Update stop/station marker shapes in `transitBatch.ts` using the existing route/mode colours and geometry helpers. Preserve shared corridor geometry, line strokes and existing selection emphasis.
2. Increase `vehicleInstances.ts` half-extents enough to read at Fit; preserve each instance's world centre, route colour, heading, interpolation, culling and stable ordering.
3. Add a narrow white outer rim inside the existing `VEHICLE_SHADER` via the quad's local coordinates, preserving unrelated-route opacity. Do **not** double the vehicle count, introduce new instance buffers, a second vehicle pipeline or extra draw calls.
4. Retain the existing GPU capture path and picking target semantics; adjust a picking tolerance only if an actual larger-body click test shows an inconsistency.

**Focused tests:** reuse `tests/render/webgpuVehicleInstances.test.ts` and `tests/render/webgpuTransitBatch.test.ts` for centre/order/colour and marker shape. Run existing `webgpuRenderer` tests and one map-inspection e2e flow for visible vehicles/stops. Avoid shader/pixel goldens unless a reproducible failure warrants one.

**Proof:** larger vehicles, stops and stations are distinguishable at Fit without a rendering architecture change.

## Task 6 — Verify real player flow and finish in this PR

1. Run focused tests during each task and then the standard checks:

```sh
bun run check
bun run test:unit
bun run test:e2e
bun run lint
bun run format:check
bun run build
```

Rust is not changing; run `cargo test --workspace` if CI or a touched shared contract demands it, but no new Rust test matrix for a UI-only ticket.
2. Manual UAT in browser at 1024×768, 1280×800, 1440×900 with Small and Large maps: Fit, wheel zoom, pan, place road/stop, zone a lot, observe growth, select/demolish, create and save a line, inspect a vehicle, open Data overlay, save/reload city. Spot-check the offline Tauri font render.
3. Verify at least one full render capture via existing WebGPU tests/Playwright, and ensure UI/HUD work without browser network fonts.
4. Remove obsolete console CSS selectors and brittle tests **within this same PR**. Update `docs/architecture.md` only for the new shell/transform ownership if needed; avoid a parallel documentation project.
5. Before marking ready for review, reconcile the final scope with HPA-678 and confirm HPA-676/677/696 assets, docked panels, menus and textures are still separate.

## Acceptance checklist

- [ ] Floating Sunny Diorama HUD + full-bleed canvas; no 72px feedback band
- [ ] Offline bundled fonts, real city/save state and existing metrics/actions
- [ ] Fit avoids HUD/dock; map geometry, labels and clicks stay aligned
- [ ] Grid is tool-driven and lower contrast at low zoom
- [ ] Warm map, legible vacant zones, roads, track, buildings and deterministic decorative trees
- [ ] Readable vehicles/stop markers without a new GPU pipeline
- [ ] Targeted UI/render/e2e tests and standard checks pass
- [ ] No Rust/wire/save or new artwork work; **one PR for HPA-678**

## Review boundaries

Keep this a UI/rendering improvement, not a new architecture. If visuals require extra GPU buffers/pipelines, state owners, generic components, or a large font/theme framework, prefer the existing geometry/CSS alternative. Wave 3 tasks must be able to replace provisional building/trees with HPA-676 sprites and adopt the shared tokens without redoing simulation or save contracts.

# HPA-978 — Polish the menus, top bar and map markers — Design specification

**Linear:** https://linear.app/cwchanap/issue/HPA-978/polish-the-menus-top-bar-and-map-markers  
**Baseline:** main at `9fdc359c09123f48d6a3adc7a182e619cb50d9ca` (2026-11-25 Pacific).  
**Delivery:** One HPA-978 PR, initially design/plan-only; append implementation and evidence to this PR.  
**Dependencies:** HPA-977 dock polish is merged (#86); HPA-1144 Canvas2D fallback is merged; HPA-979 marker art is merged (#88). No new art or SFX task is needed.

## Goal and reference

Finish the Sunny Diorama menu/HUD and map presentation without changing the existing transport sandbox, city lifecycle or renderer selection. Keep the Svelte UI, Rust simulation authority, six-operation save store and shared frame construction. No new backend methods, simulation rules, renderer pipelines, dependencies, or native-only UI.

The ticket's HTML mockups are the visual authority: `revamp-mockup-menus.html?page=library`, `?page=newcity`, and `revamp-mockup-game.html?theme=day&screen=select`. The comparison PNGs (`07-library-vs-mockup.png`, `08-new-city-vs-mockup.png`, `09-game-vs-mockup.png`, `t3-today.png`, `t2-city-panel.png`) and HPA-979's `t4-marker-style-from-mockup.png` provide contextual evidence. HTML source inspected during planning; comparison images were retrieved but could not be visually rendered in this planning session. Implementation must open the actual references and capture side-by-side evidence at both required viewports. The HTML mockups have a fixed 1440×900 canvas: use that as the reference composition and verify its intended responsive equivalent at 1280×720, not a stretched screenshot. Use actual dynamic values, not hardcoded mockup sample cities/counts/dates.

## 1. Library and shared city rows

**Current:** CityLibraryScreen uses city-library.webp and the app icon. It shows Continue for cities[0], without saved time or Your cities heading. CityList shows a deterministic avatar, always-visible inputs and saved times; the CityPanel shares it and uses activeNameReadOnly because the dock header owns the active name editor.

- Style Continue as the primary card (name, actual savedAt, play icon); style New City as the secondary full-width action with plus icon and template/size hint. Add Your cities and actual count. Keep the left-side card/key art, loading/error/Retry and the existing no-city direct New City flow. Use the existing sorted list, not a separate recent-city heuristic. Continue uses the most recently saved city, including ties as defined by sortCitySummaries.
- Each shared row uses avatar, name, template label (Blank Grid / Crossroads / Small Town), formatted saved time, pencil and adjacent Load/Delete. Preserve the dock's Playing/Active indicator instead of a meaningless Load on the currently active row; the dock header remains the only active-city rename control. Keep two-click Delete, dirty/busy Load gates, active deletion/last-city fallback, failure feedback, scrollable overflow, and accessible unique controls. Long names truncate/wrap without pushing actions out of view.
- Reuse InlineNameEditor.svelte for editable rows (key by city ID, use entityId, real onRename promise); do not maintain two draft mechanisms. Keep CityList.flushCityNames() as the small parent contract: iterate mounted editable row refs, await their existing commit() sequentially and stop on refusal. Keep the existing prevented-mousedown + explicit flush pattern for Continue, Load, New City and armed Delete, and CityPanel header flush ordering. Escape cancels, Enter/blur commits once, a failed rename retains the draft and blocks the destructive/navigation action. Ensure keyed refs are removed on unmount. A separate click during an already-running rename is refused/disabled by the existing persistence busy gate; the player can retry when it releases. Do not add in-flight promise tracking, queues or a second coordination mechanism to InlineNameEditor. Preserve dirty/busy gating and accessibility for keyboard activation.

### City template metadata (required narrow storage change)

CitySummary currently has id/name/createdAt/savedAt only; native CityListRecord deliberately omits snapshot. Although Rust's SandboxSettings already has a template ID, the save store treats snapshot as opaque and Svelte must not parse it. Add required `templateId: SandboxTemplateId` to CitySaveRecord.city and CitySummary, populated once from the validated NewCityRequest when workingSaveRuntime creates the record. Use the existing TS template union and the already-public camelCase serde enum caelum_core::model::SandboxTemplateId in native metadata; no new DTO enum. Keep the template immutable across save/rename/autosave and return it from every summary (including native list/create/update/rename); preserve opaque snapshot, atomic mutations, sort order, one busy gate, and six operations. Move the existing SANDBOX_TEMPLATE_LABELS table from runtimeSelectors.ts into src/domain/catalog/sandboxTemplates.ts; import it in runtimeSelectors, CityList, NewCityScreen and tests/e2e/helpers.ts (replace its TEMPLATE_LABELS) instead of duplicating labels. Art imports stay in the component.

**Decision:** this is a breaking *city-record* metadata change, not a Rust gameplay snapshot change. Use a fresh versioned development store (browser IndexedDB caelum-city-saves-v9/version 9, native city directory cities-v9, advancing both v8 stores together), no migration, dual reads, optional legacy template, per-city snapshot decode or invented labels. Old development cities will not appear in the new store; do not destructively delete old folders/databases as part of this plan. Export DEFAULT_DATABASE_NAME and DATABASE_VERSION from indexedDbCitySaveStore.ts and pass them as page.evaluate arguments in the newCity and cityLibraryOverflow specs (no duplicated version literals). Update seed fixtures, native v9 path/prior-v8 isolation tests and current architecture docs. No core snapshot schema bump solely for an outer metadata change. The native host still implements the same six store commands; unit/contract tests cover its new wire fields.

## 2. New City

Use existing city-library.webp key art as the background. Use the same Sunny Diorama card styles; match the mockup's two-column form and illustrated choice cards. Preserve native radio groups/keyboard navigation (hide dots visually, not with display:none; card focus/checked styles and whole-card hit area). Keep existing templates, map sizes, economy rules and Create/Cancel/error/busy behavior. Template illustrations stay the existing WebPs; show descriptive labels as in the mockup. Prefill `Riverside` (mockup sample, editable); keep existing Crossroads / Small / Standard defaults, as Medium in the mockup is an example and no default-size change was requested. Trim and reject blank names; immediate Create must work with the prefilled valid name. Preview fills its rectangular frame, with no square cream letterbox dominating the preview (crop the existing source's letterbox with a documented aspect-ratio crop, no new art; don't distort the map); caption updates template, real MAP_SIZES dimensions, and economy on every selection. Retain cancel/back semantics on a non-empty library; first-run must not provide a dead-end Back action. Reuse existing key art and icon; no external font dependency.

## 3. HUD and favicon

- Topbar.svelte: a grid with symmetric minmax(0, 1fr) side tracks and an auto center track, true independently centered clock/speed cluster and fixed-size round play/pause icon. Center relative to the full topbar, not remaining space or dock stage. Constrain both side clusters to their tracks (min-width: 0, max-width: 100%, border-box; align city at start and stats at end). Ellipsize city name/trip-issue chip where needed while retaining title and accessible text; compact gaps, padding and readout sizing as needed across the full existing viewport matrix, not only the <=1199px breakpoint. Preserve all existing required stats/readouts and a visible, focusable, unclipped save Retry/error. Use tabular numerals and stable clock width. Extend the existing stressed topbarViewport.spec.ts matrix to 1024×768, 1280×720, 1280×800 and 1440×900; assert |clockCenterX − topbarCenterX| ≤ 1 CSS px for long/short names, pause/resume and 1/2/4× changes, with existing long-value, trip-warning and save-Retry geometry checks. Ensure no overlap, clipped required readout values or hit-target loss; do not hide existing required stats to fit. Keep accessible Pause/Resume labels, aria-pressed, existing controller callbacks and shortcut behavior. Selected speed is a white pill with readable foreground, including paused state.
- Remove only the blueprint crosshair pseudo-element (.shell::before); preserve canvas insets, map camera/dock resize behavior and pointer events. No HUD redesign beyond ticket.
- Add a Vite-resolved rel=icon in index.html from existing src/assets/sunny-diorama/brand/app-icon.png. Confirm production build URL resolves with image content (no 404/default favicon). No new asset generation.

## 4. Map and track input

### Track gesture: frontend only

Current createGameRuntime.intentForToolClick can dispatch layTrack; commitDrag treats <=1 tile as a tap. roadMutations.roadMutationForUi also previews layTrack for idle hover or one-tile drag. Make Track a >=2 **distinct axis-locked tiles** drag gesture, not a click. Return no track intent on click, explicitly no-op on short track commit (including drag retract, same tile and pointer jitter), and clear stale drag/quote using existing invalidation. For idle Track or one-tile gesture return null from roadMutationForUi; return the visible and accessible Drag at least two tiles cue in mapTextOverlay.ts cursorBadgeText's track case when roadMutationForUi returns null (check before stale/pending preview branches); no false $500 purchase quote. Valid multi-tile drags keep pending/current-generation price and rejection feedback. Multi-tile drag keeps layTrackLine and Rust preview/dispatch; preserve affordable-prefix and rejection behavior, undo/refund, road clicks/cycling, remove/area gestures and save gating. A valid drag may place only one affordable tile or later demolition can leave an isolated tile; do not change Rust legality, budget or pathfinding for those cases. Delete the single-tile layTrack members of the TS GameIntent and RoadMutation unions, the undo-intent allowlist entry, the tool-click intent and mutationIdentity branches and any remaining TS callers/mocks. Replace obsolete single-tile frontend tests with no-op assertions or valid multi-tile fixtures. Keep the Rust LayTrack intent and RoadMutation variants for existing core tests/internal callers; do not change core APIs.

### Align vehicles and road chevrons

vehicleInstances.ts samples the exact presented corridor geometry also used by transitBatch and picking. renderer.ts shader and canvas2d/renderer.ts apply another perpendicular VEHICLE_LANE_OFFSET_PX=8 after sampling; remove this extra shift from both and remove the now-unused constant. Body center, world positions, culling and pickMapTarget must agree with sampled route, including curves, both directions, shared corridors, parked/terminal and metro vehicles. This fixes the bus and intentionally keeps the same centerline rule for metro; no Rust step/position edits. Update tests/e2e/mapInspection.spec.ts to use the sampled point directly as the rendered body center, removing the obsolete offset import/helper calculation without weakening visible vehicle picking assertions. Preserve interpolation, orientation and rim. Structural one-way arrows and placement-preview arrows already precede committed lines (mapBatch and overlayBatch); verify the actual overlap and keep road lane chevrons below route/draft strokes, adjusting ordering only where needed. Keep selected route direction arrows distinct; don't remove navigation cues.

### Trees

mapBatch.drawTrees currently excludes roads/track/zoning/structures and occupied building tiles. Extend its exclusion set using present bus stop/station positions (not a roadAccess tile, not tombstones), plus all existing building footprint tiles. Suppress both tree canopy and shadow; scene change must invalidate structural cache on place/remove and save/load. Use existing deterministic tree seed; removing the obstruction restores tree on eligible land. No simulation foliage state.

## 5. Integrate six merged transit sprites

Files under src/assets/sunny-diorama/markers/ (HPA-979 README defines layer/tint/orientation):
- bus-stop.webp + bus-stop-ring.webp
- metro-station.webp + metro-station-ring.webp
- track-straight.webp (west–east), track-corner.webp (west–north).

**Atlas and frame:** Append the six validated 192×192 layers to existing tree/building atlas, keep previous layer order and dimensions/mip behavior. Both renderers consume the same decoded images; no separate art loader. Extend the shared sprite instance layout with RGBA tint (default 1,1,1,1, including existing trees/buildings/rails); document named offsets and update host transforms, GPU descriptors/WGSL, Canvas2D, fixtures and benchmarks together. For premultiplied source texels multiply RGB by tintRGB * tintAlpha and alpha by tintAlpha. Canvas2D uses the identical frame tint semantics; for the white mask reuse a small cached source-in tinted canvas keyed by layer+RGB and apply opacity at draw time. Clear the tint cache in renderer.destroy() together with activeImages; never re-tint or read pixels per frame. Untinted images draw directly, but **both sprite ranges must honor UV-scale source cropping** (see below). No new dependency, pipeline, per-marker GPU draw or atlas.

**Canvas2D source rectangles:** The current renderer intentionally draws the whole image because all old sprite UVs represented full validated images and float32 rounding could exceed the natural dimensions. Half-rail sprites invalidate that assumption. Decode the origin-anchored source rectangle from each row, using sw = Math.min(image.naturalWidth, Math.round(uvScaleX * SPRITE_ATLAS_WIDTH)) and sh = Math.min(image.naturalHeight, Math.round(uvScaleY * SPRITE_ATLAS_HEIGHT)). Use the original decoded image dimensions even for the cached same-size tinted canvas. Keep source origin (0, 0) and existing destination extents/rotation; a 192px straight rail with half UV width draws a 96×192 source, not the full image squeezed into half the destination. Rounding/clamping preserves existing full-image crops (including 192.0000057 float32 overshoot); no new UV-origin field. Share one drawSprites helper across the two ranges, reset transform/globalAlpha after each, and preserve invalid-layer checking. Update the fallback renderer's obsolete whole-image comment. Test the full and half source rectangles, including float32 rounding, plus rendered rotated half-rail seam parity.

**Ordering:** Current frame has structural solids -> one sprite range -> underRoutes/route/draft solids -> vehicles -> overVehicles. Track art is a structural sprite below route lines; badges must remain above committed route strokes/access indicators/cues as the old procedural markers were, not be hidden by lines. Pin the minimal renderer-neutral RenderFrame change in gameplayRenderer.ts: keep existing fields, add only `markerSprites?: SpriteBatch` and `overMarkers?: readonly SolidBatch[]`. The exact painter order is:

1. `solids` — structural solids.
2. `sprites` — structural trees/buildings/rails.
3. `overSprites` — `[underRoutes, committed route solids]` (no draft).
4. `markerSprites` — badge face and rim rows.
5. `overMarkers` — `[routeDraft]`.
6. `vehicles` — existing instances.
7. `overVehicles` — route handles.

Both concrete renderers and host capture use this order; no generalized layer list. WebGPU totals solid-role sizes including overMarkers before any writes and maintains the same role offsets across the split. Pack structural then marker sprite rows in one grow-only sprite buffer/upload before drawing, bind at zero byte offset, draw(6, structuralCount, 0, 0) and draw(6, markerCount, 0, structuralCount) for nonempty ranges, rebind the same pipeline/bind group/quad at the second range after solids. Do not overwrite the first range or combine firstInstance with an extra byte offset. At most two sprite draws; a marker-only frame starts at firstInstance 0. Canvas2D uses the same stages; sum both sprite ranges and overMarkers solids in RenderStats. Keep existing single vehicle draw and all draft/handle/selected-arrow ordering.

**Host cache:** Change routeCache to hold `{ key, vertices, sprites }` returned by one buildTransitBatch pass (reuse routeStyleKey; remove unused nullable map field from the route cache). Structural scene cache still owns rails and trees. Use one shared transformSpriteInstances implementation with two fixed projected cache slots (structural and markers), each keyed by source identity and all four clip-transform factors. The existing transform invalidation clears both slots. Cache hits for unchanged structural/marker arrays must survive intervening calls for the other range; route-style-only selection changes invalidate marker projection without reprojecting unchanged structural sprites, camera change invalidates both. A recolor that increments sceneRevision may invalidate both per existing scene-cache rules; do not change the scene revision model. No per-frame re-tessellation or re-projection of unchanged sprites; no generic cache framework. Update host tests for identity reuse across repeated frames, route-style change and transform change, plus capture/order/empty-range tests in both renderers. Keep deterministic scale/draw-count guards.

**Badges:** buildTransitBatch emits face then rim at each present node's tile center, same scale/orientation; use existing stop/station marker footprint as starting scale and check legibility at Large Fit (~14 px/tile) and max zoom (96 px/tile). Remove duplicated procedural face/rim, keep access indicator, route node cues, route draft handles, picking and no rendering for missing nodes. Existing markerColors/default rim and selection precedence decide rim tint, including unrelated-route opacity. Face stays original colors and full opacity as before; no new route-color rule. Apply tint only to white mask. Maintain cue placement relative to the new visible badge extent; don't change node anchors. Route selection/recolor/edit/deletion/rebuild must update cached markers with no stale color.

**Rail topology:** Use existing hasTrack cardinal adjacency (same as drawTracks/Rust track graph). One literal 16-entry table beside drawTracks in mapBatch.ts maps the four-bit mask (N=1, E=2, S=4, W=8) to art pieces. A piece specifies straight/corner, clockwise rotation in world coordinates, full or west-half crop. The unrotated straight is W–E, corner W–N. A cropped half uses uvScale.x / 2, half the full quad width and a center offset of one-quarter tile toward the connected edge. Use the following decomposition (S=straight full, C=corner full, H=west half; suffix=clockwise degrees). Mask 0 retains the existing compact disconnected procedural indicator for legitimate isolated tiles.

| Mask | Pieces |
| --- | --- |
| 0 | isolated indicator |
| 1 | H90 |
| 2 | H180 |
| 3 | C90 |
| 4 | H270 |
| 5 | S90 |
| 6 | C180 |
| 7 | S90, H180 |
| 8 | H0 |
| 9 | C0 |
| 10 | S0 |
| 11 | S0, H90 |
| 12 | C270 |
| 13 | S90, H0 |
| 14 | S0, H270 |
| 15 | S0, H90, H270 |

Table invariant: each arm exists iff that neighbor exists; corners only for adjacent pairs. Test the table once over all masks, plus representative rendered edge joins/UV transforms with actual sprites (not exhaustive float-array comparisons). Preserve metro station atop track, overlay clarity, routes and picking. Remove replaced procedural strokes. No mutable topology cache, GPU solver or new artwork. Check joins at Fit/max zoom; adjust existing art placement only if needed.

## 6. Risks and verification boundaries

The main implementation risk is the shared sprite stride and second ordered range breaking capture parity (incorrect firstInstance/byte offsets or tint/alpha/ordering). Keep the entire sprite contract change in one independently green checkpoint commit. Mitigate with existing captureFrame tests for WebGPU and Canvas2D plus a focused real-browser Playwright pixel scenario in both modes (hideWebGpu selects the shipping fallback). Preserve deterministic draw-count guards (at most two GPU sprite draws and one vehicle draw). Explicitly check Canvas2D UV cropping and independent host projection-cache reuse. No main-vs-branch timing benchmark absent a measured regression. The fresh storage namespaces are a deliberate pre-release breaking decision, covered by adapter contracts and real browser persistence E2E.

## 7. Scope guardrails

No redesign of HPA-977 dock/route editor/Inspect; only shared CityList styling and save metadata as required. No autosave scheduling changes, Crossroads routing edits, Rust simulation changes, native-only acceptance, platform-specific rendering branch, runtime pipeline replacement, or new art. Keep all changes in this PR, including tests, docs and screenshots (use PR attachments or artifact links; do not commit generated screenshot directories). Implementation must verify against current main if it advances.

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

CitySummary currently has id/name/createdAt/savedAt only; native CityListRecord deliberately omits snapshot. Although Rust's SandboxSettings already has a template ID, the save store treats snapshot as opaque and Svelte must not parse it. Add required `templateId: SandboxTemplateId` to CitySaveRecord.city and CitySummary, populated once from the validated NewCityRequest when workingSaveRuntime creates the record. Use the existing TS template union and the already-public camelCase serde enum caelum_core::model::SandboxTemplateId in native metadata; no new DTO enum. Keep the template immutable across save/rename/autosave and return it from every summary (including native list/create/update/rename); preserve opaque snapshot, atomic mutations, sort order, one busy gate, and six operations. Move the existing SANDBOX_TEMPLATE_LABELS table from runtimeSelectors.ts into src/domain/catalog/sandboxTemplates.ts; import it in runtimeSelectors, CityList and NewCityScreen instead of duplicating labels. Art imports stay in the component.

**Decision:** this is a breaking *city-record* metadata change, not a Rust gameplay snapshot change. Use a fresh versioned development store (browser IndexedDB caelum-city-saves-v9/version 9, native city directory cities-v9, advancing both v8 stores together), no migration, dual reads, optional legacy template, per-city snapshot decode or invented labels. Old development cities will not appear in the new store; do not destructively delete old folders/databases as part of this plan. Export DEFAULT_DATABASE_NAME and DATABASE_VERSION from indexedDbCitySaveStore.ts and pass them as page.evaluate arguments in the newCity and cityLibraryOverflow specs (no duplicated version literals). Update seed fixtures, native v9 path/prior-v8 isolation tests and current architecture docs. No core snapshot schema bump solely for an outer metadata change. The native host still implements the same six store commands; unit/contract tests cover its new wire fields.

## 2. New City

Use existing city-library.webp key art as the background. Use the same Sunny Diorama card styles; match the mockup's two-column form and illustrated choice cards. Preserve native radio groups/keyboard navigation (hide dots visually, not with display:none; card focus/checked styles and whole-card hit area). Keep existing templates, map sizes, economy rules and Create/Cancel/error/busy behavior. Template illustrations stay the existing WebPs; show descriptive labels as in the mockup. Prefill `Riverside` (mockup sample, editable); keep existing Crossroads / Small / Standard defaults, as Medium in the mockup is an example and no default-size change was requested. Trim and reject blank names; immediate Create must work with the prefilled valid name. Preview fills its rectangular frame, with no square cream letterbox dominating the preview (crop the existing source's letterbox with a documented aspect-ratio crop, no new art; don't distort the map); caption updates template, real MAP_SIZES dimensions, and economy on every selection. Retain cancel/back semantics on a non-empty library; first-run must not provide a dead-end Back action. Reuse existing key art and icon; no external font dependency.

## 3. HUD and favicon

- Topbar.svelte: a grid with symmetric minmax(0, 1fr) side tracks and an auto center track, true independently centered clock/speed cluster and fixed-size round play/pause icon. Center relative to the full topbar, not remaining space or dock stage. Give side clusters a shrink/ellipsis policy, preserve stats/readouts, save Retry/error and trip issues. Use tabular numerals and stable clock width. At both target sizes assert |clockCenterX − topbarCenterX| ≤ 1 CSS px for long/short city names, pause/resume and 1/2/4× changes; ensure no overlap, clipping or hit-target loss. Keep accessible Pause/Resume labels, aria-pressed, existing controller callbacks and shortcut behavior. Selected speed is a white pill with readable foreground, including paused state.
- Remove only the blueprint crosshair pseudo-element (.shell::before); preserve canvas insets, map camera/dock resize behavior and pointer events. No HUD redesign beyond ticket.
- Add a Vite-resolved rel=icon in index.html from existing src/assets/sunny-diorama/brand/app-icon.png. Confirm production build URL resolves with image content (no 404/default favicon). No new asset generation.

## 4. Map and track input

### Track gesture: frontend only

Current createGameRuntime.intentForToolClick can dispatch layTrack; commitDrag treats <=1 tile as a tap. roadMutations.roadMutationForUi also previews layTrack for idle hover or one-tile drag. Make Track a >=2 **distinct axis-locked tiles** drag gesture, not a click. Return no track intent on click, explicitly no-op on short track commit (including drag retract, same tile and pointer jitter), and clear stale drag/quote using existing invalidation. For idle Track or one-tile gesture return null from roadMutationForUi; offer a concise Drag at least two tiles cue using existing cursor guidance (no false $500 purchase quote). Multi-tile drag keeps layTrackLine and Rust preview/dispatch; preserve affordable-prefix and rejection behavior, undo/refund, road clicks/cycling, remove/area gestures and save gating. A valid drag may place only one affordable tile or later demolition can leave an isolated tile; do not change Rust legality, budget or pathfinding for those cases. Delete the single-tile layTrack members of the TS GameIntent and RoadMutation unions, the undo-intent allowlist entry, the tool-click intent and mutationIdentity branches and any remaining TS callers/mocks. Replace obsolete single-tile frontend tests with no-op assertions or valid multi-tile fixtures. Keep the Rust LayTrack intent and RoadMutation variants for existing core tests/internal callers; do not change core APIs.

### Align vehicles and road chevrons

vehicleInstances.ts samples the exact presented corridor geometry also used by transitBatch and picking. renderer.ts shader and canvas2d/renderer.ts apply another perpendicular VEHICLE_LANE_OFFSET_PX=8 after sampling; remove this extra shift from both and remove the now-unused constant. Body center, world positions, culling and pickMapTarget must agree with sampled route, including curves, both directions, shared corridors, parked/terminal and metro vehicles. This fixes the bus and intentionally keeps the same centerline rule for metro; no Rust step/position edits. Preserve interpolation, orientation and rim. Structural one-way arrows and placement-preview arrows already precede committed lines (mapBatch and overlayBatch); verify the actual overlap and keep road lane chevrons below route/draft strokes, adjusting ordering only where needed. Keep selected route direction arrows distinct; don't remove navigation cues.

### Trees

mapBatch.drawTrees currently excludes roads/track/zoning/structures and occupied building tiles. Extend its exclusion set using present bus stop/station positions (not a roadAccess tile, not tombstones), plus all existing building footprint tiles. Suppress both tree canopy and shadow; scene change must invalidate structural cache on place/remove and save/load. Use existing deterministic tree seed; removing the obstruction restores tree on eligible land. No simulation foliage state.

## 5. Integrate six merged transit sprites

Files under src/assets/sunny-diorama/markers/ (HPA-979 README defines layer/tint/orientation):
- bus-stop.webp + bus-stop-ring.webp
- metro-station.webp + metro-station-ring.webp
- track-straight.webp (west–east), track-corner.webp (west–north).

**Atlas and frame:** Append the six validated 192×192 layers to existing tree/building atlas, keep previous layer order and dimensions/mip behavior. Both renderers consume the same decoded images; no separate art loader. Extend the shared sprite instance layout with RGBA tint (default 1,1,1,1, including existing trees/buildings/rails); document named offsets and update host transforms, GPU descriptors/WGSL, Canvas2D, fixtures and benchmarks together. For premultiplied source texels multiply RGB by tintRGB * tintAlpha and alpha by tintAlpha. Canvas2D uses the identical frame tint semantics; for the white mask reuse a small cached source-in tinted canvas keyed by layer+RGB and apply opacity at draw time. Never re-tint or read pixels per frame; existing untinted images go straight to drawImage. No new dependency, pipeline, per-marker draw or atlas.

**Ordering:** Current frame has structural solids -> one sprite range -> underRoutes/route/draft solids -> vehicles -> overVehicles. Track art is a structural sprite below route lines; badges must remain above committed route strokes/access indicators/cues as the old procedural markers were, not be hidden by lines. Add one optional marker sprite range between committed route solids and draft solids; use the same existing sprite pipeline, texture, grow-only instance buffer and one packed instance upload with two ranges/firstInstance (at most two sprite draws on WebGPU, zero for empty ranges). Preserve underRoutes, selected route arrows, draft and handles' ordering and capture parity. Canvas2D draws the same two ranges in order. Extend route cache entry to hold solid geometry + marker rows keyed by existing routeStyleKey (scene revision and selected/edited route); structural scene cache owns rails and trees; no per-frame tessellation due to route tint. Update render stats/scale expectations: existing one instanced vehicle draw, at most two sprite draws, no per-object WebGPU draw calls.

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

The main implementation risk is the shared sprite stride and second ordered range breaking capture parity (incorrect firstInstance/byte offsets or tint/alpha/ordering). Keep the entire sprite contract change in one independently green checkpoint commit. Mitigate with existing captureFrame tests for WebGPU and Canvas2D plus a focused real-browser Playwright pixel scenario in both modes (hideWebGpu selects the shipping fallback). Preserve deterministic draw-count guards (at most two GPU sprite draws and one vehicle draw); no main-vs-branch timing benchmark absent a measured regression. The fresh storage namespaces are a deliberate pre-release breaking decision, covered by adapter contracts and real browser persistence E2E.

## 7. Scope guardrails

No redesign of HPA-977 dock/route editor/Inspect; only shared CityList styling and save metadata as required. No autosave scheduling changes, Crossroads routing edits, Rust simulation changes, native-only acceptance, platform-specific rendering branch, runtime pipeline replacement, or new art. Keep all changes in this PR, including tests, docs and screenshots (use PR attachments or artifact links; do not commit generated screenshot directories). Implementation must verify against current main if it advances.

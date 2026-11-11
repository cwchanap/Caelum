# HPA-696 — Right-side docked workspaces — Design

**Linear:** https://linear.app/cwchanap/issue/HPA-696/dock-the-panels-on-the-right  
**Repository:** cwchanap/Caelum  
**Baseline:** main at 0168a57d59387286fea0fae8c97495b97efc9a5a (HPA-676 art merged, 2026-11-11)  
**Delivery:** One HPA-696 PR. This draft begins with specification and plan only; implementation and tests belong on this same PR after review. HPA-677 stays a separate task/PR.

## Player outcome

A player can keep every map tile visible and clickable while building infrastructure or composing a line. Build, Lines, Data, and City use one consistent right-side dock. Inspect becomes a small anchored popover, not a second workspace. The Build/route editor visuals use the already delivered Sunny Diorama assets and shared light-theme tokens.

## Current state, verified on main

- **src/App.svelte** renders GameCanvas, Topbar, InspectPanel, CommandPanel, ActionFeedback, and CommandShelf as siblings in one game-workspace. The command destination and route draft are already in the runtime/UI snapshot.
- **src/components/hud/CommandPanel.svelte** wraps a centred overlay; **src/styles.css** positions panels with full-viewport widths, including a special-case right offset for pinned Lines at 1200–1399px. A route editor can still hide map click targets.
- **src/render/boardTransform.ts** is the one transform for WebGPU, hit-testing, and DOM map labels. Its safeRect uses existing HUD_INSET top=72/bottom=88 and all available board width. **src/runtime/createWebGpuHost.ts** already observes board size via ResizeObserver and recalculates rendering/picking against the measured canvas.
- **src/components/hud/panels/BuildPanel.svelte** uses command-plates and a text-button item list. BUILD_GROUPS and BUILDING_CATALOG already provide item ID/action, building footprint and nominal cost. **src/assets/sunny-diorama/build-categories/** and **build-items/** contain the new 4 category images and item thumbnails.
- **src/components/hud/panels/LinesPanel.svelte** owns route list/service controls and embeds **RouteEditor.svelte** during a draft. RouteEditorView already has waypoint selection, interaction mode, undo/redo, connection status, warnings, initialFleetCost and canSave. ShellRouteListItem.service already has assignedFleet, targetHeadwaySeconds and dailyOperatingCost.
- **InspectPanel.svelte** already renders stop/platform, building and vehicle details, but ShellInspectorState deliberately has no screen coordinates. The GPU host's click handler owns actual hit-testing. The UI can capture a click's screen anchor without adding simulation or wire fields.

## 1. One right-hand dock, with a genuinely narrower map

- Reorganize only the active-city shell: a **game-stage** containing the map and map-local HUD, and an optional **workspace-dock** sibling. Keep Topbar spanning the full top HUD band so the existing three topbar clusters remain legible at 1024px. The dock starts below that band and ends above the bottom controls.
- When a destination is active, use a two-column CSS grid: minmax(0, 1fr) for game-stage and a right column around **360–400 CSS px** (clamped so the map remains usable at the existing 1024px minimum). Without a destination, render a single full-width map column; do not leave an empty dock.
- Position CommandPanel in that right column rather than as an absolute full-screen overlay. Keep its header/Close button and a vertically scrollable content area; remove the centring/pinned-position exceptions and the overlay wrapper that is no longer needed. One active destination still owns one panel.
- GameCanvas/board and MapTextOverlay must remain in the **same** smaller game-stage containing block, so existing ResizeObserver, boardTransform and GPU pick mapping see exactly the resized width. A null (Fit) camera automatically refits to that width; no right-side HUD_INSET, second camera, new runtime setting, manual remount, or saved camera change. If the player is zoomed, preserve that local camera state and let the existing clamp/resize path handle it.
- Keep map zoom controls and the bottom CommandShelf inside the game-stage, using a compact shelf treatment only while the dock is open so controls do not spill into it. Topbar stays above the dock; ActionFeedback stays visible without blocking map tiles. At 1024px the narrower stage must remain functional.
- Existing destination and route-draft gates still apply. A draft keeps Lines active until Save/Cancel; Closing and Escape retain current runtime semantics and focus returns to the triggering shelf button. All map pointer interactions must remain on the uncovered map, including bottom-row stops.

## 2. Inspect: click-anchored popover, not a dock

- Render the existing InspectPanel only when the snapshot contains an inspector and no command destination is open, as today, but position the card near the **last intentional map selection click** in stage-local CSS pixels. Capture that position at the GameCanvas board element for actual canvas clicks, not mousemove/hover, drag releases or zoom-control clicks. Keep the renderer as the sole source of what object was selected.
- Clamp the popover to the visible stage and its top/bottom HUD safe bands; prefer the right/below side of the click when there is room, otherwise flip to the opposite side. A small CSS max-width and max-height make dense platform details scrollable. Avoid an extra global overlay or an observer just to follow a vehicle.
- The popover remains **stationary** while the selected vehicle moves or simulation ticks. A later actual selection click moves it. For selections opened through non-pointer navigation (e.g. Focus a waiting location), use a stable top-right-of-stage fallback until the next click. Escape/Select changes already owned by runtime dismiss it; panel actions still work.
- Store only a small local UI position, reset on city change. No inspector coordinates in Rust, runtime snapshots, saves or wire data. Preserve existing test IDs, focus visibility and service-control actions.

## 3. Build: use the shipped assets and readable item cards

- Replace command-plates with the four **build-categories** images. Delete the now-unused **src/assets/command-plates/** files in this same implementation PR, and keep the current BUILD_GROUPS drilling/back navigation.
- Use the existing **build-items** image whose filename matches a BUILD_GROUPS item ID. Give each item a card with image, name, nominal cost hint (per item or per tile as appropriate), footprint/placement size where defined, and an actionable keyboard number badge where one is assigned. Keep item IDs/actions and aria-pressed/data-testid hooks. A small file-local image lookup is enough; no asset registry package or new backend data.
- Building costs and rotated footprints come from BUILDING_CATALOG/getRotatedFootprintSize. Non-building prices are **display-only hints** sourced from the current documented nominal rules; for multi-tile roads, track, zone paint and demolition, the existing map cursor preview remains authoritative for total cost/impact. If a card has no honest fixed quote, say **Cost shown at cursor** rather than invent a number. Creative mode may display nominal prices but gameplay remains free.
- Support the existing shortcuts (road presets 1/2/3, T for track, R for rotate) and make number badges actually select the visible item when the Build group is open, excluding text inputs, modifier keys and route drafts. At most the first nine visible items receive single-digit quick-select; remaining items stay clickable. Do not silently steal road preset keys outside this Build context.
- Put Rotate and a short active-item description in the Build footer; reuse current selection, footprint and hint data rather than new state.

## 4. Lines and route drafting

- Keep existing line creation, fleet management, line selection, rename, colour, wait-location jump and delete actions. Style each line/service summary as light cards inside the dock; do not cut functional controls to fit the mockup.
- Redraw RouteEditor waypoint list as a **vertical rail** with numbered dots, one per waypoint, alongside the current label. For a saved line use its existing ShellRouteListItem.color; a new line without a known persisted colour uses a neutral/accent provisional rail (do not add a new wire field).
- Keep move-up/down and remove on each selected waypoint row. Group Append, Replace, Insert after, Reverse, Undo and Redo in one compact toolbar, preserving disabled states and keyboard operations. Keep the connection status, warnings, reload/edit conflict recovery and route-pattern control.
- Keep the exact create/edit save distinction already shipped: **Save & run · $X** only when initialFleetCost exists, otherwise **Save & run**; edits say **Save route**. Do not compute fleet price again in Svelte or change canSave/deployment behavior.
- After a successful save, show a concise selected/recently-created line summary using **existing** ShellRouteListItem.service: assigned fleet, target interval and daily operating cost. Use a single presentation-only recently-saved ID if needed, derived from pre/post-save route IDs and cleared when starting another draft/city; no new state machine, network request or wire fields. Omit any unavailable field rather than fabricate it. On failure, preserve existing error/preview behavior.

## 5. Data, City, accessibility and boundaries

- Place DataPanel and CityPanel inside the same dock and use the existing cream card/button/input styling; preserve their existing content, save/busy gates, links to overlays and city-list actions.
- Preserve keyboard reachability, visible focus rings, semantic headings, Escape, disabled actions, topbar and shelf controls, the existing screen-reader feedback region and toast visibility. A dock is a **non-modal region**: do not trap focus or put an invisible pointer-blocking backdrop over the board.
- **Out of scope:** City Library/New City and WebGPU textured building/trees (HPA-677), new art generation (HPA-676 already delivered), new gameplay rules, Rust, Tauri/WASM wire contracts, persistence, screenshot-golden testing, mobile redesign, generic layout/overlay frameworks.

## Acceptance proof

1. At 1440x900 on a Small (28x18) city with an active route draft, a player can click a stop in the bottom rows and see it appended; map and dock never overlap. Repeat a basic click/zoom/Fit check at 1024px.
2. Opening Build visibly narrows the board, shows the four new category tiles and item cards, and Fit shows the full city left of the dock. Closing restores full-width Fit. Keyboard actions and existing build/preview behavior still work.
3. A map click opens Inspect near that click. The popover stays at the same screen position while a vehicle moves; clicking a different object relocates it. A non-click inspector path has a usable fallback.
4. Route editor steps, Save & run price, connection feedback, fleet controls, warning links, Data/City actions, and focus/draft gating survive the layout change.
5. Existing UI/E2E and relevant map transform/host tests pass. Styling is checked with manual UAT at 1024 and 1440, not screenshot snapshots.

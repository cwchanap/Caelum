# HPA-676 — Sunny Diorama art set — Implementation plan

**Spec:** [2026-11-07-hpa-676-sunny-diorama-art-set-design.md](../specs/2026-11-07-hpa-676-sunny-diorama-art-set-design.md)  
**Linear:** https://linear.app/cwchanap/issue/HPA-676/create-the-sunny-diorama-art-set  
**Visual baseline:** merged Sunny Diorama renderer on `main` @ `c383db4` (2026-11-10); branch was originally cut from `70e0b78`. Capture/reference the current game, not that older source.  
**Delivery:** **One PR for HPA-676**, including design documents **and** the approved art/icon files. This is a draft documentation checkpoint, not a second plan-then-code PR.

## Dependency and ownership check

- HPA-678: Sunny Diorama HUD, procedural daytime map, and hashed decorative trees have **merged via [PR #80](https://github.com/cwchanap/Caelum/pull/80)**. Their current output is the backdrop and lighting reference for this art, not a pending dependency.
- **HPA-676:** artwork, reusable prompt README, Tauri icons; can proceed immediately, not blocked by HPA-678.
- HPA-677: future menu markup + building/tree sprite atlas and renderer integration; its HPA-678 prerequisite is satisfied, and **HPA-676 assets remain the blocker**.
- HPA-696: future right-side dock, Build tiles and thumbnails; its HPA-678 prerequisite is satisfied, and **HPA-676 assets remain the blocker**.
- Existing art loading: `BuildPanel.svelte` currently imports old `src/assets/command-plates/*.webp`. Leave those files and imports alone until HPA-696, so the current game keeps working while this asset-only PR merges.

The build catalog gives us exact files without inventing a registry. See `src/domain/catalog/buildGroups.ts` and `src/domain/catalog/buildings.ts` for stable IDs and 192px/tile exports. No new image API, npm package, generation scripts or Rust state are needed for this issue.

## Task 1 — Make one style sheet and request approval (hard gate)

1. Read HPA-676's attached `Three directions (A picked)` and `Game screen in Sunny Diorama` mockups. Use the selected direction, not a fresh redesign.
2. Generate a **single** style reference board showing a small street block, roof/material palette, 3 tree silhouettes, representative building types, and samples **composited on the actual current-main game map** at Small/Medium/Large Fit and maximum zoom. Use live `src/render/colors.ts` for grass `#c3d99a`, road `#5f6d75`, canopy `#3c6b35` and residential lot base `#e0a18c` (drawn translucent); specifically compare terracotta roofs beside empty residential lots. Show a representative sprite at **0° and 180°**, side by side, to prove **rotation-neutral roof illumination**. Keep all map examples strictly top-down orthographic.
3. Place the selected board at `src/assets/sunny-diorama/style-sheet.webp`. Start `src/assets/sunny-diorama/README.md` with the approved palette/material/lighting rules and full reusable prompt prefix. **Do not bake directional lighting/shadows into rotatable sprites**: the existing map renderer already draws +3/+3 world-space shadows, which HPA-677 must preserve/adapt without duplication. Record generator settings actually used; do not claim a seed/model unless reproducible.
4. **Pause bulk art generation until owner approval of this sheet.** Iterate on the sheet **in this existing PR** if the owner requests changes; then treat it as the reference for the remaining assets.

**Proof:** a reviewer can compare the style sheet with direction A **and an actual game screenshot**, verify a 0°/180° pair has consistent illumination and no cropping, and inspect maximum-zoom quality before approving the rest of the exports.

## Task 2 — Generate source map sprites and trees first

1. Use `BUILDING_CATALOG` dimensions, not eyeballed aspect ratios. Generate exactly one **0°-oriented** map sprite for each `buildings/*.webp` ID in the spec (12 total, including busTerminal): **192 output px per native tile**. HPA-677 will rotate that single sprite in the renderer; do not author four versions.
2. Keep sprites free of grass/roads, labels, **directional face shading**, baked cast shadows and overshooting decorations. Roof planes must be evenly lit; allow only rotation-neutral ridge/edge accents. **The world-space +3/+3 shadow already exists in `mapBatch.ts`**; HPA-677 will preserve/adapt it when replacing geometry with sprites. Favor silhouette, colour and a few distinguishing large features. Directional face lighting would require four rotations or shader work and is not part of this ticket.
3. Generate three `trees/tree-{01,02,03}.webp` silhouettes (192×192 with alpha), each canopy **cropped to the image edges without size-setting transparent padding**. Keep shapes distinct. In HPA-677 the renderer scales each source to the **existing deterministic canopy diameter** of `2 × radius`, where radius is 6–9 world px in a 32px world tile (about 12–18px, not one whole tile), preserving current coordinate-hash jitter.
4. Review a contact sheet **on actual current-main map screenshots**, with each sprite at both 0° and 180°, at **42, 21 and 14 CSS px/tile** (Small/Medium/Large Fit approximation) **and at maximum zoom (96 CSS px/tile, 192 device px on a 2× display)**. Check shading, clipping, roof-vs-vacant-lot contrast, fake generated lettering and texture artefacts. Regenerate only sprites that fail.
5. Record per-item prompts/approved variations in `README.md`. Store only selected outputs in Git; keep discarded generations outside the repo.

**Proof:** 12 native-footprint sprites and 3 tightly cropped transparent trees exist, are rotation-neutral and unclipped at 0°/180°, and read at Fit **and** maximum zoom on the actual game palette.

## Task 3 — Produce Build and template illustrations economically

1. Export the four square `build-categories/*.webp` tiles: roads, transit, zones, buildings. Use the same architecture/trees/materials as the approved sheet.
2. Produce all 26 `build-items/{id}.webp` files using the exact IDs in the spec:
   - 5 roads, 4 transit, 6 zones, 11 buildings.
   - **Mechanically derive** the 11 building thumbnails **and** `busTerminal` thumbnail from the corresponding 12 approved sprites; preserve aspect ratio and centre/letterbox inside a transparent 256×256 square. Example: `magick src.webp -resize 256x256 -gravity center -background none -extent 256x256 out.webp`. **Zero independent generations** for these 12 images; keep all 26 required thumbnail files (do not defer to `object-fit` or drop deliverables).
   - Use distinct illustrative scenes for road presets, roundabouts, track, stop/station and the six land-use categories.
3. Produce `templates/blankGrid.webp`, `templates/crossroads.webp` and `templates/smallTown.webp` (square, at least 256px) as **composites from captures of the real fresh Small-map templates on current `main`**, overlaying the approved building sprites at Rust-owned building origins (or using that exact composite as an image-to-image reference). **Read `crates/caelum-core/src/sandbox.rs`**, not `src/scenario/sandbox.ts` (which defines only map size labels): `crossroads` has **paired perpendicular edge-to-edge one-way carriageways**; `smallTown` has two **two-way** roads, four painted area rectangles and exactly six buildings (3 smallHouse, supermarket, officeTower, factory) at the authored origins. `blankGrid` has no authored infrastructure. Avoid text-to-image guessing at road directions and building counts; no production generation script or app code is needed.
4. Spot-check 64px downscaled thumbnails on both warm/cream and darkish selection states. Avoid any baked UI text, money figures, shortcuts, outlines or labels because HPA-696/HPA-677 will draw those in live UI.

**Proof:** all 4 + 26 + 3 menu illustrations have the expected filenames and distinctive readable subjects. Do **not** change `BuildPanel.svelte`, `NewCityScreen.svelte` or the City Library markup.

## Task 4 — Finish City Library key art and the single app mark

1. Create `menu/city-library.webp` at **2560×1440 or greater, 16:9**, keeping quiet, low-contrast space on the **left** for the future foreground card. No generated menu text.
2. Create a single `brand/app-icon-source.png` at **1024×1024** with a clear city/transit mark that reads as a silhouette at 32px. Do not make a second independent logo. The text wordmark stays UI typography.
3. Generate the platform derivatives from that exact source into the existing Tauri icon folder. As directed in HPA-676, the generation workflow is:

```sh
bunx tauri icon src/assets/sunny-diorama/brand/app-icon-source.png --output src-tauri/icons
```

4. Check that `src-tauri/icons/32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns` and `icon.ico` are present and actually replaced. The current repository tracks **16 icon files**, whereas the CLI may generate many additional `android/`, `ios/`, `64x64.png` and other unneeded assets. **Keep only the existing Git-tracked icon filenames** and remove newly generated untracked files; inspect `git status --short src-tauri/icons` and `git ls-files --others --exclude-standard src-tauri/icons` before committing. Do not edit `src-tauri/tauri.conf.json`.
5. Inspect the key art behind a rough left-side menu-card overlay and the icon at 32px/128px. Fix image composition rather than adding application code.

**Proof:** no clash between logo, key art and the approved style; Tauri uses the updated icon names without changing the current config.

## Task 5 — Validate the exports, document prompts, finish this same PR

1. Walk the inventory in the design spec. There must be **50 visual deliverables plus the approved style sheet and generated icon variants**. The source icon is already counted as one of the 50.
2. Validate dimensions and alpha with an image metadata tool available on the generation machine (for example `magick identify`), and visually inspect transparent files on a checkerboard. Check every building width/height against the **unrotated** `BUILDING_CATALOG` footprint, each tree against **192×192 tightly cropped canopy**, and all 12 derived building/terminal thumbnails against their respective source sprites. Verify 0° and 180° render coherently.
3. Confirm all exported filenames are in the specified one folder tree. Keep prompt metadata and chosen-image notes in **one** `README.md` rather than adding generated code or a large asset manifest service.
4. Use WebP for the image exports, PNG only for the app-icon source and Tauri PNG derivatives; avoid checking in discarded generations, model scratch directories, giant lossless masters or duplicate formats. Target visually lossless exports but optimize file size enough for desktop/web bundles. Check **maximum-zoom** artefacts and contrast on actual current-main grass/lot/road colours; do not rely on small thumbnail previews alone.
5. Run `bun run format:check` for checked-in Markdown. If the environment supports Tauri packaging, perform a targeted desktop build/icon inspection. A full gameplay, Rust, WASM or UI test matrix is **not necessary** for assets alone; HPA-677/HPA-696 own integration regression coverage.
6. Use the existing PR for the binary assets and final review. Update its description with a concise inventory and visual QA evidence. Link it to HPA-676 in Linear; mark the ticket complete **only when the assets are approved and delivered**, not when this plan is posted. For **HPA-677/HPA-696's own PRs**, require a small typed asset lookup or completeness test over all `BUILD_GROUPS` items and every non-marker building; missing art must fail visibly or in a targeted test, not silently disappear. Do **not** implement that integration check in this art-only PR.

**Proof:** one reviewable PR contains the spec, plan, selected style sheet, all deliverable art, prompt README and generated icons, with no application code diff.

## Reusable prompt recipe (record actual final prompts in README)

- **Global prefix:** "Sunny Diorama 2D city-building game; straight-down orthographic camera; warm top-left world daylight expressed by renderer-owned shadows; even rotation-neutral roof illumination, no directional darkened roof faces or baked cast shadows; terracotta/slate roofs, calm greens, soft cream streets, gentle material texture, legible stylized silhouettes; consistent outline thickness; no text, no watermark; match approved style sheet and current-main game capture".
- **Map sprite suffix:** "single [type] building in 0° orientation, roof view, native unrotated [W×H] tile footprint, transparent background, rotation-neutral plane shading, no directional roof darkening, no terrain, no baked cast shadow, no perspective; keep art inside bounding box and verify at 0°/180°".
- **Tree suffix:** "one distinct round-canopy tree, top-down, transparent 192×192 with canopy cropped edge-to-edge (no size-padding), no drop shadow, no ground tile; renderer scales canopy to existing hashed 12–18 world-pixel diameter".
- **Build thumbnail suffix (14 independently illustrated non-building items only):** "one immediately identifiable [road, track, stop/station, or zone] symbol or miniature scene; square composition, transparent, readable at 64px, no UI labels". The other **12** thumbnails are mechanically letterboxed exports of approved sprites.
- **City Library suffix:** "wide sunny top-down cityscape, focal detail to right, calm negative space on left, 16:9, no text or menu UI".
- **Icon suffix:** "single bold transit/city glyph with few solid forms, centered in square, readable at 32px, no wordmark".

The issue suggests generating via `codex --model gpt-6.1-terra -c model_reasoning_effort=xhigh`; that is a tool preference, **not a reason to add generation infrastructure to the app**. Any equivalent image-generation workflow must honor the same reference/style checkpoint, rotation-neutral lighting, exact composited template layouts, deliverable sizes and final prompt record.

## Acceptance checklist

- [ ] Owner-approved style sheet on **live main screenshots**, with 0°/180° sample and maximum-zoom quality check
- [ ] 12 footprint-correct, rotation-neutral, alpha-safe building sprites; 3 tightly cropped trees sized by renderer to existing canopy diameter
- [ ] 4 Build categories, **26** catalog-ID thumbnails (**12 mechanically derived** from map sprites), 3 faithful **Rust-layout-composited** New City templates
- [ ] 2560×1440+ City Library background with quiet left area
- [ ] 1024px icon source and the **16 tracked** Tauri icon outputs only, configuration unchanged
- [ ] Clear silhouettes at Fit **and maximum zoom**, including comparison next to actual zoned lots and 0°/180° shading consistency
- [ ] Only asset/docs/icon files; no UI, WebGPU, Rust, data or save changes
- [ ] **Same PR** holds both the present design plan and eventual art deliverables

## Scope handoff

After this PR is approved/merged, HPA-696 may replace `src/assets/command-plates/` references with `build-categories/`, display `build-items/` and dock the panels. HPA-677 may use `templates/` and `menu/` images and construct its WebGPU sprite atlas from `buildings/` and `trees/`, **reusing the existing world-space shadows and hashed tree positions/sizes**. Both consumer PRs should use **typed asset maps or a focused completeness assertion** so missing catalog-ID images fail loudly. Any changes to filenames/footprints needed by those consumers should be corrected **here before merge**, not handled by compatibility shims in their code.

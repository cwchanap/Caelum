# HPA-676 — Sunny Diorama art set — Implementation plan

**Spec:** [2026-11-07-hpa-676-sunny-diorama-art-set-design.md](../specs/2026-11-07-hpa-676-sunny-diorama-art-set-design.md)  
**Linear:** https://linear.app/cwchanap/issue/HPA-676/create-the-sunny-diorama-art-set  
**Baseline:** `main` @ `70e0b78`  
**Delivery:** **One PR for HPA-676**, including design documents **and** the approved art/icon files. This is a draft documentation checkpoint, not a second plan-then-code PR.

## Dependency and ownership check

- HPA-678: HUD, procedural daytime map, light palette and tree placeholders; already in [draft PR #80](https://github.com/cwchanap/Caelum/pull/80). Can proceed concurrently.
- **HPA-676:** artwork, reusable prompt README, Tauri icons; can proceed immediately, not blocked by HPA-678.
- HPA-677: future menu markup + building/tree sprite atlas and renderer integration; blocked on HPA-676 and HPA-678.
- HPA-696: future right-side dock, Build tiles and thumbnails; blocked on HPA-676 and HPA-678.
- Existing art loading: `BuildPanel.svelte` currently imports old `src/assets/command-plates/*.webp`. Leave those files and imports alone until HPA-696, so the current game keeps working while this asset-only PR merges.

The build catalog gives us exact files without inventing a registry. See `src/domain/catalog/buildGroups.ts` and `src/domain/catalog/buildings.ts` for stable IDs and 192px/tile exports. No new image API, npm package, generation scripts or Rust state are needed for this issue.

## Task 1 — Make one style sheet and request approval (hard gate)

1. Read HPA-676's attached `Three directions (A picked)` and `Game screen in Sunny Diorama` mockups. Use the selected direction, not a fresh redesign.
2. Generate a **single** style reference board showing a small street block, roof/material palette, 3 tree silhouettes, representative building types, and samples at UI/Fit scales. Keep all map examples **strictly top-down orthographic**.
3. Place the selected board at `src/assets/sunny-diorama/style-sheet.webp`. Start `src/assets/sunny-diorama/README.md` with the approved palette/material/lighting rules and the full reusable prompt prefix. Record any generator settings actually used; do not claim a seed/model unless reproducible.
4. **Pause bulk art generation until owner approval of this sheet.** Iterate on the sheet **in this existing PR** if the owner requests changes; then treat it as the reference for the remaining assets.

**Proof:** a reviewer can compare the style sheet with the approved game-screen mockup and affirm the direction before paying the cost of making ~50 exports.

## Task 2 — Generate source map sprites and trees first

1. Use `BUILDING_CATALOG` dimensions, not eyeballed aspect ratios. Generate one unrotated native map sprite for each `buildings/*.webp` ID in the spec (12 total, including busTerminal): **192 output px per native tile**.
2. Keep sprites free of grass/roads, labels, baked shadows and overshooting decorations; rely on the renderer's later shadow and rotation. Favor roof silhouette, colour and a few distinguishing large features.
3. Generate three `trees/tree-{01,02,03}.webp` silhouettes (192×192 with alpha). Keep canopy shapes different enough to avoid repeated-looking clones.
4. Review a simple contact sheet on a common grass/road background at **42, 21 and 14 CSS px/tile** (Small/Medium/Large Fit approximation). Regenerate only sprites that are illegible, visually redundant or incorrectly sized.
5. Record per-item prompts/approved variations in `README.md`. Store only selected outputs in Git; keep discarded generations outside the repo.

**Proof:** 12 native-footprint sprites and 3 transparent trees exist, are rotatable without visible clipping and read at expected Fit scales.

## Task 3 — Produce Build and template illustrations economically

1. Export the four square `build-categories/*.webp` tiles: roads, transit, zones, buildings. Use the same architecture/trees/materials as the approved sheet.
2. Produce all 26 `build-items/{id}.webp` files using the exact IDs in the spec:
   - 5 roads, 4 transit, 6 zones, 11 buildings.
   - Reuse/crop the 12 approved map-sprite designs for the 11 building cards and bus-terminal card where possible; **do not pay to independently regenerate an inconsistent illustration of the same building**.
   - Use distinct illustrative scenes for road presets, roundabouts, track, stop/station and the six land-use categories.
3. Produce `templates/blankGrid.webp`, `templates/crossroads.webp` and `templates/smallTown.webp` (square, at least 256px), matching what those actual templates represent. Check `src/scenario/sandbox.ts` for map-size labels; do not invent features in the starter layouts.
4. Spot-check 64px downscaled thumbnails on both warm/cream and darkish selection states. Avoid any baked UI text, money figures, shortcuts, outlines or labels because HPA-696/HPA-677 will draw those in live UI.

**Proof:** all 4 + 26 + 3 menu illustrations have the expected filenames and distinctive readable subjects. Do **not** change `BuildPanel.svelte`, `NewCityScreen.svelte` or the City Library markup.

## Task 4 — Finish City Library key art and the single app mark

1. Create `menu/city-library.webp` at **2560×1440 or greater, 16:9**, keeping quiet, low-contrast space on the **left** for the future foreground card. No generated menu text.
2. Create a single `brand/app-icon-source.png` at **1024×1024** with a clear city/transit mark that reads as a silhouette at 32px. Do not make a second independent logo. The text wordmark stays UI typography.
3. Generate the platform derivatives from that exact source into the existing Tauri icon folder. As directed in HPA-676, the generation workflow is:

```sh
bunx tauri icon src/assets/sunny-diorama/brand/app-icon-source.png --output src-tauri/icons
```

4. Check that `src-tauri/icons/32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns` and `icon.ico` are present and actually replaced; preserve any additional output names needed for installed platforms. Do not edit `src-tauri/tauri.conf.json`.
5. Inspect the key art behind a rough left-side menu-card overlay and the icon at 32px/128px. Fix image composition rather than adding application code.

**Proof:** no clash between logo, key art and the approved style; Tauri uses the updated icon names without changing the current config.

## Task 5 — Validate the exports, document prompts, finish this same PR

1. Walk the inventory in the design spec. There must be **50 visual deliverables plus the approved style sheet and generated icon variants**. The source icon is already counted as one of the 50.
2. Validate dimensions and alpha with an image metadata tool available on the generation machine (for example `magick identify`), and visually inspect transparent files on a checkerboard. Check every building width/height against `BUILDING_CATALOG`, not against its rotated dimensions.
3. Confirm all exported filenames are in the specified one folder tree. Keep prompt metadata and chosen-image notes in **one** `README.md` rather than adding generated code or a large asset manifest service.
4. Use WebP for the image exports, PNG only for the app-icon source and Tauri PNG derivatives; avoid checking in discarded generations, model scratch directories, giant lossless masters or duplicate formats. Target visually lossless exports but optimize file size enough for desktop/web bundles.
5. Run `bun run format:check` for checked-in Markdown. If the environment supports Tauri packaging, perform a targeted desktop build/icon inspection. A full gameplay, Rust, WASM or UI test matrix is **not necessary** for assets alone; HPA-677/HPA-696 own integration regression coverage.
6. Use the existing PR for the binary assets and final review. Update its description with a concise inventory and visual QA evidence. Link it to HPA-676 in Linear; mark the ticket complete **only when the assets are approved and delivered**, not when this plan is posted.

**Proof:** one reviewable PR contains the spec, plan, selected style sheet, all deliverable art, prompt README and generated icons, with no application code diff.

## Reusable prompt recipe (record actual final prompts in README)

- **Global prefix:** "Sunny Diorama 2D city-building game; straight-down orthographic camera; clean warm daylight; terracotta/slate roofs, calm greens, soft cream streets, gentle material texture, legible stylized silhouettes; consistent outline thickness; no text, no watermark; match approved style sheet".
- **Map sprite suffix:** "single [type] building, roof view, native [W×H] tile footprint, transparent background, no terrain, no baked cast shadow, no perspective; keep art inside bounding box; view suited to 90-degree rotation".
- **Tree suffix:** "one distinct round-canopy tree, top-down, transparent 192×192, no drop shadow, no ground tile".
- **Build thumbnail suffix:** "one immediately identifiable [catalog item] symbol or miniature scene; square composition, transparent, readable at 64px, no UI labels".
- **City Library suffix:** "wide sunny top-down cityscape, focal detail to right, calm negative space on left, 16:9, no text or menu UI".
- **Icon suffix:** "single bold transit/city glyph with few solid forms, centered in square, readable at 32px, no wordmark".

The issue suggests generating via `codex --model gpt-6.1-terra -c model_reasoning_effort=xhigh`; that is a tool preference, **not a reason to add generation infrastructure to the app**. Any equivalent image-generation workflow must honor the same reference/style checkpoint, deliverable sizes and final prompt record.

## Acceptance checklist

- [ ] Owner-approved style sheet and prompt README
- [ ] 12 footprint-correct, alpha-safe building sprites; 3 trees
- [ ] 4 Build categories, 26 catalog-ID thumbnails, 3 faithful New City templates
- [ ] 2560×1440+ City Library background with quiet left area
- [ ] 1024px icon source and actual Tauri icon set, configuration unchanged
- [ ] Clear low-scale silhouettes and consistency across menu/map art
- [ ] Only asset/docs/icon files; no UI, WebGPU, Rust, data or save changes
- [ ] **Same PR** holds both the present design plan and eventual art deliverables

## Scope handoff

After this PR is approved/merged, HPA-696 may replace `src/assets/command-plates/` references with `build-categories/`, display `build-items/` and dock the panels. HPA-677 may use the `templates/` and `menu/` images and construct its WebGPU sprite atlas from `buildings/` and `trees/`. Any changes to filenames/footprints needed by those consumers should be corrected **here before merge**, not handled by compatibility shims in their code.

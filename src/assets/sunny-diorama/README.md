# Sunny Diorama — proposed style sheet (HPA-676)

**Status: PROPOSED — awaiting owner approval. No bulk asset generation has been run.**
Tasks 2–5 of the HPA-676 plan are gated on the owner accepting this sheet. Iterate here, in this PR, before generating the remaining exports.

This folder contains the single reference board for the selected **direction A — Sunny Diorama** visual language:

- `style-sheet.webp` — 2560×4380 reference board (live-map palette, material samples, three tree silhouettes, representative building types, a street block, Small/Medium/Large Fit composites, max-zoom 0°/180° proof and a 1:1 texture check).

The board is reference art only, not a runtime asset. The game continues to use the merged HPA-678 renderer and the existing `src/assets/command-plates/` images until HPA-677 / HPA-696 integrate approved art.

## Proposed palette, material and lighting rules

These are the rules the remaining assets must follow **once approved**. They are not yet owner-approved.

### Live map palette (read from `src/render/colors.ts` on current main `c383db4`)

| Role                        | Value                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| Grass / empty tile          | `#c3d99a`                                                                                    |
| Road fill                   | `#5f6d75`                                                                                    |
| Tree canopy (renderer base) | `#3c6b35`                                                                                    |
| Residential lot base        | `#e0a18c`, drawn by the renderer at **45% alpha** over grass (composited result ≈ `#d0c094`) |

The branch this document was drafted on predates HPA-678; the values above were read from the `c383db4` archive used for the screenshots, not from the older branch checkout.

### Proposed material palette

| Material              | Sample    | Use                                                                                          |
| --------------------- | --------- | -------------------------------------------------------------------------------------------- |
| Terracotta roof       | `#ab5a45` | houses, pitched-roof residential; must stay clearly distinct from the vacant residential lot |
| Blue-grey glass       | `#a2b2bc` | office tower roof panels; pale grid/seams only                                               |
| Warm supermarket deck | `#e6b97d` | flat commercial roof, skylights and vents                                                    |
| Slate                 | `#a9b7bc` | factory / warehouse deck                                                                     |
| Cream trim            | `#f7eedf` | parapets, frames, walls at the roof rim                                                      |
| Warm outline          | `#4c3a34` | consistent 2–3 px (at 192 px/tile) silhouette edge                                           |

Trees use deep canopy `#3c6b35` as the base with lighter leaf facets. Avoid pure black, neon accents, dark dispatch-console surfaces, visible lettering, UI labels, money, outlines that read as UI, or baked region shading.

### Camera

- Strict top-down orthographic for every map sprite, tree and map sample. No isometric, perspective, front facade, visible wall below the roof, or ground plane.
- Roof-plan only. A building's identity comes from silhouette, palette, parapet and a few large roof features (skylights, vents, mechanical penthouse), not from tiny fixtures.
- Menu key art may be more cinematic, but must share the palette and architecture.

### Lighting and rotation (the binding rule)

- **No directional lighting or cast shadows baked into rotatable sprites.** The same single texture is used at 0°/90°/180°/270°; a darkened roof face would rotate with the building and read wrong.
- Roof planes are one even tone. Rotation-neutral ridge, parapet, seam, tile-line and edge accents are allowed.
- **No baked drop shadow on the sprite.** The map renderer already draws a world-space `+3/+3` shadow (`rgba(74, 56, 34, 0.25)` in `mapBatch.ts`). HPA-677 must preserve/adapt that renderer-owned shadow and must not duplicate it from the texture.
- The style sheet composites use that same simulated renderer shadow for scale/placement preview only; it is not part of the sprite files.

### Sprite contract (for the later inventory)

- Export **192 output pixels per native tile**; transparent background; no grass, road, lot fill, text, watermark, UI, or baked shadow.
- One **0°-oriented** texture per catalog footprint. The renderer rotates one texture, not four variants.
- Keep art inside the exact unrotated footprint with a small clear inset; no clipping at 0/90/180/270°.
- Trees: 192×192 source, canopy cropped **edge to edge** with no size-setting transparent padding; the renderer scales the canopy to the existing deterministic **12–18 world-px diameter** (not a full tile).
- Readability target: 42/21/14 CSS px/tile Fit at 1440×900 and 96 CSS px/tile maximum zoom (192 device px on a 2× display).

## Reusable prompt prefix

Use this prefix verbatim for every future map sprite/tree prompt, then append the item suffix:

> Sunny Diorama 2D city-building game; straight-down orthographic camera; warm top-left world daylight expressed by renderer-owned shadows; even rotation-neutral roof illumination, no directional darkened roof faces or baked cast shadows; terracotta/slate roofs, calm greens, soft cream streets, gentle material texture, legible stylized silhouettes; consistent outline thickness; no text, no watermark; match approved style sheet and current-main game capture.

**Map sprite suffix**

> single [type] building in 0° orientation, roof view, native unrotated [W×H] tile footprint, transparent background, rotation-neutral plane shading, no directional roof darkening, no terrain, no baked cast shadow, no perspective; keep art inside the bounding box and verify at 0°/180°.

**Tree suffix**

> one distinct round-canopy tree, top-down, transparent 192×192 with canopy cropped edge-to-edge (no size-padding), no drop shadow, no ground tile; renderer scales canopy to the existing hashed 12–18 world-pixel diameter.

**Build thumbnail suffix (only the 14 independently illustrated non-building items)**

> one immediately identifiable [road, track, stop/station, or zone] symbol or miniature scene; square composition, transparent, readable at 64px, no UI labels.

## Generator settings actually used

No generation framework or app code was added. These are one-off offline generations for the proposed sheet only.

### Opencode image tool

- Tool: `experimental_image_generate`.
- The tool's job response named the route **`openrouter/minimax/minimax-h3-image-highspeed`**. This is transcribed from the invocation response, not independently verifiable from the saved JPEG; no seed or sampler was exposed.
- Selected output: `smallHouse-test-03.jpg` (5152×3232), used for the small-house sprite and the 0°/180° proof.
- Discarded: `smallHouse-test-01` and `smallHouse-test-02` (not committed; kept outside the repo).
- References: a crop of the HPA-676 direction-A mockup, and a crop of the HPA-676 “Game screen in Sunny Diorama” mockup.
- Reproducibility: the tool exposed no seed, sampler, step or guidance controls. This is **not** claimed to be reproducible by seed. Provider/model is recorded only because the tool reported it. The style sheet itself is the reference artifact.

**Exact selected prompt (small house):**

> Strict 90-degree overhead map sprite for a 2D city-building game, SimCity-style: you see ONLY the roof of a small suburban house, exactly like a roof plan viewed straight down. A WIDE RECTANGULAR hip roof covered in warm terracotta tiles, a straight ridge line across the long axis, two small cream chimneys, one rooftop skylight, a thin cream parapet rim around the edge. NO front wall, NO facade, NO door, NO windows, NO porch, NO ground, NO perspective, NO 3D tilt, NO isometric angle, NO visible building sides. Both roof halves evenly sunlit, perfectly flat consistent tone, absolutely no directional shading or dark side, no cast shadow. Clean 3px dark warm-grey outline, flat vector shapes with subtle tile texture. Match the cream, terracotta and green palette of the reference images. Single object centred on a perfectly flat solid magenta background (#ff00ff) filling the whole canvas, generous margin, no text, no other objects.

### ElevenLabs image tool

- Tool: `ElevenLabs creative_generate_image` (flow `WBVbJPhWsYidP7GpJ9FB`).
- Model: **`bytedance-seedream-5.5`**.
- Settings returned by the tool: aspect ratio **16:9**, resolution **2K**, background **auto**; **4 variations** per prompt.
- References uploaded to the flow: direction-A mockup crop, current-main map crop, and the proposed small-house sprite. The tool reports these as references on each generation.
- No seed control was exposed. Generation IDs are recorded below for traceability, not reproducibility.

Selected variations:

| Asset         | Selected generation ID | Node ID                |
| ------------- | ---------------------- | ---------------------- |
| `officeTower` | `54D1KyiOGxSJ4QKvEPcw` | `CxEuudGVQ2Pds3hICPAU` |
| `supermarket` | `ghlm7ljCZzt7g4EIrlcU` | `5i23PNQssPyMNK6QFdio` |
| `factory`     | `e09YZ7kDWhSQsaNq0aLH` | `6RWNCEXmcTD2PVoNE3xm` |
| `tree-01`     | `ihJNNJTK8norVuYAJVU5` | `RTjkuUJXJcUHu3oyC0q0` |
| `tree-02`     | `xovKTNlxDliwYXoEknyU` | `8dzdM3uKneF1aZ96T9mZ` |
| `tree-03`     | `NmDof5tjb1A3R1Ycl4yt` | `dRJg66qVjjudx7UMqWbl` |

The other three variations of each set were reviewed and discarded. They remain outside the repo.

**Exact prompts used (ElevenLabs):**

Office tower:

> Match the attached Sunny Diorama style exactly: warm cream and muted blue-grey palette, flat cel vector shapes, clean dark warm-grey outline, subtle material texture, soft even daylight with NO directional face shading and NO cast shadow. Create ONE top-down map sprite: the flat rooftop of a modern square office tower, seen exactly from directly overhead, roof-plan view only. Muted blue-grey glass roof panels in a calm geometric grid, a pale cream parapet rim, one compact grey mechanical penthouse and a small cluster of round roof vents. Strict top-down orthographic, no facade, no doors, no windows on vertical walls, no perspective, no isometric tilt. All roof surfaces evenly lit, no gradient. Single centred object, fully inside the frame with a small margin, transparent background, no grass, no road, no text, no watermark.

Supermarket:

> Match the attached Sunny Diorama style exactly: warm cream, muted ochre and green palette, flat cel vector shapes, clean dark warm-grey outline, subtle material texture, soft even daylight with NO directional face shading and NO cast shadow. Create ONE top-down map sprite: the flat rooftop of a neighbourhood supermarket, seen exactly from directly overhead, roof-plan view only. A square warm sand-coloured roof deck, a long narrow pale skylight strip, a neat grid of small roof vents, a low cream parapet rim, one small grey rooftop air-conditioning block. NO facade, NO shop sign, NO lettering, NO windows on vertical walls, NO perspective, NO isometric tilt. All roof surfaces evenly lit, one flat tone, no gradient. Single centred object, fully inside the frame with a small margin, on a perfectly flat solid magenta background (#ff00ff), no grass, no road, no text, no watermark.

Factory:

> Match the attached Sunny Diorama style exactly: calm slate, cream and muted green palette, flat cel vector shapes, clean dark warm-grey outline, subtle material texture, soft even daylight with NO directional face shading and NO cast shadow. Create ONE top-down map sprite: the flat roof of a low industrial factory / warehouse, seen exactly from directly overhead, roof-plan view only. A wide rectangular pale slate-grey roof deck, two long rows of square skylights, a low cream parapet and a small cluster of round extraction vents; optional shallow monochrome sawtooth ribs running across the roof, all faces the same flat tone. NO facade, NO doors, NO windows on vertical walls, NO loading dock in perspective, NO vehicles, NO perspective, NO isometric tilt. All roof surfaces evenly lit, no gradient, no dark side. Single centred object, fully inside the frame with a small margin, on a perfectly flat solid magenta background (#ff00ff), no grass, no road, no text, no watermark.

Tree 1:

> Match the attached Sunny Diorama style exactly: rounded rich-green tree canopy, flat cel vector shapes, one clean warm-dark outline, subtle leaf texture, even soft daylight with NO directional shading and NO cast shadow. Create ONE tree map sprite seen exactly from directly overhead: a broad rounded deciduous canopy with a slightly scalloped irregular edge and a few large lighter leaf clumps, no visible trunk, no ground, no grass tile, no drop shadow. The canopy is a SINGLE object centred and cropped edge to edge of its own square, leaving no size-setting transparent padding. On a perfectly flat solid magenta background (#ff00ff). No text, no watermark.

Tree 2:

> Match the attached Sunny Diorama style exactly: rounded rich-green tree canopy, flat cel vector shapes, one clean warm-dark outline, subtle leaf texture, even soft daylight with NO directional shading and NO cast shadow. Create ONE tree map sprite seen exactly from directly overhead: a compact rounded canopy with an even, lightly serrated circular edge and layered concentric leaf clumps, slightly darker rich green centre, no visible trunk, no ground, no grass tile, no drop shadow. The canopy is a SINGLE object centred and cropped edge to edge of its own square, leaving no size-setting transparent padding. On a perfectly flat solid magenta background (#ff00ff). No text, no watermark.

Tree 3:

> Match the attached Sunny Diorama style exactly: rounded rich-green tree canopy, flat cel vector shapes, one clean warm-dark outline, subtle leaf texture, even soft daylight with NO directional shading and NO cast shadow. Create ONE tree map sprite seen exactly from directly overhead: a taller, slightly narrow rounded canopy made of a few large overlapping leaf clusters with two small gaps showing through, distinct from a smooth circle, no visible trunk, no ground, no grass tile, no drop shadow. The canopy is a SINGLE object centred and cropped edge to edge of its own square, leaving no size-setting transparent padding. On a perfectly flat solid magenta background (#ff00ff). No text, no watermark.

### Offline post-processing of the selected generations

The generators were not used raw. The selected images were cleaned **offline with Pillow**, outside the repo:

1. Chroma-matte the magenta studio background to alpha, despill the edge; the office variant had a white background and was flood-filled from the border instead.
2. For the representative house, replace every roof-fill pixel with one flat `#ab5a45` terracotta tone and retain only the darker tile/ridge line work. This makes the upper and lower plane fills identical. The first committed sheet used hue/value normalization alone and still had a visible upper/lower brightness split (round-1 review measured roughly `(210, 115, 86)` above vs `(168, 87, 66)` below); that approach was replaced.
3. Flatten the supermarket deck and factory slate deck to one flat material colour, removing generator-baked shadows from the deck; re-add only a neutral office glass grid.
4. Crop to content and fit inside the exact unrotated 192 px/tile footprint with a 3.5% clear inset (non-uniform stretch to the footprint). Trees are scaled to fill a 192×192 square edge-to-edge.

This is why the final sprites pass the 0°/180° check even though the raw generations had directional plane shading and bake shadows. The post-processing is not a production pipeline and is not committed; the final Task 2 art should be generated/prompted to avoid this cleanup.

## Screenshot provenance

The style sheet's map examples are **actual current-main screenshots with proposed sprites composited over them**, not synthesized lookalikes.

- Source: `origin/main` at **`c383db497647a72148a7391b6868fa22808a1d6c`**, exported with `git archive` into the ignored `.superpowers/main-capture/` scratch directory in this worktree. The parent checkout was never used or modified.
- Runtime: `bun install --frozen-lockfile`, `bun run wasm:build`, then `bunx vite --host 127.0.0.1 --port 5281 --strictPort`.
- Browser: Orca built-in browser, 1440×900 CSS viewport, screenshots captured with `orca screenshot` (PNG).
- City setup: the dev-only `window.__caelumRuntime` seam already present in `src/main.ts` on main. Cities were created with `persistence.createCity`, roads/lots painted with the real gameplay intents (`setTool`, `startDrag`, `setDragCurrent`, `commitDrag`), and the camera set with `adjustCamera`. No game code, renderer, shader or UI was changed.
- Composites: Pillow pastes at the game's own tile transform, including the full camera offsets for the 51.4 CSS px/tile street-block panel (the first committed street panel omitted the `-20.5px` vertical offset and was corrected in round 1). For Fit, `fit = min(1440 / (mapW*32), 740 / (mapH*32))`, `tile = 32*fit`, board centred in the 900 px viewport with the renderer's 72 top / 88 bottom HUD insets. Maximum zoom is 96 CSS px/tile. The renderer-owned `+3/+3` shadow is simulated at `rgba(74, 56, 34, 0.25)`. Every pixel outside a pasted sprite and its simulated +3/+3 shadow is unmodified screenshot output.

Raw captures (outside Git, hashes for audit):

| Raw capture                  | What it is                                                                                                 | SHA-256                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `small-fit-smalltown.png`    | Unmodified current-main Small Town, Small Fit (28×18)                                                      | `d945359c1271a85274557fb7f13e33397f065bc3ba28a97bded471790da3051c` |
| `block-small-fit-clean.png`  | Blank Grid Small with the authored street block, Fit                                                       | `f80137d8d728787f84d1188e51d3c6b5615d8c5c303a59e75b0ca51f1c042872` |
| `block-medium-fit.png`       | Blank Grid Medium with the same block, Fit                                                                 | `1b2c9249bb60e26bac96daf31a72827c7af768f7d3b1efe23081ceb08b7ddb47` |
| `block-large-fit.png`        | Blank Grid Large with the same block, Fit                                                                  | `a6ac9f3fc23be3b529741ce5255a282e2a67e4a3d8e26cfe819b92abad27eee3` |
| `block-small-51px-clean.png` | Blank Grid Small at 51.4 CSS px/tile (street-block panel)                                                  | `a5a02cc783b35323d384fb620196bbf0412f93dfb107f1afbcf61b6bc27aed3e` |
| `small-maxzoom.png`          | Small Town Small at maximum zoom (96 CSS px/tile), with the vacant residential lot and existing flat roofs | `72a5538aa991043d8ed58b7267f9c48a39e8293b3faba8d95349465d6049f6ae` |

The board's raw “actual current-main · no proposed art” inset is `small-fit-smalltown.png`, cropped to the board rectangle.

## Review round 1 corrections

- **House roof illumination:** the upper plane was visibly lighter than the lower plane in the first committed board. The roof fill is now one exact `#ab5a45` tone in both planes; matched patch medians on the committed board are identical. The README normalization claim above was corrected.
- **Street-block placement:** the first street panel omitted the screenshot camera offsets, so the houses and supermarket overlapped the road by about 20.5 px. The compositor now applies `off_x`/`off_y`; the house and supermarket bottoms sit exactly on the road's top edge, with no building body pixels in the road; only the renderer-style +3/+3 shadow falls onto the road, as intended.

## Approval gate

**Stop here.** Tasks 2–5 (12 building sprites, 3 trees, Build illustrations, templates, key art, app icon) must not start until the owner approves this sheet, including:

1. the direction-A read against the actual current-main screenshot;
2. the 0°/180° pair on the real vacant residential lot at maximum zoom;
3. the 1:1 texture check at 192 output px/tile.

If the owner requests changes, revise the sheet in this same PR. After approval, this folder and the prompt prefix become the reference for the remaining art.

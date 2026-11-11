# HPA-676 — Sunny Diorama art set — Design specification

**Linear:** https://linear.app/cwchanap/issue/HPA-676/create-the-sunny-diorama-art-set  
**Repository:** `cwchanap/Caelum`  
**Visual baseline:** current `main` at `c383db4` (2026-11-10); HPA-678's Sunny Diorama HUD/map changes are merged (PR #80). This docs branch originated earlier; compare all art against the *merged* renderer, not the old branch snapshot.  
**Delivery:** One art-only PR. This draft starts with spec + plan; the approved assets and prompt README will be committed to **the same PR** after the style checkpoint. Do not open a separate implementation PR.

## Player outcome

Caelum's maps, Build panel, City Library, New City screen and desktop icon all look like one **Sunny Diorama** game: a warm, clean daytime city seen directly from above, with expressive but easy-to-recognize buildings and distinct small-scale silhouettes. Art is authored now; HPA-677 and HPA-696 integrate it later.

The direction is **Sunny Diorama / direction A**, already selected in HPA-676's attached mockups. Use those references for aesthetic direction, but assess contrast, size and lighting against **actual screenshots of the current merged game** (Small/Medium/Large Fit and maximum zoom). The live renderer is authoritative for existing roads, lots, grass, decorative trees and shadows.

## Verified integration boundaries

- `src/components/hud/panels/BuildPanel.svelte` already imports four WebP plates from `src/assets/command-plates/`, and `src/components/hud/CommandPlateGrid.svelte` renders them. **HPA-696**, not this issue, switches Build to the new categories/thumbnails and deletes old plates.
- `src/domain/catalog/buildGroups.ts` owns the exact current Build group and item IDs; `src/domain/catalog/buildings.ts` owns building dimensions and rotations. Match them rather than inventing an art-only taxonomy.
- `src/components/NewCityScreen.svelte` currently offers `blankGrid`, `crossroads`, `smallTown`; `src/components/city/CityLibraryScreen.svelte` is the existing library. **HPA-677** implements their redesign.
- `src/render/webgpu/mapBatch.ts` currently draws untextured buildings **with a world-space +3/+3 shadow**, and deterministic 6–9 world-pixel-radius trees with tile-coordinate jitter. **HPA-677** adds the first atlas/textured drawing pass and texture loading, reusing/adapting that renderer-owned shadow instead of adding a duplicate. This ticket adds no renderer, shader, Svelte, TypeScript, Rust, or game-state code.
- `src-tauri/tauri.conf.json` already lists the existing icons in `src-tauri/icons/`. Replace those icon files **in place** using the Tauri CLI; do not change the config.

## 1. Approved style is the single source of truth

Generate **one reference style sheet first**, not fifty loosely related images. The sheet should show: grass/road/roof material swatches; a small street with terracotta/slate/glass buildings; three top-down tree shapes; and samples **composited over actual current-main map screenshots** at typical UI/Fit scales and maximum zoom. Include an example sprite at **0° and 180°** side-by-side on that real background so rotation shading is approved before the other images. Capture palette, camera, materials, edge treatment and lighting rules in `src/assets/sunny-diorama/README.md`.

Style constraints:

- **Camera:** orthographic top-down; map sprites must be rotatable by 90-degree increments without perspective drift. Menu key art may have a more cinematic composition but must share the palette and architectural language.
- **Palette:** warm yellow-green grass, muted terracotta and slate roofs, low-contrast cream stone, restrained blue-gray glass, rounded rich-green trees. Match the approved mockup **against the live render colours**: grass `#c3d99a`, roads `#5f6d75`, tree canopy `#3c6b35`, and residential lot base `#e0a18c` (rendered translucently). In particular, compare terracotta roofs next to vacant residential lots. HUD surfaces are light and clean; avoid the prior dark dispatch-console aesthetic.
- **Forms:** simple readable roof masses, light outlines, subtle material texture. Readable at 64px thumbnails and 14–42 CSS px/tile on Fit. Prioritize silhouettes over tiny fixtures.
- **Light and rotation:** **rotation-neutral roof shading is required**: even roof planes, orientation-independent ridge/edge details, no directional darkened roof face, and **no baked/cast shadow**. Author each map sprite in its **0° orientation over its unrotated catalog footprint**; HPA-677 will rotate that single texture for 90° increments. The existing `mapBatch.ts` shadow, offset +3/+3 in world space, carries the top-left light direction and should be reused/adapted without doubling it. Review every sprite at 0° **and** 180° for consistent lighting and clipping. Truly directional face illumination would instead require four authored rotations or renderer lighting and is explicitly **not** part of this asset set.
- **Backgrounds:** transparent for sprites, trees and Build illustrations; no grass, map tiles, text, watermark or floating scenery baked into these. Opaque backgrounds only where explicitly called for (City Library key art; New City template scenes if useful).
- **Consistency:** use a shared style prompt prefix and per-item subject/shape details. Save the prompts and chosen revisions in the asset README; do not add a new asset-generation framework.

**Approval gate:** the owner approves the first style sheet **including a real-map 0°/180° rotation pair and maximum-zoom sample** before the other images are generated. Keep this approval within the **same draft PR**; no second PR.

## 2. Asset inventory and stable paths

All authored WebP art lives below `src/assets/sunny-diorama/`. Use file stems that match today's domain IDs so wave 3 wiring is straightforward. Filenames are case-sensitive. The approved style sheet and a Markdown prompt/credit README live at the same root.

| Set | Count | Target path / filenames | Export |
| --- | ---: | --- | --- |
| Style sheet | 1 | `style-sheet.webp` | Readable reference board, no application use |
| City Library key art | 1 | `menu/city-library.webp` | 16:9, at least **2560×1440**, calm low-detail space on **left** for the foreground menu card |
| Shared logo/app-icon source | 1 | `brand/app-icon-source.png` | 1024×1024 PNG with a recognizable simple mark at **32px**; wordmark is rendered as live UI text |
| Build category illustrations | 4 | `build-categories/{roads,transit,zones,buildings}.webp` | Square **256×256**, transparent, readable at 64px |
| Build-item thumbnails | 26 | `build-items/{item-id}.webp` | Square **256×256**, transparent; exact IDs below |
| New City template illustrations | 3 | `templates/{blankGrid,crossroads,smallTown}.webp` | Square **256×256** minimum, readable as cards and representative when enlarged |
| Building/map sprites | 12 | `buildings/{building-id}.webp` | Transparent, **192 pixels per tile**, exact native footprints below |
| Tree variants | 3 | `trees/tree-{01,02,03}.webp` | Transparent **192×192** source canvas with canopy cropped **edge to edge** (no size-setting padding); HPA-677 draws it at the existing hashed **12–18 world-pixel diameter**, not at a full tile |

There are **50 deliverable visual assets** excluding the style sheet and the Tauri icon derivatives (4 + 26 + 3 + 12 + 3 + 1 + 1). Multiple Tauri output sizes are derivatives of the **one** shared mark, not different logos.

### Build item filename list (26)

The `build-items/` stems **must** match IDs in `BUILD_GROUPS`, not labels:

| Group | IDs |
| --- | --- |
| Roads (5) | `road-twoWay`, `road-oneWay`, `road-dual`, `compactRoundabout`, `standardRoundabout` |
| Transit (4) | `track`, `busStop`, `busTerminal`, `metroStation` |
| Zones (6) | `residential`, `commercial`, `office`, `industrial`, `civic`, `park` |
| Buildings (11) | `smallHouse`, `largeHouse`, `supermarket`, `cinema`, `officeTower`, `businessPark`, `factory`, `warehouse`, `clinic`, `school`, `parkPlaza` |

The **eleven building thumbnails and the `busTerminal` thumbnail must be derived mechanically** from their approved map sprites: fit the source inside a transparent 256×256 canvas with preserved aspect ratio and centred letterboxing (for example `magick source.webp -resize 256x256 -gravity center -background none -extent 256x256 output.webp`). **Do not independently generate** these 12 thumbnails; retain all 26 files as required by HPA-676. The other 14 road/zone/transit thumbnails may use clean miniature scenes rather than directly representing one rendered tile.

### Map sprite filename and footprint list (12)

| File stem | Native tiles | Export pixels |
| --- | --- | --- |
| `smallHouse` | 2×1 | 384×192 |
| `largeHouse` | 3×2 | 576×384 |
| `supermarket` | 2×2 | 384×384 |
| `cinema` | 3×2 | 576×384 |
| `officeTower` | 2×2 | 384×384 |
| `businessPark` | 3×2 | 576×384 |
| `factory` | 3×2 | 576×384 |
| `warehouse` | 3×2 | 576×384 |
| `clinic` | 2×2 | 384×384 |
| `school` | 3×2 | 576×384 |
| `parkPlaza` | 2×2 | 384×384 |
| `busTerminal` | 3×2 | 576×384 |

Keep every building within its exact **unrotated** footprint at 0° and reserve a small clear boundary inset; no art should spill into adjacent tiles or be cropped after 90/180/270° rotation. The renderer rotates the one approved texture, not an alternative directionally shaded export. Inspect 0° and 180° side-by-side at maximum zoom as well as Fit. Building identity must survive rotation. Do not create sprites for `busStop` and `metroStation`, which remain renderer-owned markers from HPA-678.

### New City semantic correctness

**Compose template art from the actual freshly created Small-map templates**, not an unconstrained text-to-image attempt at exact layouts. Capture a real main-branch game render and place approved sprite cutouts at the existing building origins; export that composite as the card or use it as a faithful image-to-image reference. Source of truth: `crates/caelum-core/src/sandbox.rs` (`create_sandbox_candidate` and `create_small_town_candidate`), **not** `src/scenario/sandbox.ts` (which only declares map dimensions). This is an offline art-production step, **not** a new app renderer or generator tool.

- `blankGrid`: empty gridded map, no starter roads/buildings.
- `crossroads`: two **paired one-way** carriageways crossing perpendicularly, extending edge-to-edge (four directed road rows/columns, not a single four-way road).
- `smallTown`: **two two-way roads**, four zoned rectangles (residential, commercial, industrial, office), six buildings at Rust-defined origins: **three** `smallHouse`, one `supermarket`, one `officeTower`, one `factory`. Maintain the existing spatial layout.
- Use a **Small (28×18)** fresh map as the composition source for all three cards. Medium (56×36) and Large (84×54) sizes change the canvas, not the conceptual card image. The card is representative artwork, not serialized saved-city data.

## 3. Menu composition and icon

**City Library key art:** sunny top-down city ambience; primary subject to the right/centre; leave enough quiet, low-contrast area on the left for a legible menu card. Do not include generated buttons, labels, logos or typography in the image; HPA-677 owns UI markup.

**App icon:** a single strong city/transit-inspired silhouette, no tiny details or baked wordmark. Keep `app-icon-source.png` and run Tauri's icon generator against it, writing output into `src-tauri/icons/`. **Retain only updated files already tracked by Git** in that folder (the repo tracks 16 icon files): the Tauri CLI also emits unused `android/`, `ios/` and other sizes; remove those newly generated untracked outputs before committing. Preserve filenames referenced by `tauri.conf.json`, verify 32px/128px and desktop-platform appearance, and do not edit the config. HPA-676 ships this independently of the menu redesign.

## 4. Validation and acceptance

1. A single owner-approved style sheet and prompt/selection README exist. Art matches direction A **on current-main screenshots**, including a 0°/180° sprite pair and the maximum-zoom view.
2. The inventory above is complete: **50 source deliverables plus the sheet and Tauri derivatives**; exact names and footprints match the catalog. Do not silently drop a required item.
3. Inspect actual decoded pixel sizes and alpha (not filename extensions). No opaque rectangles or baked scene shadows on building/tree sprites; no accidental empty alpha exports. The high-res key art really is at least 2560×1440.
4. Inspect buildings and tree silhouettes at Small/Medium/Large Fit scale (approximately 42/21/14 CSS px per map tile at 1440×900) **and maximum zoom (96 CSS px/tile, 192 device px on 2× displays)**. Compare terracotta roofs next to vacant residential lots; inspect 0° and 180° for all sprites (lighting and clipping). Verify trees render at the existing 12–18 world-pixel canopy diameter, Build images at 64px, and the icon at 32px. Revise only failures.
5. Tauri icon files replace the **16 already tracked** originals in place; prune CLI-generated untracked mobile/extra outputs, with no `tauri.conf.json` edits. No game code, shader, CSS, save format, tests or generated mapping code changes in this PR.
6. Future integration tickets can reference one predictable folder and exact catalog IDs without renaming assets or regenerating art. **HPA-677/HPA-696 must fail clearly on missing art** through typed asset maps or a focused completeness check over `BUILD_GROUPS` and non-marker `BUILDING_CATALOG` types; do not add that wiring or testing framework in HPA-676.

## Out of scope / anti-goals

No new font/HUD tokens (already merged in HPA-678); no Build panel wiring, dock layout or route editor (HPA-696); no menu components, textured WebGPU pass, atlas implementation, **changes to the existing world-space shadows**, or sprite loading (HPA-677). No secondary art system, runtime downloader, localization of baked image text, custom generative model pipeline, or a separate integration PR. The draft PR carries documentation now; **the final same PR** delivers the images and platform icons after approval.

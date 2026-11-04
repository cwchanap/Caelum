# HPA-714 — Build-tool safety, costs and partial-placement feedback — Design

**Issue:** https://linear.app/cwchanap/issue/HPA-714/fix-build-tool-traps-and-missing-cost-hints-from-the-uat  
**Baseline:** `main` at `9d4e9edf00a10a77432731e9dc2d9b63798a99f6`, inspected 2026-11-03  
**Delivery:** design, implementation and review in **one PR**. Planning-only first commit; no gameplay changes yet.

## Player outcome

Accidental clicks while Road > 1-Lane / 2-Lane is selected cannot turn an existing road perpendicular and break an operating route. Players see the real spend and skipped tiles **at the cursor** for paid construction, and simple build controls say what they do.

Keep Rust authoritative for mutation validity and committed charges, with Svelte/TypeScript limited to existing read-only presentation catalogs and map overlays. No new editing framework, save migration, art, SFX, or generic cost service.

## Verified current seams and bugs

- `src/runtime/roadMutations.ts::roadClickIntent` always dispatches `cycleRoadDirection` when the tile is a road, regardless of `ui.roadPreset`. Both `handleTileClick` and zero-length `commitDrag` use this path; preview uses `roadMutationForUi`. The queued click recomputes the tile kind **at execution time**, which must be preserved.
- `crates/caelum-core/src/road.rs::cycle_road_direction` currently cycles `None → North → East → South → West → None` without inspecting `tile.road_connections`. `road::apply_road_mutation` already returns `changed_tiles` and zero cost for a direction change.
- `preview.rs::preview_road_mutation` and the existing WASM/Tauri `GameBackend.previewRoadMutation` return accepted road/roundabout/remove cost, skipped tiles, route impacts and rejection. `src/render/mapTextOverlay.ts` already shows a single cursor badge but ignores `skippedTiles` and has no track preview; `src/runtime/createGameRuntime.ts` already owns preview generation, cancel/invalidate and hover refresh.
- `transit.rs::lay_track_line_costed` is an ordered, partial build: invalid or unaffordable tiles are skipped, and only placed tiles are charged. The track cursor currently displays only `⦿ Track`. Single stop/station, and building price values already exist in `BUILDING_CATALOG`; the legacy frontend `COSTS` object also contains existing transport prices. Never add another hard-coded price list.
- `rejectionMessages.ts` maps every `blockedTile` to generic "That tile is blocked."; `BuildPanel.svelte` renders `pad2(index + 1)` ordinals and a bare numeric rotate value.
- A successful roundabout click invalidates its preview, but unchanged hover may not issue another request: the just-built footprint can keep a pre-placement-looking badge until the pointer moves.

## Decision 1 — Gate road clicks by preset, constrain Rust to connected axes

| Situation | Player-visible result |
| --- | --- |
| Empty tile with Road armed | Existing single-tile `layRoad` semantics (one two-way road) unchanged |
| Existing road + **1-Lane** or **2-Lane** | No dispatch; neutral "Already road" cursor hint, no charge, no direction notice |
| Ordinary straight road + **1-Lane One-Way** | Cycle only the road's connected axis: two-way → first one-way heading → reverse heading → two-way |
| Structure-owned road, mixed-axis junction/corner, or road without a resolvable straight axis | No direction change; no false success message |
| Queued click after earlier construction | Re-read latest map and chosen preset when the queued operation runs; preview and commit make the same decision |

Make `roadClickIntent`/`roadClickMutation` capable of returning `null` on no-op, and apply identical rules for click, zero-length drag and hover; invalidate a prior preview when the new choice is no-op. A multi-tile road stroke retains the existing `layRoadLine` behavior.

In Rust, resolve a unique road axis from `road_connections` (N/S or E/W). Only allow direction headings parallel to that axis; do not manufacture a perpendicular connection. For a straight road, use a deterministic order (vertical North then South; horizontal East then West). Keep a structure-owned/mixed-axis road unchanged rather than guessing. An inconsistent prior direction is never a reason to cycle into another invalid heading.

The deliberate selection of One-Way may still change route reachability in the permitted axis: preserve the existing authoritative route-impact preview and committed direction-change feedback. The guarantee is **no accidental cross-axis change**, not "one-way can never affect any route."

## Decision 2 — One truthful cursor cost path

Reuse `selectMapTextOverlayItems`/`cursorBadgeText` and its accessible readout. Keep the existing label grammar `⦿ Label · $X`, warning tone, and `Free` in Creative mode.

- **Road, roundabout and remove:** continue displaying the generation-matched Rust preview cost. Existing-road no-op shows "Already road", not an invalid-placement glyph.
- **Track hover/drag:** extend the **existing** preview request/response path narrowly for `layTrack`/`layTrackLine`. Simulate via the same Rust `transit::lay_track_costed`/`lay_track_line_costed` rules, not a TypeScript per-tile pricing simulator. Reuse the existing host method, preview coordinator and generation/held-preview invalidation; do **not** create a new `GameBackend` method or generic construction-preview service. If extending the current `RoadMutation` wire union is the smallest approach, keep that localized and document that it already previews more than road laying (demolition removes track today).
- **Bus Stop, Metro Station, and selected buildings:** display prices from existing `BUILDING_CATALOG` by type (including busStop and metroStation). Reuse the same catalog for affordability; no new copied `TRACK_COST`, `BUS_STOP_COST` or `METRO_STATION_COST` constants. Where the existing frontend `COSTS` and building catalog duplicate busStop/station prices, reference the existing values instead of introducing further literals. Rust remains authoritative when the player commits.
- An invalid placement may show its informational listed price plus `⊘`, but a rejected **Rust preview** must show its rejection rather than implying a charge. Pending preview has a neutral badge, never a guessed authoritative total. Keep a matching `a11yText`.

## Decision 3 — A warning when the committed stroke will be partial

Road and track previews already or newly know `changedTiles`, `skippedTiles` and actual `cost`. Make the cursor warning-toned whenever a non-rejected stroke has skipped requested build tiles. Use a short reason derived from Rust's *same mutation loop*, not guessed in TypeScript:

- `⦿ Road · $100 · Not enough money, 11 tiles skipped`
- `⦿ Track · $1,000 · 2 tiles blocked`
- If both apply, show both concise counts; if a skip is neither blocked nor budget-related, use a truthful "N tiles skipped" fallback.

Prefer a small breakdown of skipped counts in the existing Rust preview response (e.g. blocked / unaffordable, with any remainder unclassified), populated alongside the existing per-tile decisions. Do **not** infer a skip's cause from the **current** budget and a parallel UI validator. Counting skips must distinguish a true non-applied tile from a legal unchanged crossing: avoid labelling an accepted perpendicular road contact as "blocked." If the full mutation is rejected, the existing rejection badge wins.

Preserve the Rust cost as the **amount actually charged**, not the requested all-tiles estimate; creative-mode builds show `Free`. Stale held previews remain pending, not false warnings.

## Decision 4 — Focused copy and post-build refresh

- When Rust rejects a Bus Stop **on** an existing road, return a specific typed rejection (e.g. `stopMustBeBesideRoad`) and map it to **"Place stops beside a road, not on it."** Keep generic `blockedTile` wording for buildings, collisions and other tools; no last-intent tracking framework.
- Remove the decorative `tool-num` 01/02 ordinals from `BuildPanel.svelte` (and their now-unused import/style/tests). Preserve real keyboard shortcut hints. Show rotation as `0°`/`90°` etc.; leave the accessible name's "degrees" wording intact.
- After an **applied** roundabout placement, re-arm the current hover preview against the **post-commit** snapshot without waiting for another pointermove. Reuse the existing generation/invalidate machinery, guard against a tool or hover change while the dispatch ran, and avoid re-rendering the stale pre-commit candidate.

## Acceptance

1. Road clicks and zero-length drags in 1-Lane and 2-Lane preserve an existing straight road and its connected bus route. One-Way cycles a horizontal road only E/W and a vertical road only N/S, then returns to two-way; mixed-axis/structure-owned roads do not receive invalid headings.
2. Road hover and committed direction change share the preset rule; no false direction notice or stale `⊘` for a no-op.
3. Standard-mode armed Track, Bus Stop, Metro Station and building each shows its price. Multi-tile Track shows the Rust **actual** charge. Creative mode says `Free`. No new TS price constants.
4. A $150 budget with a 12-tile $100 Road drag warns that only one tile will build and eleven are unaffordable; an obstructed road/track drag warns about skipped blocked tiles. Preview and commit agree on charged cost and changed tiles.
5. A bus stop clicked on a road says the specific beside-road message; other blocked placements keep the generic message.
6. Build ordinals are gone, Rotate includes `°`, and an immediately placed roundabout displays a refreshed/settled cursor badge without pointer movement.
7. Focused Rust, runtime, cursor/UI and one existing browser journey pass. No snapshots, persistence schema, host operations, art or SFX are added.

## Explicitly deferred

Roundabout footprint centring or requiring adjacent roads; demolition red-colour semantics; edge auto-pan; direction-change undo; dev favicon 404. Those UAT findings are outside HPA-714. No separate implementation PR: update these documents, implement and test on **this same branch/PR**.

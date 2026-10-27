# HPA-169 — Overlay legends and metric shortcuts (design)

Linear: https://linear.app/cwchanap/issue/HPA-169/add-overlay-legends-and-link-metrics-to-them

## Problem and outcome

Caelum already exposes Coverage, Crowding, Demand, and Traffic overlays, but the on-map colours have no explanation. The Data panel also displays Late, Unserved, and Avg Wait as read-only numbers. Players should be able to understand an active overlay on the map and jump from a metric to the most useful existing overlay in one click.

**Success:** choose an overlay in Data, see an accurate, unobtrusive map legend; clear it and the legend disappears. Click a metric to activate its associated overlay without changing any gameplay state.

## Verified current seams

- `src/domain/types.ts`: `Overlay = "coverage" | "crowding" | "demand" | "traffic"`.
- `src/components/hud/panels/DataPanel.svelte`: local overlay labels/toggles and a plain `dl` containing Late/Unserved/Avg Wait.
- `src/App.svelte`: both the Data panel and `GameCanvas` receive the same `RuntimeSnapshot`; `handleSetOverlay` calls `runtime.setOverlay`.
- `src/components/GameCanvas.svelte`: board-owned DOM siblings sit above the GPU surface. `src/styles.css` places the zoom group bottom-left (`z-index: 3`) and map text (`z-index: 2`).
- `src/render/webgpu/overlayBatch.ts` and `src/render/colors.ts`: definitive overlay semantics and existing colour tokens.

This is a **presentation-only** change. Rust's transport/demand simulation, backend wire, saved state, WebGPU batches and runtime selector contracts remain unchanged.

## User-facing design

### One catalog, four truthful legends

Add `src/ui/overlayCatalog.ts` with a small typed, ordered set of overlay descriptors: id, display label, short explanatory sentence, current colour reference from `src/render/colors.ts`, and an explicit swatch kind (`coverage`, `stepped`, or `intensity`). The catalog is static display metadata, **not** a new runtime model. Keeping it in the UI layer avoids making domain types depend on the renderer palette. Replace DataPanel's local list with it; consume the selected descriptor in a new `OverlayLegend.svelte`.

| Overlay | Actual visual behavior | Legend copy / swatch |
| --- | --- | --- |
| Coverage | Same semi-transparent blue on squares around present stops/stations, even without running service | “Shaded tiles are near stops or stations; active service can support nearby growth.” Single colour chip, **not** a fake low–high scale |
| Crowding | Only present nodes whose most loaded platform is above 50% capacity; stronger when at least 100% | “Orange marks platforms above half capacity; darker means full or over capacity.” Two-step lighter/stronger swatch |
| Demand | Yellow tiles over `demandFlow` points; opacity rises with count | “Darker yellow means more travel demand at this location.” Qualitative low → high ramp |
| Traffic | Red/orange road tiles over `trafficFlow` points; opacity rises with flow | “Darker red means more private-car traffic on this road.” Qualitative low → high ramp |

Swatches reuse **hues** from `colors.ts` and communicate strength, not invented units or precisely calibrated numeric ranges. The Crowding steps should not imply a smooth continuous scale. Do not claim that Coverage always means running service or that Traffic equals lateness.

### Placement and lifecycle

- Render the legend as a noninteractive DOM sibling of `MapTextOverlay` inside `GameCanvas.svelte`, from `snapshot.ui.activeOverlay`, **not** inside the Data panel. It survives panel close and follows the current city.
- Put it top-left of the board, with a compact dark surface, high-contrast title/description, and a clear swatch. Use `pointer-events: none` so it never blocks tile clicks or pan/zoom. Zoom remains bottom-left. Keep it beneath the command panel (`z-index: 20`) and action feedback (`z-index: 25`).
- When `snapshot` or `activeOverlay` is null, no legend element exists. Switching overlays updates the same legend immediately. A short width cap and wrapping text handle smaller viewports without a new responsive system.
- Expose the legend as a named region with a stable `data-testid="overlay-legend"` for testing.

### Metrics are shortcuts, not map-derived locations

| Metric button | Existing overlay to open |
| --- | --- |
| Unserved | Demand |
| Late | Traffic |
| Avg Wait | Crowding |

Use three real HTML `button type="button"` controls (each containing its label and current value) within a labelled Metrics group. Make the entire displayed metric clickable and keyboard-operable, with visible focus, hover, and an accessible name announcing its destination (e.g. “Late — show Traffic overlay”). The buttons call the existing `onSetOverlay` prop directly, keeping the Data panel open; clicking the metric when its overlay is already selected **leaves it selected**. The four explicit overlay toggles retain their existing click-to-clear behavior.

These metric-to-overlay links are **investigation entry points**, not causal proofs: e.g. Late trips may arise for reasons other than private-car Traffic, and Unserved is not a per-tile map layer.

Changing the current `dl` to three semantic button cards means existing tests that read values via `dt`/`dd` XPath must be updated to accessible-button assertions in the same implementation PR.

## Scope boundaries

**In:** one read-only overlay catalog; one legend component; tiny changes to `GameCanvas.svelte`, `DataPanel.svelte`, and styles; targeted UI and Playwright assertions.

**Out:** numeric thresholds/units that the map does not display, new overlay types, simulation or Rust changes, new GPU shader logic, persistence, panel navigation, animation systems, art and SFX. No follow-up PR is required for this ticket; implementation should continue in **this same draft PR** after review.

## Acceptance checks

1. All four overlay buttons show the correct legend; selecting another updates it; deselecting hides it.
2. The legend persists after the Data panel closes and does not intercept map pointer input.
3. Clicking or keyboard-activating Unserved, Late, or Avg Wait selects Demand, Traffic, or Crowding respectively; repeated metric clicks do not clear selection.
4. The selected overlay button still has correct `aria-pressed` behavior.
5. Existing route/metric readout E2E coverage continues to verify numeric values under the new button markup.

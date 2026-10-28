# HPA-169 — Overlay legends and metric shortcuts (design)

Linear: https://linear.app/cwchanap/issue/HPA-169/add-overlay-legends-and-link-metrics-to-them

## Problem and outcome

Caelum already exposes Coverage, Crowding, Demand, and Traffic overlays, but the on-map colours have no explanation. The Data panel also displays Late, Unserved, and Avg Wait as read-only numbers. Players should be able to understand an active overlay on the map and jump from a metric to the most useful existing overlay in one click.

**Success:** choose an overlay in Data, see an accurate, unobtrusive map legend; clear it and the legend disappears. Click a metric to activate its associated overlay without changing any gameplay state.

## Verified current seams

- `src/domain/types.ts`: `Overlay = "coverage" | "crowding" | "demand" | "traffic"`.
- `src/components/hud/panels/DataPanel.svelte`: local overlay labels/toggles and a plain `dl` containing Late/Unserved/Avg Wait.
- `src/runtime/runtimeSelectors.ts`: a second `OVERLAY_LABELS` map supplies `ShellCommandState.activeOverlayLabel` for the Data badge in `CommandShelf.svelte`. Its names must move to the same catalog; retain the existing shell field.
- `src/App.svelte`: both the Data panel and `GameCanvas` receive the same `RuntimeSnapshot`; `handleSetOverlay` calls `runtime.setOverlay`.
- `src/components/GameCanvas.svelte`: board-owned DOM siblings sit above the GPU surface. `src/styles.css` places the zoom group bottom-left (`z-index: 3`) and map text (`z-index: 2`).
- `src/render/webgpu/overlayBatch.ts` and `src/render/colors.ts`: definitive overlay semantics and existing colour tokens. `src/render/webgpu/primitives.ts::withAlpha` multiplies base alpha, so the translucent chips must be previewed against a map-like background.
- `tests/ui/appShell.test.ts`: existing `setOverlay` harness publishes updated UI state; its Data overlay query currently matches all overlay-named buttons globally. Keep the test in this harness and scope its toggle query.

This is a **presentation-only** change. Rust's transport/demand simulation, backend wire, saved state, WebGPU batches and runtime selector contracts remain unchanged.

## User-facing design

### One catalog, four truthful legends

Add `src/ui/overlayCatalog.ts` with a small typed, ordered set of overlay descriptors keyed by `Overlay`, each containing a display `label`, `legendText`, and `swatches: readonly string[]` built from the existing hues in `src/render/colors.ts`. The catalog is static display metadata, **not** a new runtime model. Keeping it in the UI layer avoids making domain types depend on the renderer palette. Reuse the catalog's labels in both `DataPanel.svelte` and `runtimeSelectors.ts` (delete its duplicate `OVERLAY_LABELS` constant), preserving `activeOverlayLabel` for the CommandShelf badge. The new `OverlayLegend.svelte` renders each descriptor's swatches with one loop, without a `swatchKind` union or conditional render branches.

| Overlay | Actual visual behavior | Legend copy / swatch |
| --- | --- | --- |
| Coverage | Same semi-transparent blue on squares around present stops/stations, even without running service | “Shaded tiles are near stops or stations; active service can support nearby growth.” Single colour chip, **not** a fake low–high scale |
| Crowding | Only present nodes whose most loaded platform is above 50% capacity; stronger when at least 100% | “Red marks platforms above half capacity; darker means full or over capacity.” Two-step lighter/stronger swatch |
| Demand | Yellow tiles over destinations of *active* trips (`presentation.rs::demand_flow`); terminal Unserved trips are absent; opacity rises with count | “Darker yellow means more active travel demand at this location.” Qualitative low → high ramp |
| Traffic | Red/orange road tiles over `trafficFlow` points; opacity rises with flow | “Darker red means more private-car traffic on this road.” Qualitative low → high ramp |

Swatches reuse **hues** from `colors.ts` and communicate strength, not invented units or precisely calibrated numeric ranges. Use one chip for Coverage; two chips for Crowding (effective alpha **0.18 / 0.30** from `colors.crowding`'s 0.3 alpha multiplied by the renderer's 0.6 / 1.0); and a few increasingly opaque chips for Demand and Traffic. The last two are illustrative samples, not a shared numeric scale or promise of continuous colour calibration. **Render the swatch row on a light strip using `colors.empty` (`#d7e2df`)** rather than directly on the dark HUD surface — except Traffic, which only ever paints on `colors.road` (`#5f6d75`), so its chips preview on road grey instead. Visually check one screenshot of the actual rendered legend; if the two Crowding steps are still indistinguishable *on the map*, modestly adjust the existing renderer alpha constants and keep the legend in sync rather than fabricating stronger swatch colours. No `swatchKind` branches or swatch-rendering framework are needed. Do not claim that Coverage always means running service or that Traffic equals lateness.

### Placement and lifecycle

- Render the legend as a noninteractive DOM sibling of `MapTextOverlay` inside `GameCanvas.svelte`, from `snapshot.ui.activeOverlay`, **not** inside the Data panel. It survives panel close and follows the current city.
- Put it top-left of the board, with a compact dark surface, high-contrast title/description, and a swatch row on a strip matching the surface each overlay paints on (`colors.empty` ground for most, `colors.road` for Traffic). Use `pointer-events: none` so it never blocks tile clicks or pan/zoom. Zoom remains bottom-left. Keep it beneath the command panel (`z-index: 20`) and action feedback (`z-index: 25`).
- When `snapshot` or `activeOverlay` is null, no legend element exists. Switching overlays updates the same legend immediately. A short width cap and wrapping text handle smaller viewports without a new responsive system.
- Expose the legend as a named region with a stable `data-testid="overlay-legend"` for testing.

### Metrics are shortcuts, not map-derived locations

| Metric button | Existing overlay to open |
| --- | --- |
| Unserved | Coverage |
| Late | Traffic |
| Avg Wait | Crowding |

Use three real HTML `button type="button"` controls (each containing its **visible metric label and live numeric value**) inside the **existing** `<section aria-label="Metrics">`—do not nest another Metrics region. Make the entire displayed metric clickable and keyboard-operable, with visible focus and hover. **Do not set `aria-label` or `title` on these buttons.** Append a visually hidden destination hint to the visible content, for example `<span class="sr-only"> — show Traffic overlay</span>`: the accessible name remains “Late 3 — show Traffic overlay” rather than concealing the number. The buttons call the existing `onSetOverlay` prop directly, keeping the Data panel open; clicking the metric when its overlay is already selected **leaves it selected**. The four explicit overlay toggles retain their existing click-to-clear behavior.

These metric-to-overlay links are **investigation entry points**, not causal proofs. In Rust, terminal Unserved trips leave `active_trips`, while the Demand overlay derives only from active-trip destinations; routing Unserved to Demand would therefore omit exactly those trips. **Unserved → Coverage** is a better existing shortcut for inspecting stop/station proximity and gaps, but Coverage also includes unserved-by-line stops and is **not** a heatmap of unserved trip locations. Late trips may arise for reasons other than private-car Traffic, and Avg Wait is not identical to platform occupancy. A dedicated unserved-demand layer is out of scope.

Changing the current `dl` to three semantic button cards means existing tests that read values via `dt`/`dd` XPath must be updated to accessible-button assertions in the same implementation PR. Add `role="group"` to the existing `.overlays[aria-label="Overlays"]` wrapper so the App harness can scope overlay-toggle queries away from the new metric buttons.

## Scope boundaries

**In:** one read-only overlay catalog shared by `DataPanel.svelte` and `runtimeSelectors.ts` for labels; one legend component; small changes to `GameCanvas.svelte`, `DataPanel.svelte`, and styles; an App-harness UI test, the existing label-ownership Playwright test, and focused E2E readout/pointer checks.

**Out:** numeric thresholds/units that the map does not display, new overlay types, simulation or Rust changes, new GPU shader logic, persistence, panel navigation, animation systems, art and SFX. No follow-up PR is required for this ticket; implementation should continue in **this same draft PR** after review.

## Acceptance checks

1. All four overlay buttons show the correct legend; selecting another updates it; deselecting hides it.
2. The legend persists after the Data panel closes and does not intercept map pointer input.
3. Clicking Unserved, Late, or Avg Wait selects Coverage, Traffic, or Crowding respectively; repeated metric clicks do not clear selection. The accessible names include the live metric value and destination hint, and all three buttons retain native keyboard behavior.
4. The selected overlay button still has correct `aria-pressed` behavior.
5. Existing route/metric readout E2E coverage continues to verify numeric values under the new button markup, and the App-harness overlay toggle count is scoped to the Overlays group.
6. The pale swatches are distinguishable on their light background in a real screenshot, without exaggerating overlay strengths relative to the map.

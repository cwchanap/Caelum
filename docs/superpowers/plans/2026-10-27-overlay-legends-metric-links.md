# HPA-169 — Overlay legends and metric links (implementation plan)

Companion design: [Overlay legends and metric shortcuts](../specs/2026-10-27-overlay-legends-metric-links-design.md)  
Linear: https://linear.app/cwchanap/issue/HPA-169/add-overlay-legends-and-link-metrics-to-them

## Delivery contract

**One implementation PR for one Linear ticket.** This draft PR starts as reviewable design + implementation-plan documentation. After approval, implement and validate on **the same branch and PR**; do not open a separate follow-up PR or create unrelated tasks. The ticket requires no new art or SFX.

The current `main` branch already has all four overlays and a working `runtime.setOverlay` entry point. No new runtime or backend contract is necessary.

## Change sequence

### 1. Add a small display catalog

**Create:** `src/ui/overlayCatalog.ts`

- Define a statically ordered collection keyed by `Overlay` with `label`, `legendText`, `color` and `swatchKind` (`coverage | stepped | intensity`). Import `colors` from `src/render/colors.ts`; keep this dependency in the UI layer, not in `src/domain/`.
- Use a literal/typed descriptor map and a four-item display order, rather than another service, class or registry.
- Match the current renderer semantics: Coverage is a single shaded range; Crowding has half/full thresholds; Demand and Traffic darken with intensity. Keep explanatory text qualitative. Do not duplicate simulation thresholds in code just to draw a swatch.
- Reuse this catalog for DataPanel's overlay labels, avoiding four hardcoded duplicate labels.

**Verification:** TypeScript exhaustiveness catches a missing descriptor if the `Overlay` union changes.

### 2. Render a board-local legend

**Create:** `src/components/OverlayLegend.svelte`  
**Modify:** `src/components/GameCanvas.svelte`, `src/styles.css`

- Pass `snapshot.ui.activeOverlay` to a purely presentational component. Render only while there is an active overlay; it looks up its descriptor by ID.
- Add a stable `data-testid="overlay-legend"` and accessible region name (e.g. “Traffic legend”), plus title, explanatory sentence and visually identifiable swatch.
- Put the component in the existing `.board` beside `MapTextOverlay`, *not* inside the GPU canvas or `CommandPanel`. Apply a compact top-left placement, max width, contrasting existing surface tokens, and `pointer-events: none`. Preserve existing bottom-left zoom controls and keep command panel stacking above the legend.
- Use existing overlay colours for the swatches. A single coloured chip is appropriate for Coverage; two visibly distinct strengths for Crowding; qualitative transparent-to-hue ramps for Demand and Traffic. These are explanatory, not numeric scales. Avoid helper classes or generic gradient engines.

**Verification:** Null active overlay renders no legend; switching updates contents; overlays can be toggled without remounting the map. CSS does not steal pointer events from map interactions.

### 3. Make the three Data metrics navigable

**Modify:** `src/components/hud/panels/DataPanel.svelte`, `src/styles.css`

- Read overlay labels from the shared catalog. Preserve the current toggle-to-clear semantics and `aria-pressed` on the four overlay buttons.
- Replace the plain `dl` metrics readout with a labelled group containing three full-card `button type="button"` controls showing the existing metric names and values. A native button gives click, Enter, Space and focus behavior without custom event handlers.
- Wire **Late → Traffic**, **Unserved → Demand**, **Avg Wait → Crowding** to the existing `onSetOverlay(overlay)` callback. Metric action is **select only**: clicking a metric mapped to an already active overlay does not clear it, unlike explicit overlay toggles.
- Use accessible names/title hints that clarify the shortcut (“Show Traffic overlay for Late”), active-state styling, and visible keyboard focus. Keep the Data panel open. Do not add another selected-metric state or subscribe to game events.

**Verification:** The current shell metric values remain visible, unchanged and updated by `metrics` props; clicking a metric changes only overlay UI state.

### 4. Update focused tests and existing assertions

**Add:** `tests/ui/overlayLegend.test.ts`, `tests/ui/dataPanel.test.ts`  
**Modify:** `tests/e2e/commandShelf.spec.ts`, `tests/e2e/routes.spec.ts` (and `smoke.spec.ts` only if needed)

- Legend unit/component test: one check for each descriptor/overlay, verify correct text and correct swatch kind; null hides element; changing the prop changes legend. Prefer a small parameterized test over dozens of DOM snapshots.
- DataPanel unit test: click one metric and assert the exact `onSetOverlay` argument (Unserved → Demand is the acceptance baseline); keyboard activation for one metric; clicking the same metric again stays selected. Separate check that an active explicit overlay button clears on click and reports `aria-pressed`.
- Playwright: create a city, open Data, select overlay, assert legend visible on board; switch/clear and verify it changes/disappears; close Data and verify legend persists when still active; click Unserved and see Demand selected. Verify map tile interaction remains possible with legend present.
- Update `routes.spec.ts`'s metric-readout lookup: it currently relies on `dt` followed by sibling `dd`, which deliberately changes to whole-card buttons. Assert values through the new semantically named metric buttons instead. Preserve the existing data-panel pointer-ownership test in `commandShelf.spec.ts`.

**Verification:** No new Rust test or fixture: gameplay and transport projection are untouched. Avoid an exact pixel or screenshot test for decorative gradient details.

## Suggested validation commands after implementation

```sh
bun run check
bunx vitest run --project ui tests/ui/overlayLegend.test.ts tests/ui/dataPanel.test.ts
bun run test:unit
bun run test:e2e
bun run lint:svelte
bun run lint:css
bun run format:check
```

The repo's existing CI remains the merge gate. If a command fails, fix within this same PR. The docs-only draft does not claim that runtime tests have run.

## Reuse and risk check

- **Reuse** `RuntimeSnapshot.ui.activeOverlay`, `DataPanel.onSetOverlay`, `App.handleSetOverlay`, `colors.ts`, `.board` stacking, and Svelte 5 props; add no separate store, derived simulation state, renderer pass, or wire fields.
- **Copy accuracy** matters: Coverage is based on present nodes, not guaranteed running service; Crowding is thresholded; metric mappings are helpful starting points, not precise per-metric map projections.
- **CSS placement** matters: existing board zoom is bottom-left, command panel is higher z-index, and overlays must be pointer-transparent.
- **Existing test coupling** matters: the old `dl` XPath selectors must change with the button markup rather than keeping compatibility wrappers.

## Definition of done

- [ ] The four overlay controls share catalog labels and produce correct map legends.
- [ ] Legend survives Data panel closure and is absent when no overlay is active.
- [ ] All three metric cards activate the documented overlay via mouse and keyboard, without clearing active selection.
- [ ] Map interactions still work with the legend visible.
- [ ] Existing metric-value and overlay-toggle tests still pass with updated semantic locators.
- [ ] Typecheck, targeted tests, lint, format and CI pass; no Rust or persistence changes.

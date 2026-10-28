# HPA-169 — Overlay legends and metric links (implementation plan)

Companion design: [Overlay legends and metric shortcuts](../specs/2026-10-27-overlay-legends-metric-links-design.md)  
Linear: https://linear.app/cwchanap/issue/HPA-169/add-overlay-legends-and-link-metrics-to-them

## Delivery contract

**One implementation PR for one Linear ticket.** This draft PR starts as reviewable design + implementation-plan documentation. After approval, implement and validate on **the same branch and PR**; do not open a separate follow-up PR or create unrelated tasks. The ticket requires no new art or SFX.

The current `main` branch already has all four overlays and a working `runtime.setOverlay` entry point. No new runtime or backend contract is necessary.

## Change sequence

### 1. Add a small display catalog

**Create:** `src/ui/overlayCatalog.ts`

- Define a statically ordered collection keyed by `Overlay` with `label`, `legendText`, `swatches: readonly string[]`, and `swatchBackground` (the surface each overlay paints on). Follow the simple ordered-IDs-plus-typed-label-map pattern in `src/domain/catalog/areas.ts`; import colours from `src/render/colors.ts` and the shared alpha scales from `src/render/overlayAlpha.ts`. Never import `overlayBatch.ts` into the catalog: it already imports runtime selectors, which will import the catalog, so that would create a cycle.
- Use a literal/typed descriptor map and a four-item display order, rather than another service, class or registry. Derive the ordered ID list from the catalog keys so a new `Overlay` variant cannot silently drop out of the toggle row.
- Match current renderer semantics with swatch arrays computed from the same alpha constants the renderer uses: Coverage has **one** blue chip; Crowding has **two** red chips (effective alphas `0.3 * 0.6 = 0.18` and `0.3 * 1.0 = 0.30`); Demand and Traffic have **three or four** increasingly opaque chips in their respective hues. `withAlpha` multiplies base alpha; it does not replace it. CSS `rgba()` strings can be authored directly here—GPU `parseColor` / `withAlpha` return tuples, not CSS values, so do not add a conversion helper. Keep legend text qualitative and do not expose fabricated units or numeric ranges.
- Reuse this catalog for `DataPanel.svelte`'s overlay labels **and** `src/runtime/runtimeSelectors.ts`'s `activeOverlayLabel` derivation. Delete the existing duplicate `OVERLAY_LABELS` map there; preserve `ShellCommandState.activeOverlayLabel` and `CommandShelf.svelte`'s Data badge. This keeps the existing runtime presentation contract while eliminating a second source of names.

**Verification:** TypeScript exhaustiveness catches a missing descriptor if the `Overlay` union changes; `tests/runtime/runtimeSelectors.test.ts` continues checking the Data badge label without a duplicated lookup.

### 2. Render a board-local legend

**Create:** `src/components/OverlayLegend.svelte`  
**Modify:** `src/components/GameCanvas.svelte`, `src/styles.css`

- Pass `snapshot.ui.activeOverlay` to a purely presentational component. Render only while there is an active overlay; it looks up its descriptor by ID.
- Add a stable `data-testid="overlay-legend"` and accessible region name (e.g. “Traffic legend”), plus title, explanatory sentence and visually identifiable swatch.
- Put the component in the existing `.board` beside `MapTextOverlay`, *not* inside the GPU canvas or `CommandPanel`. Apply a compact top-left placement, max width, contrasting existing surface tokens, and `pointer-events: none`. **Put the chip row on `colors.empty` (`#d7e2df`) as its light background**, so translucent colour chips resemble the map rather than disappearing on the dark HUD. A direct import of `colors.empty` in the legend is sufficient; no shared colour-background framework. Preserve existing bottom-left zoom controls and keep command panel stacking above the legend.
- Render `descriptor.swatches` as a single `#each` row of coloured chips regardless of overlay. One chip for Coverage, two for Crowding, three/four for Demand and Traffic; all are explanatory, not numeric scales. Avoid `swatchKind` branches, helper classes, and generic gradient engines.

**Verification:** Null active overlay renders no legend; switching updates contents; overlays can be toggled without remounting the map. CSS does not steal pointer events. Inspect one real screenshot with Coverage and both Crowding chips; if the two Crowding strengths remain indistinguishable **on the map**, consider a small coordinated adjustment to the existing `overlayBatch.ts` alpha literals and legend chips in this PR, not exaggerated legend-only swatches or a new shader system.

### 3. Make the three Data metrics navigable

**Modify:** `src/components/hud/panels/DataPanel.svelte`, `src/styles.css`

- Read overlay labels from the shared catalog. Preserve the current toggle-to-clear semantics and `aria-pressed` on the four overlay buttons.
- Replace the plain `dl` metrics readout with three full-card `button type="button"` controls showing the existing metric names and **live values**, inside the **existing** `<section aria-label="Metrics">` (already a named region). Do not add a second Metrics group/region. Native buttons provide Enter, Space and focus behavior without custom handlers.
- Wire **Late → Traffic**, **Unserved → Coverage**, **Avg Wait → Crowding** to the existing `onSetOverlay(overlay)` callback. Rust removes terminal unserved trips from `active_trips` (`trips.rs`), and `presentation.rs::demand_flow` includes only active trips: the original Unserved → Demand mapping therefore excludes the unserved events. Coverage is an imperfect *proximity* diagnostic (it shades even stops without active service), not a heatmap of unserved locations; say so in the copy. Metric action is **select only**: clicking a metric mapped to an already active overlay does not clear it, unlike explicit overlay toggles.
- Preserve the visible label and numeric value in each button's accessible name; **do not use `aria-label` or `title`**, which would replace/mislead that name. Append a `<span class="sr-only"> — show Traffic overlay</span>` suffix (or the appropriate destination) after the visible value, so the accessible name is e.g. “Late 3 — show Traffic overlay”. Provide active-state styling and visible keyboard focus. Keep the Data panel open. Do not add another selected-metric state or subscribe to game events.

**Verification:** The current shell metric values remain visible, unchanged and updated by `metrics` props; clicking a metric changes only overlay UI state.

### 4. Update focused tests and existing assertions

**Modify:** `tests/ui/appShell.test.ts`, `tests/e2e/commandShelf.spec.ts`, `tests/e2e/routes.spec.ts`. **Do not add** separate `overlayLegend.test.ts` or `dataPanel.test.ts` mocked-prop suites.

- Extend the **existing App harness** (`tests/ui/appShell.test.ts`): it already republishes `ui.activeOverlay` from its `setOverlay` mock. Open Data, click Unserved and assert **Coverage** selected and the board legend appears; close Data and assert legend persists; clear the overlay and assert it disappears. Cover other legend descriptors with one small parameterized chip-count/copy check if useful, not a mirrored suite or exact chip-colour equality test.
- Fix the **existing App assertion** around line 1577: it counts four overlay-named buttons using a global role query. The new metric buttons' visually hidden destination hints also contain overlay names, so change the existing `.overlays` wrapper to `role="group" aria-label="Overlays"` and scope the button count with Testing Library `within(screen.getByRole("group", { name: "Overlays" }))`. Keep the existing `<section aria-label="Metrics">` without a duplicate region.
- Keep the native button's default keyboard behavior; **do not add an isolated Enter/Space test** just to reassert browser behavior. Assert that the accessible button name includes its metric value and destination in the App test.
- Limit Playwright to browser-specific interactions: **extend** `tests/e2e/commandShelf.spec.ts:363-394`'s real Data-panel click-ownership test (Late activates Traffic while its click leaves the armed road tool's map tile unchanged); add one map click **beneath the legend** with a tool armed to prove `pointer-events: none`; update `tests/e2e/routes.spec.ts:321-329`'s `dt`/`dd` XPath locators to value-bearing metric buttons. Preserve existing viewport/bounding-box checks; avoid repeating switch/clear tests in E2E.
- During implementation, inspect **one real screenshot** of the translucent chip row on `colors.empty` and check both Crowding steps are visually distinguishable. A chip-colour equality assertion against the catalog would not catch this contrast failure.

**Verification:** No new Rust test or fixture: gameplay and transport projection are untouched. Use the actual screenshot as a manual visual check, not a new pixel-perfect screenshot assertion or snapshot suite.

## Suggested validation commands after implementation

```sh
bun run check
bunx vitest run --project ui tests/ui/appShell.test.ts
bun run test:unit
bun run test:e2e
bun run lint:svelte
bun run lint:css
bun run format:check
```

The repo's existing CI remains the merge gate. If a command fails, fix within this same PR. The docs-only draft does not claim that runtime tests have run.

## Reuse and risk check

- **Reuse** `RuntimeSnapshot.ui.activeOverlay`, `DataPanel.onSetOverlay`, `App.handleSetOverlay`, `ShellCommandState.activeOverlayLabel`, `colors.ts`, `.board` stacking, and Svelte 5 props; remove duplicate `OVERLAY_LABELS` rather than keeping parallel names. Add no separate store, derived simulation state, renderer pass, or wire fields.
- **Copy accuracy** matters: Coverage is based on present nodes, not guaranteed running service; Crowding is thresholded; Unserved is terminal and excluded from `demand_flow`, so the Unserved shortcut targets Coverage as an approximate network-footprint view, not an unserved-trip locator.
- **Visual match** matters: low-alpha chips need the light `colors.empty` strip to look like map overlays. Existing board zoom is bottom-left, command panel is higher z-index, and the legend must be pointer-transparent.
- **Existing test coupling** matters: the old `dl` XPath selectors must change with the button markup, and the App harness's broad overlay-button count must be scoped to the Overlays group, rather than keeping compatibility wrappers or adding duplicate tests.

## Definition of done

- [ ] All four overlay controls and the CommandShelf Data badge share catalog labels; map legends render from descriptor swatch arrays.
- [ ] Legend survives Data panel closure, is absent when no overlay is active, and the chip row is legible on light map-ground backing (verified by a real screenshot).
- [ ] All three metric cards activate the documented overlay via mouse, retain native keyboard behavior, and do not clear active selection; accessible names preserve numeric values and provide destination hints.
- [ ] Map interactions still work with the legend visible.
- [ ] The existing App harness and E2E metric-value, overlay-toggle, and Data-panel click-ownership tests still pass with scoped queries and updated semantic locators.
- [ ] Typecheck, targeted tests, lint, format and CI pass; no Rust or persistence changes.

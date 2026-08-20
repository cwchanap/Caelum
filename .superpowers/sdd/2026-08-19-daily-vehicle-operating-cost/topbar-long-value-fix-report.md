# HPA-645 topbar long-value fix

## Scope

Keep the Money, Daily cost, Time, Network, and control cluster readable at the
supported desktop widths when HPA-645 produces long formatted values. The
repair is limited to the compact desktop topbar and its browser geometry
contract.

## TDD evidence

### RED

Extended `tests/e2e/topbarViewport.spec.ts` to measure both the default city and
the long-value state at 1024, 1280, and 1440 CSS pixels. The test uses the
existing `debugSetBudget` seam for the reachable negative budget and applies
the documented `$20,000` Daily cost string at the rendered readout seam rather
than constructing a fleet solely for a layout test.

Command:

```text
bunx playwright test tests/e2e/topbarViewport.spec.ts --workers=1
```

Result: failed as intended before the CSS repair. The 1024px long-value case
reported:

```text
1024px Time overlaps Network
Time textRight: 556.375
Network left: 555.375
values: Money $-120,000; Daily cost $20,000
```

### GREEN

Added a 1024–1199px media-query rule that hides only the decorative `.brand-tag`
(`Transit Ops`). All metrics, including Daily cost, and the pause/speed
controls remain rendered.

The same focused command passed after the repair:

```text
1 passed (13.8s)
```

The test covers default and long-value states at 1024px, 1280px, and 1440px.

## Verification

```text
bunx prettier --check tests/e2e/topbarViewport.spec.ts src/styles.css
All matched files use Prettier code style!

bun run lint:css
$ stylelint "src/**/*.css"

bun run check
svelte-check found 0 errors and 0 warnings
```

`git diff --check` also completed with no diagnostics.

## Rationale and risks

The 1024–1199px breakpoint already hides secondary Population and Avg Wait
readouts. Reclaiming the decorative brand subtitle at that same breakpoint
provides stable space for long financial values without changing gameplay,
simulation, persistence, or the fixed Network allocation. At 1200px and above
the existing brand and readout presentation is unchanged.

The test fixture does not claim to validate operating-cost calculation; Rust
and selector tests cover that contract elsewhere. It validates the rendered
formatted string at the actual browser layout seam. The only presentation
change risk is that “Transit Ops” is not shown at compact desktop widths.

## Commit

Commit message: `fix: keep long topbar values separated`

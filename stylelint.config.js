// Stylelint configuration. Extends `stylelint-config-standard` for the
// structural/validity rules (unknown properties, deprecated declarations,
// unspaced calc, unknown units, invalid @import positioning, etc.) but
// overrides the purely cosmetic rules whose defaults conflict with this
// codebase's established, deliberate conventions:
//   - BEM class names (`block__element--modifier`)
//   - `rgba()` color functions with decimal alpha
//   - `min-width` / `max-width` media-feature notation
//   - rules grouped by component rather than by specificity
// Prettier owns formatting; Stylelint owns correctness here.
export default {
  extends: "stylelint-config-standard",
  rules: {
    // BEM uses `__` (element) and `--` (modifier) separators.
    "selector-class-pattern": null,
    // Rules are intentionally grouped by component for readability; the
    // codebase does not order by specificity.
    "no-descending-specificity": null,
    // Responsive/media overrides deliberately re-declare the same selector
    // in different query contexts.
    "no-duplicate-selectors": null,
    // Established convention uses legacy `rgba()` with decimal alpha.
    "color-function-notation": null,
    "color-function-alias-notation": null,
    "alpha-value-notation": null,
    // Established convention uses `min-width` / `max-width` keywords.
    "media-feature-range-notation": null,
    // Prettier manages blank-line formatting between rules.
    "rule-empty-line-before": null,
    "declaration-empty-line-before": null,
    // Codebase deliberately uses longhand box offsets and border sides for
    // clarity rather than the `inset` / shorthand forms.
    "declaration-block-no-redundant-longhand-properties": null,
    // CSS keyword values are spelled in their idiomatic camelCase form
    // (`optimizeLegibility`, `currentColor`).
    "value-keyword-case": null,
  },
};

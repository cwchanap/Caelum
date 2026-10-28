<script lang="ts">
  import type { Overlay } from "../domain/types";
  import { colors } from "../render/colors";
  import { OVERLAY_CATALOG } from "../ui/overlayCatalog";

  interface Props {
    activeOverlay: Overlay | null;
  }

  let { activeOverlay }: Props = $props();
  const descriptor = $derived(
    activeOverlay === null ? null : OVERLAY_CATALOG[activeOverlay],
  );
</script>

{#if descriptor !== null}
  <div
    class="overlay-legend"
    data-testid="overlay-legend"
    role="region"
    aria-label="{descriptor.label} legend"
  >
    <h2 class="overlay-legend__title">{descriptor.label}</h2>
    <p class="overlay-legend__copy">{descriptor.legendText}</p>
    <div
      class="overlay-legend__swatches"
      style:background-color={colors.empty}
      aria-hidden="true"
    >
      {#each descriptor.swatches as swatch (swatch)}
        <span
          class="overlay-legend__swatch"
          data-testid="overlay-legend-swatch"
          style:background-color={swatch}
        ></span>
      {/each}
    </div>
  </div>
{/if}

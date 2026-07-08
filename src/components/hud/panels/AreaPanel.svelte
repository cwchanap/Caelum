<script lang="ts">
  import type { AreaKind } from "../../../domain/types";
  import { AREA_KINDS, AREA_LABELS } from "../../../domain/catalog/areas";

  interface Props {
    selectedArea: AreaKind | null;
    onSetArea: (area: AreaKind) => void;
  }

  let { selectedArea, onSetArea }: Props = $props();

  function pad2(value: number): string {
    return value.toString().padStart(2, "0");
  }
</script>

<div class="hud-panel" data-testid="panel-area">
  <section class="panel-section">
    <h3 class="section-head"><span class="num">01</span> Area</h3>
    <div class="toolbar toolbar--compact" aria-label="Area tools">
      {#each AREA_KINDS as area, index (area)}
        <button
          type="button"
          data-area={area}
          aria-pressed={selectedArea === area}
          aria-label={AREA_LABELS[area]}
          class:active={selectedArea === area}
          onclick={() => onSetArea(area)}
        >
          <span class="tool-num" aria-hidden="true">{pad2(index + 1)}</span>
          <span class="tool-label" aria-hidden="true">{AREA_LABELS[area]}</span>
        </button>
      {/each}
    </div>
  </section>
</div>

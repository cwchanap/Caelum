<script lang="ts">
  import type { Overlay } from "../../../domain/types";
  import type { ShellTopbarState } from "../../../runtime/types";
  import { OVERLAY_CATALOG, OVERLAY_IDS } from "../../../ui/overlayCatalog";

  interface Props {
    activeOverlay: Overlay | null;
    metrics: Pick<ShellTopbarState, "late" | "unserved" | "avgWait">;
    onSetOverlay: (overlay: Overlay | null) => void;
  }

  let { activeOverlay, metrics, onSetOverlay }: Props = $props();
</script>

<div class="hud-panel" data-testid="panel-data">
  <section class="panel-section overlay-section">
    <h3 class="section-head"><span class="num">04</span> Data</h3>
    <div class="overlays" aria-label="Overlays">
      {#each OVERLAY_IDS as overlay (overlay)}
        <button
          type="button"
          data-overlay={overlay}
          aria-pressed={activeOverlay === overlay}
          class={{ active: activeOverlay === overlay }}
          onclick={() =>
            onSetOverlay(activeOverlay === overlay ? null : overlay)}
        >
          {OVERLAY_CATALOG[overlay].label}
        </button>
      {/each}
    </div>
    {#if activeOverlay === null}
      <p class="overlay-empty">Choose an overlay to inspect the network.</p>
    {/if}
  </section>

  <section class="panel-section metrics-section" aria-label="Metrics">
    <h3 class="section-head"><span class="num">05</span> Metrics</h3>
    <dl class="metrics-row">
      <div>
        <dt>Late</dt>
        <dd>{metrics.late}</dd>
      </div>
      <div>
        <dt>Unserved</dt>
        <dd>{metrics.unserved}</dd>
      </div>
      <div>
        <dt>Avg Wait</dt>
        <dd>{metrics.avgWait}</dd>
      </div>
    </dl>
  </section>
</div>

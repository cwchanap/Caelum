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
    <div class="metrics-row">
      <button
        type="button"
        class={{ active: activeOverlay === "traffic" }}
        onclick={() => onSetOverlay("traffic")}
      >
        <span class="metric-name"
          >Late <span class="metric-value">{metrics.late}</span></span
        >
        <span class="sr-only">
          — show {OVERLAY_CATALOG.traffic.label} overlay</span
        >
      </button>
      <button
        type="button"
        class={{ active: activeOverlay === "coverage" }}
        onclick={() => onSetOverlay("coverage")}
      >
        <span class="metric-name"
          >Unserved <span class="metric-value">{metrics.unserved}</span></span
        >
        <span class="sr-only">
          — show {OVERLAY_CATALOG.coverage.label} overlay</span
        >
      </button>
      <button
        type="button"
        class={{ active: activeOverlay === "crowding" }}
        onclick={() => onSetOverlay("crowding")}
      >
        <span class="metric-name"
          >Avg Wait <span class="metric-value">{metrics.avgWait}</span></span
        >
        <span class="sr-only">
          — show {OVERLAY_CATALOG.crowding.label} overlay</span
        >
      </button>
    </div>
    <p class="metrics-note">
      Coverage shows proximity to stops and stations, including those without
      active service; it does not map unserved trips.
    </p>
  </section>
</div>

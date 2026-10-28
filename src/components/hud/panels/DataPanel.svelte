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

  const METRIC_LINKS = [
    { key: "late", label: "Late", overlay: "traffic" },
    { key: "unserved", label: "Unserved", overlay: "coverage" },
    { key: "avgWait", label: "Avg Wait", overlay: "crowding" },
  ] as const;
</script>

<div class="hud-panel" data-testid="panel-data">
  <section class="panel-section overlay-section">
    <h3 class="section-head"><span class="num">04</span> Data</h3>
    <div class="overlays" role="group" aria-label="Overlays">
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
      {#each METRIC_LINKS as link (link.key)}
        <button
          type="button"
          class={{ active: activeOverlay === link.overlay }}
          aria-current={activeOverlay === link.overlay}
          onclick={() => onSetOverlay(link.overlay)}
        >
          <span class="metric-name"
            >{link.label}
            <span class="metric-value">{metrics[link.key]}</span></span
          >
          <span class="sr-only">
            — show {OVERLAY_CATALOG[link.overlay].label} overlay</span
          >
        </button>
      {/each}
    </div>
    <p class="metrics-note">
      Coverage shows proximity to stops and stations, including those without
      active service; it does not map unserved trips.
    </p>
  </section>
</div>

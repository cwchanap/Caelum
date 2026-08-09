<script lang="ts">
  import type { Overlay } from "../../../domain/types";
  import type { ShellTopbarState } from "../../../runtime/types";

  interface Props {
    activeOverlay: Overlay | null;
    metrics: Pick<ShellTopbarState, "late" | "unserved" | "avgWait">;
    onSetOverlay: (overlay: Overlay | null) => void;
  }

  let { activeOverlay, metrics, onSetOverlay }: Props = $props();

  const overlays: Array<{ id: Overlay; label: string }> = [
    { id: "coverage", label: "Coverage" },
    { id: "crowding", label: "Crowding" },
    { id: "demand", label: "Demand" },
    { id: "lateness", label: "Lateness" },
  ];
</script>

<div class="hud-panel" data-testid="panel-data">
  <section class="panel-section overlay-section">
    <h3 class="section-head"><span class="num">04</span> Data</h3>
    <div class="overlays" aria-label="Overlays">
      {#each overlays as overlay (overlay.id)}
        <button
          type="button"
          data-overlay={overlay.id}
          aria-pressed={activeOverlay === overlay.id}
          class:active={activeOverlay === overlay.id}
          onclick={() =>
            onSetOverlay(activeOverlay === overlay.id ? null : overlay.id)}
        >
          {overlay.label}
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

<script lang="ts">
  import type { Overlay } from "../../../domain/types";

  interface Props {
    activeOverlay: Overlay | null;
    onSetOverlay: (overlay: Overlay | null) => void;
  }

  let { activeOverlay, onSetOverlay }: Props = $props();

  const overlays: Array<{ id: Overlay; label: string }> = [
    { id: "coverage", label: "Coverage" },
    { id: "crowding", label: "Crowding" },
    { id: "demand", label: "Demand" },
    { id: "lateness", label: "Lateness" },
    { id: "growth", label: "Growth" },
  ];
</script>

<div class="hud-panel" data-testid="panel-data">
  <section class="panel-section overlay-section">
    <h3 class="section-head"><span class="num">04</span> Overlay</h3>
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
  </section>
</div>

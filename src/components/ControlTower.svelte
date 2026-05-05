<script lang="ts">
  import type { Overlay, Tool } from "../domain/types";
  import type { ShellControlTowerState } from "../runtime/types";

  interface Props {
    shell: ShellControlTowerState;
    activeTool: Tool;
    activeOverlay: Overlay | null;
    onToggleControlTower: () => void;
    onSetTool: (tool: Tool) => void;
    onSetOverlay: (overlay: Overlay | null) => void;
  }

  const tools: Array<{ id: Tool; label: string }> = [
    { id: "inspect", label: "Inspect" },
    { id: "busStop", label: "Bus Stop" },
    { id: "busRoute", label: "Bus Route" },
    { id: "metroStation", label: "Metro Station" },
    { id: "metroLine", label: "Metro Line" },
    { id: "civicAnchor", label: "Civic" },
    { id: "remove", label: "Remove" }
  ];

  const overlays: Array<{ id: Overlay; label: string }> = [
    { id: "coverage", label: "Coverage" },
    { id: "crowding", label: "Crowding" },
    { id: "demand", label: "Demand" },
    { id: "lateness", label: "Lateness" },
    { id: "growth", label: "Growth" }
  ];

  function pad2(value: number): string {
    return value.toString().padStart(2, "0");
  }

  let { shell, activeTool, activeOverlay, onToggleControlTower, onSetTool, onSetOverlay }: Props = $props();
</script>

<aside
  class:control-tower--closed={!shell.controlTowerOpen}
  class="panel control-tower"
  data-testid="control-tower"
  aria-hidden={!shell.controlTowerOpen}
>
  <header class="panel-head">
    <button
      type="button"
      class="panel-close"
      data-action="close-tower"
      aria-label="Close Control Tower"
      onclick={onToggleControlTower}
    >
      ×
    </button>
    <span class="panel-head-mark" aria-hidden="true">⌬</span>
    <span class="panel-head-title">Control Tower</span>
    <span class="panel-head-id">CTRL · 07</span>
  </header>

  <section class="panel-section">
    <h3 class="section-head"><span class="num">01</span> Build</h3>
    <div class="toolbar" aria-label="Tools">
      {#each tools as tool, index}
        <button
          type="button"
          data-tool={tool.id}
          aria-pressed={activeTool === tool.id}
          aria-label={tool.label}
          class:active={activeTool === tool.id}
          onclick={() => onSetTool(tool.id)}
        >
          <span class="tool-num" aria-hidden="true">{pad2(index + 1)}</span>
          <span class="tool-label" aria-hidden="true">{tool.label}</span>
        </button>
      {/each}
    </div>
  </section>

  <section class="panel-section">
    <h3 class="section-head"><span class="num">02</span> Overlay</h3>
    <div class="overlays" aria-label="Overlays">
      {#each overlays as overlay}
        <button
          type="button"
          data-overlay={overlay.id}
          aria-pressed={activeOverlay === overlay.id}
          class:active={activeOverlay === overlay.id}
          onclick={() => onSetOverlay(activeOverlay === overlay.id ? null : overlay.id)}
        >
          {overlay.label}
        </button>
      {/each}
    </div>
  </section>

  <section class="panel-section details">
    <h3 class="section-head"><span class="num">03</span> Brief</h3>
    <h2>{shell.title}</h2>
    <p class="brief-id">Scenario · 001</p>

    <div class="dispatch-row">
      <span class="dispatch-key">Status</span>
      <span class="dispatch-val dispatch-val--mono">{shell.status}</span>
    </div>
    <div class="dispatch-row">
      <span class="dispatch-key">Goal</span>
      <span class="dispatch-val">{shell.objective}</span>
    </div>
    <div class="dispatch-row">
      <span class="dispatch-key">Note</span>
      <span class="dispatch-val dispatch-val--mono">{shell.lossNote}</span>
    </div>
    <div class="dispatch-row">
      <span class="dispatch-key">Wave</span>
      <span class="dispatch-val">{shell.nextGrowth}</span>
    </div>

    <div class="dispatch-divider" aria-hidden="true"></div>

    <div class="dispatch-row">
      <span class="dispatch-key">Tool</span>
      <span class="dispatch-val dispatch-val--ok">{shell.activeTool}</span>
    </div>
    <div class="dispatch-row">
      <span class="dispatch-key">Target</span>
      <span class="dispatch-val dispatch-val--mono">{shell.selectedId}</span>
    </div>
  </section>
</aside>

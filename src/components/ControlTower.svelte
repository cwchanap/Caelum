<script lang="ts">
  import type {
    BuildingRotation,
    BuildingType,
    Overlay,
    Tool,
  } from "../domain/types";
  import type { ShellControlTowerState } from "../runtime/types";
  import { BUILDING_CATALOG } from "../simulation/buildings";

  type GlobalTool = Extract<Tool, "inspect" | "remove">;
  type RouteTool = Extract<Tool, "busRoute" | "metroLine">;
  type MenuItem<TId extends string> = { id: TId; label: string };

  interface Props {
    shell: ShellControlTowerState;
    activeTool: Tool;
    activeOverlay: Overlay | null;
    selectedBuilding: BuildingType | null;
    buildingRotation: BuildingRotation;
    onToggleControlTower: () => void;
    onSetTool: (tool: Tool) => void;
    onSetBuilding: (building: BuildingType) => void;
    onRotateBuilding: () => void;
    onSetOverlay: (overlay: Overlay | null) => void;
  }

  const globalTools: Array<MenuItem<GlobalTool>> = [
    { id: "inspect", label: "Inspect" },
    { id: "remove", label: "Remove" },
  ];

  const buildToolIds: BuildingType[] = [
    "busStop",
    "busTerminal",
    "metroStation",
    "smallHouse",
    "largeHouse",
  ];

  const buildTools: Array<MenuItem<BuildingType>> = buildToolIds.map((id) => ({
    id,
    label: BUILDING_CATALOG[id].label,
  }));

  const routeTools: Array<MenuItem<RouteTool>> = [
    { id: "busRoute", label: "Bus Route" },
    { id: "metroLine", label: "Metro Line" },
  ];

  const overlays: Array<{ id: Overlay; label: string }> = [
    { id: "coverage", label: "Coverage" },
    { id: "crowding", label: "Crowding" },
    { id: "demand", label: "Demand" },
    { id: "lateness", label: "Lateness" },
    { id: "growth", label: "Growth" },
  ];

  function pad2(value: number): string {
    return value.toString().padStart(2, "0");
  }

  let {
    shell,
    activeTool,
    activeOverlay,
    selectedBuilding,
    buildingRotation,
    onToggleControlTower,
    onSetTool,
    onSetBuilding,
    onRotateBuilding,
    onSetOverlay,
  }: Props = $props();
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
    <h3 class="section-head"><span class="num">01</span> Global</h3>
    <div class="toolbar toolbar--compact" aria-label="Global tools">
      {#each globalTools as tool, index (tool.id)}
        <button
          type="button"
          data-tool={tool.id}
          aria-pressed={selectedBuilding === null && activeTool === tool.id}
          aria-label={tool.label}
          class:active={selectedBuilding === null && activeTool === tool.id}
          onclick={() => onSetTool(tool.id)}
        >
          <span class="tool-num" aria-hidden="true">{pad2(index + 1)}</span>
          <span class="tool-label" aria-hidden="true">{tool.label}</span>
        </button>
      {/each}
    </div>
  </section>

  <section class="panel-section build-section">
    <h3 class="section-head"><span class="num">02</span> Build</h3>
    <div class="toolbar" aria-label="Build tools">
      {#each buildTools as building, index (building.id)}
        <button
          type="button"
          data-building={building.id}
          aria-pressed={selectedBuilding === building.id}
          aria-label={building.label}
          class:active={selectedBuilding === building.id}
          onclick={() => onSetBuilding(building.id)}
        >
          <span class="tool-num" aria-hidden="true">{pad2(index + 1)}</span>
          <span class="tool-label" aria-hidden="true">{building.label}</span>
        </button>
      {/each}
    </div>
    <button
      type="button"
      class="rotate-control"
      aria-label={`Rotate building, current rotation ${buildingRotation} degrees`}
      disabled={selectedBuilding === null}
      onclick={onRotateBuilding}
    >
      <span>Rotate</span>
      <span class="rotate-value">{buildingRotation}</span>
    </button>
  </section>

  <section class="panel-section">
    <h3 class="section-head"><span class="num">03</span> Route Planning</h3>
    <div class="toolbar toolbar--compact" aria-label="Route planning tools">
      {#each routeTools as tool, index (tool.id)}
        <button
          type="button"
          data-tool={tool.id}
          aria-pressed={selectedBuilding === null && activeTool === tool.id}
          aria-label={tool.label}
          class:active={selectedBuilding === null && activeTool === tool.id}
          onclick={() => onSetTool(tool.id)}
        >
          <span class="tool-num" aria-hidden="true">{pad2(index + 1)}</span>
          <span class="tool-label" aria-hidden="true">{tool.label}</span>
        </button>
      {/each}
    </div>
  </section>

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

  <section class="panel-section details">
    <h3 class="section-head"><span class="num">05</span> Brief</h3>
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

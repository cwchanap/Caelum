<script lang="ts">
  import type {
    BuildingRotation,
    BuildingType,
    RoadPreset,
    Tool,
  } from "../../../domain/types";
  import { BUILDING_CATALOG } from "../../../simulation/buildings";

  type GlobalTool = Extract<Tool, "inspect" | "remove">;
  type NetworkTool = Extract<Tool, "road" | "track">;

  interface Props {
    activeTool: Tool;
    selectedBuilding: BuildingType | null;
    buildingRotation: BuildingRotation;
    roadPreset: RoadPreset;
    onSetTool: (tool: Tool) => void;
    onSetBuilding: (building: BuildingType) => void;
    onRotateBuilding: () => void;
    onSetRoadPreset: (preset: RoadPreset) => void;
  }

  let {
    activeTool,
    selectedBuilding,
    buildingRotation,
    roadPreset,
    onSetTool,
    onSetBuilding,
    onRotateBuilding,
    onSetRoadPreset,
  }: Props = $props();

  const globalTools: Array<{ id: GlobalTool; label: string }> = [
    { id: "inspect", label: "Inspect" },
    { id: "remove", label: "Remove" },
  ];

  const networkTools: Array<{ id: NetworkTool; label: string }> = [
    { id: "road", label: "Road" },
    { id: "track", label: "Track" },
  ];

  const roadPresets: Array<{ id: RoadPreset; label: string }> = [
    { id: "twoWay", label: "1-Lane" },
    { id: "oneWay", label: "1-Lane One-Way" },
    { id: "dualBidirectional", label: "2-Lane" },
  ];

  const buildToolIds: BuildingType[] = [
    "busStop",
    "busTerminal",
    "metroStation",
    "smallHouse",
    "largeHouse",
  ];

  const buildTools = buildToolIds.map((id) => ({
    id,
    label: BUILDING_CATALOG[id].label,
  }));

  function pad2(value: number): string {
    return value.toString().padStart(2, "0");
  }
</script>

<div class="hud-panel" data-testid="panel-build">
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

  <section class="panel-section">
    <h3 class="section-head"><span class="num">02</span> Network</h3>
    <div class="toolbar toolbar--compact" aria-label="Network tools">
      {#each networkTools as tool, index (tool.id)}
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
    {#if activeTool === "road"}
      <div class="toolbar toolbar--compact" aria-label="Road presets">
        {#each roadPresets as preset, index (preset.id)}
          <button
            type="button"
            data-road-preset={preset.id}
            aria-pressed={roadPreset === preset.id}
            aria-label={preset.label}
            class:active={roadPreset === preset.id}
            onclick={() => onSetRoadPreset(preset.id)}
          >
            <span class="tool-num" aria-hidden="true">{pad2(index + 1)}</span>
            <span class="tool-label" aria-hidden="true">{preset.label}</span>
          </button>
        {/each}
      </div>
    {/if}
  </section>

  <section class="panel-section build-section">
    <h3 class="section-head"><span class="num">03</span> Build</h3>
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
</div>

<script lang="ts">
  import type {
    BuildingType,
    ServicePattern,
    Tool,
  } from "../../../domain/types";
  import type { RouteDraft, RouteEditorView } from "../../../runtime/types";
  import { pad2 } from "../../../format";
  import RouteEditor from "./RouteEditor.svelte";

  type RouteTool = Extract<Tool, "busRoute" | "metroLine">;

  interface Props {
    activeTool: Tool;
    selectedBuilding: BuildingType | null;
    routeDraft: RouteEditorView | null;
    onSetTool: (tool: Tool) => void;
    onSelectWaypoint: (
      index: number | null,
      interaction: RouteDraft["interaction"],
    ) => void;
    onRemove: () => void;
    onMove: (delta: -1 | 1) => void;
    onReverse: () => void;
    onPattern: (pattern: ServicePattern) => void;
    onSave: () => void;
    onCancel: () => void;
    onReload: () => void;
  }

  let {
    activeTool,
    selectedBuilding,
    routeDraft,
    onSetTool,
    onSelectWaypoint,
    onRemove,
    onMove,
    onReverse,
    onPattern,
    onSave,
    onCancel,
    onReload,
  }: Props = $props();

  const routeTools: Array<{ id: RouteTool; label: string }> = [
    { id: "busRoute", label: "Bus Route" },
    { id: "metroLine", label: "Metro Line" },
  ];
</script>

<div class="hud-panel" data-testid="panel-routes">
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
    {#if routeDraft !== null}
      <RouteEditor
        editor={routeDraft}
        {onSelectWaypoint}
        {onRemove}
        {onMove}
        {onReverse}
        {onPattern}
        {onSave}
        {onCancel}
        {onReload}
      />
    {/if}
  </section>
</div>

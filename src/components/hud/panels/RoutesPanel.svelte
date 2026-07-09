<script lang="ts">
  import type { BuildingType, Tool } from "../../../domain/types";
  import type { ShellRouteDraftState } from "../../../runtime/types";
  import { pad2 } from "../../../format";

  type RouteTool = Extract<Tool, "busRoute" | "metroLine">;

  interface Props {
    activeTool: Tool;
    selectedBuilding: BuildingType | null;
    routeDraft: ShellRouteDraftState | null;
    onSetTool: (tool: Tool) => void;
    onRemoveDraftStop: (index: number) => void;
    onFinishRoute: () => void;
    onCancelRoute: () => void;
  }

  let {
    activeTool,
    selectedBuilding,
    routeDraft,
    onSetTool,
    onRemoveDraftStop,
    onFinishRoute,
    onCancelRoute,
  }: Props = $props();

  const routeTools: Array<{ id: RouteTool; label: string }> = [
    { id: "busRoute", label: "Bus Route" },
    { id: "metroLine", label: "Metro Line" },
  ];

  function formatCost(value: number): string {
    return `$${value.toLocaleString("en-US")}`;
  }
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
      <div class="route-draft" data-testid="route-draft">
        <ol class="draft-stops">
          {#each routeDraft.stops as stop (stop.index)}
            <li class="draft-stop">
              <span class="draft-stop-label"
                >{stop.index + 1} · {stop.label} {stop.coord}</span
              >
              <button
                type="button"
                class="draft-stop-remove"
                data-testid={`remove-draft-stop-${stop.index}`}
                aria-label={`Remove stop ${stop.index + 1}`}
                onclick={() => onRemoveDraftStop(stop.index)}
              >
                ×
              </button>
            </li>
          {/each}
        </ol>
        <p class="draft-readout" data-testid="route-draft-readout">
          {routeDraft.stops.length}
          {routeDraft.stops.length === 1 ? "stop" : "stops"} · {formatCost(
            routeDraft.vehicleCost,
          )} vehicle
        </p>
        <div class="draft-actions">
          <button
            type="button"
            class="draft-finish"
            disabled={!routeDraft.canFinish}
            onclick={onFinishRoute}
          >
            {routeDraft.canFinish
              ? "Finish Route"
              : `Finish Route — ${routeDraft.finishHint}`}
          </button>
          <button type="button" class="draft-cancel" onclick={onCancelRoute}>
            Cancel Route
          </button>
        </div>
      </div>
    {/if}
  </section>
</div>

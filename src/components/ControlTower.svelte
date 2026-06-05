<script lang="ts">
  import type {
    BuildingRotation,
    BuildingType,
    Overlay,
    Tool,
  } from "../domain/types";
  import type {
    ShellControlTowerState,
    ShellInspectorState,
    ShellRouteDraftState,
    ShellRouteListState,
  } from "../runtime/types";
  import { BUILDING_CATALOG } from "../simulation/buildings";
  import { ROUTE_COLOR_PALETTE } from "../ui/routePalette";

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
    inspector: ShellInspectorState | null;
    onAssignRouteToPlatform: (
      nodeId: string,
      routeId: string,
      platformId: string,
    ) => void;
    routeDraft: ShellRouteDraftState | null;
    routes: ShellRouteListState;
    onRemoveDraftStop: (index: number) => void;
    onFinishRoute: () => void;
    onCancelRoute: () => void;
    onRenameRoute: (routeId: string, name: string) => void;
    onRecolorRoute: (routeId: string, color: string) => void;
    onToggleRouteActive: (routeId: string) => void;
    onDeleteRoute: (routeId: string) => void;
    onSelectRoute: (routeId: string | null) => void;
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
    inspector,
    onAssignRouteToPlatform,
    routeDraft,
    routes,
    onRemoveDraftStop,
    onFinishRoute,
    onCancelRoute,
    onRenameRoute,
    onRecolorRoute,
    onToggleRouteActive,
    onDeleteRoute,
    onSelectRoute,
  }: Props = $props();

  let pendingDeleteId = $state<string | null>(null);

  function handleDeleteClick(routeId: string): void {
    if (pendingDeleteId === routeId) {
      pendingDeleteId = null;
      onDeleteRoute(routeId);
    } else {
      pendingDeleteId = routeId;
    }
  }
</script>

<aside
  class:control-tower--closed={!shell.controlTowerOpen}
  class:panel--with-inspector={inspector !== null}
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

  <section class="panel-section routes-section" data-testid="routes-panel">
    <h3 class="section-head"><span class="num">06</span> Routes</h3>
    {#if routes.length === 0}
      <p class="brief-id">No routes yet</p>
    {:else}
      <ul class="route-list">
        {#each routes as route (route.id)}
          <li class="route-item" class:route-item--inactive={!route.active}>
            <div class="route-item-head">
              <button
                type="button"
                class="route-select"
                class:active={route.selected}
                data-testid={`route-select-${route.id}`}
                aria-pressed={route.selected}
                style={`--route-color: ${route.color}`}
                onclick={() => onSelectRoute(route.id)}
              >
                <span class="route-swatch" aria-hidden="true"></span>
                <span class="route-mode"
                  >{route.mode === "bus" ? "Bus" : "Metro"}</span
                >
                <span class="route-stops">{route.stopCount} stops</span>
              </button>
              <input
                type="text"
                class="route-name"
                data-testid={`route-name-${route.id}`}
                value={route.name}
                aria-label={`Rename ${route.name}`}
                onblur={(event) =>
                  onRenameRoute(route.id, event.currentTarget.value)}
              />
            </div>
            <div class="route-item-controls">
              <button
                type="button"
                class="route-toggle"
                data-testid={`route-toggle-${route.id}`}
                aria-label={`${route.active ? "Pause" : "Resume"} ${route.name}`}
                onclick={() => onToggleRouteActive(route.id)}
              >
                {route.active ? "Pause" : "Resume"}
              </button>
              <div class="route-colors" aria-label="Route color">
                {#each ROUTE_COLOR_PALETTE as color (color)}
                  <button
                    type="button"
                    class="route-color"
                    class:active={route.color === color}
                    data-testid={`route-color-${route.id}-${color}`}
                    style={`--route-color: ${color}`}
                    aria-label={`Set color ${color}`}
                    onclick={() => onRecolorRoute(route.id, color)}
                  ></button>
                {/each}
              </div>
              <button
                type="button"
                class="route-delete"
                class:route-delete--armed={pendingDeleteId === route.id}
                data-testid={`route-delete-${route.id}`}
                onclick={() => handleDeleteClick(route.id)}
              >
                {pendingDeleteId === route.id ? "Delete?" : "Delete"}
              </button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if inspector !== null}
    <section class="panel-section platform-panel" data-testid="platform-panel">
      <h3 class="section-head"><span class="num">07</span> Platforms</h3>
      <p class="brief-id">{inspector.nodeLabel}</p>
      {#each inspector.platforms as platform (platform.id)}
        <div class="platform-row">
          <div class="platform-head">
            <span class="platform-label">Platform {platform.label}</span>
            <span class="platform-occupancy"
              >{platform.occupancy}/{platform.capacity}</span
            >
          </div>
          {#if platform.routes.length === 0}
            <p class="platform-empty">No routes</p>
          {:else}
            <ul class="platform-routes">
              {#each platform.routes as route (route.id)}
                <li class="platform-route">
                  <span
                    class="route-chip"
                    style={`--route-color: ${route.color}`}>{route.name}</span
                  >
                  {#if inspector.canReassign}
                    {#each route.moveTargets as target (target.platformId)}
                      <button
                        type="button"
                        class="move-route"
                        aria-label={`Move ${route.name} to Platform ${target.label}`}
                        data-testid={`move-${route.id}-${target.platformId}`}
                        onclick={() =>
                          onAssignRouteToPlatform(
                            inspector.nodeId,
                            route.id,
                            target.platformId,
                          )}
                      >
                        → {target.label}
                      </button>
                    {/each}
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/each}
    </section>
  {/if}
</aside>

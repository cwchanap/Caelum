<script lang="ts">
  import type {
    BuildingRotation,
    BuildingType,
    Overlay,
    RoadPreset,
    Tool,
  } from "../../domain/types";
  import type {
    ShellBriefState,
    ShellInspectorState,
    ShellRouteDraftState,
    ShellRouteListState,
  } from "../../runtime/types";
  import type { HudCategory } from "../../ui/uiState";
  import BuildPanel from "./panels/BuildPanel.svelte";
  import RoutesPanel from "./panels/RoutesPanel.svelte";
  import ManagePanel from "./panels/ManagePanel.svelte";
  import DataPanel from "./panels/DataPanel.svelte";
  import BriefPanel from "./panels/BriefPanel.svelte";
  import InspectPanel from "./panels/InspectPanel.svelte";

  interface Props {
    category: HudCategory | null;
    brief: ShellBriefState;
    activeTool: Tool;
    activeOverlay: Overlay | null;
    selectedBuilding: BuildingType | null;
    buildingRotation: BuildingRotation;
    roadPreset: RoadPreset;
    inspector: ShellInspectorState | null;
    routeDraft: ShellRouteDraftState | null;
    routes: ShellRouteListState;
    onCloseDrawer: () => void;
    onSetTool: (tool: Tool) => void;
    onSetBuilding: (building: BuildingType) => void;
    onRotateBuilding: () => void;
    onSetRoadPreset: (preset: RoadPreset) => void;
    onSetOverlay: (overlay: Overlay | null) => void;
    onAssignRouteToPlatform: (
      nodeId: string,
      routeId: string,
      platformId: string,
    ) => void;
    onRemoveDraftStop: (index: number) => void;
    onFinishRoute: () => void;
    onCancelRoute: () => void;
    onRenameRoute: (routeId: string, name: string) => void;
    onRecolorRoute: (routeId: string, color: string) => void;
    onToggleRouteActive: (routeId: string) => void;
    onDeleteRoute: (routeId: string) => void;
    onSelectRoute: (routeId: string | null) => void;
  }

  let p: Props = $props();

  const titles: Record<HudCategory, string> = {
    build: "Build",
    routes: "Routes",
    manage: "Manage",
    data: "Data",
    brief: "Brief",
    inspect: "Inspect",
  };
</script>

<aside
  class="hud-drawer panel"
  class:hud-drawer--closed={p.category === null}
  data-testid="hud-drawer"
  data-hud-category={p.category ?? "none"}
  aria-hidden={p.category === null}
  inert={p.category === null}
>
  <header class="panel-head">
    <button
      type="button"
      class="panel-close"
      data-action="close-drawer"
      aria-label="Close drawer"
      onclick={p.onCloseDrawer}
    >
      ×
    </button>
    <span class="panel-head-mark" aria-hidden="true">⌬</span>
    <span class="panel-head-title"
      >{p.category === null ? "" : titles[p.category]}</span
    >
    <span class="panel-head-id">CTRL · 07</span>
  </header>

  <div class="hud-drawer-body">
    {#if p.category === "build"}
      <BuildPanel
        activeTool={p.activeTool}
        selectedBuilding={p.selectedBuilding}
        buildingRotation={p.buildingRotation}
        roadPreset={p.roadPreset}
        onSetTool={p.onSetTool}
        onSetBuilding={p.onSetBuilding}
        onRotateBuilding={p.onRotateBuilding}
        onSetRoadPreset={p.onSetRoadPreset}
      />
    {:else if p.category === "routes"}
      <RoutesPanel
        activeTool={p.activeTool}
        selectedBuilding={p.selectedBuilding}
        routeDraft={p.routeDraft}
        onSetTool={p.onSetTool}
        onRemoveDraftStop={p.onRemoveDraftStop}
        onFinishRoute={p.onFinishRoute}
        onCancelRoute={p.onCancelRoute}
      />
    {:else if p.category === "manage"}
      <ManagePanel
        routes={p.routes}
        onRenameRoute={p.onRenameRoute}
        onRecolorRoute={p.onRecolorRoute}
        onToggleRouteActive={p.onToggleRouteActive}
        onDeleteRoute={p.onDeleteRoute}
        onSelectRoute={p.onSelectRoute}
      />
    {:else if p.category === "data"}
      <DataPanel
        activeOverlay={p.activeOverlay}
        onSetOverlay={p.onSetOverlay}
      />
    {:else if p.category === "brief"}
      <BriefPanel shell={p.brief} />
    {:else if p.category === "inspect" && p.inspector !== null}
      <InspectPanel
        inspector={p.inspector}
        onAssignRouteToPlatform={p.onAssignRouteToPlatform}
      />
    {/if}
  </div>
</aside>

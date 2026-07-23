<script lang="ts">
  import type {
    AreaKind,
    BuildingRotation,
    BuildingType,
    Overlay,
    RoadPreset,
    RoundaboutSize,
    ServicePattern,
    Tool,
  } from "../../domain/types";
  import type {
    ShellBriefState,
    ShellInspectorState,
    RouteDraft,
    RouteEditorView,
    ShellRouteListState,
  } from "../../runtime/types";
  import type { HudCategory } from "../../ui/uiState";
  import type {
    BuildCategoryId,
    BuildItemAction,
  } from "../../domain/catalog/buildMenu";
  import AreaPanel from "./panels/AreaPanel.svelte";
  import BuildPanel from "./panels/BuildPanel.svelte";
  import RoutesPanel from "./panels/RoutesPanel.svelte";
  import ManagePanel from "./panels/ManagePanel.svelte";
  import DataPanel from "./panels/DataPanel.svelte";
  import BriefPanel from "./panels/BriefPanel.svelte";
  import InspectPanel from "./panels/InspectPanel.svelte";
  import RouteEditor from "./panels/RouteEditor.svelte";

  interface Props {
    category: HudCategory | null;
    brief: ShellBriefState;
    activeTool: Tool;
    activeOverlay: Overlay | null;
    selectedArea: AreaKind | null;
    selectedBuilding: BuildingType | null;
    buildingRotation: BuildingRotation;
    roadPreset: RoadPreset;
    roundaboutSize: RoundaboutSize;
    buildCategory: BuildCategoryId | null;
    inspector: ShellInspectorState | null;
    routeDraft: RouteEditorView | null;
    routes: ShellRouteListState;
    onCloseDrawer: () => void;
    onSetTool: (tool: Tool) => void;
    onSetArea: (area: AreaKind) => void;
    onRotateBuilding: () => void;
    onSetBuildCategory: (id: BuildCategoryId | null) => void;
    onSelectBuildItem: (action: BuildItemAction) => void;
    onSetOverlay: (overlay: Overlay | null) => void;
    onAssignRouteToPlatform: (
      nodeId: string,
      routeId: string,
      platformId: string,
    ) => void;
    onSelectRouteWaypoint: (
      index: number | null,
      interaction: RouteDraft["interaction"],
    ) => void;
    onRemoveRouteWaypoint: () => void;
    onUndoRouteDraft: () => void;
    onRedoRouteDraft: () => void;
    onMoveRouteWaypoint: (delta: -1 | 1) => void;
    onReverseRouteDraft: () => void;
    onSetRoutePattern: (pattern: ServicePattern) => void;
    onSaveRouteDraft: () => void;
    onCancelRouteDraft: () => void;
    onReloadRouteDraft: () => void;
    onStartRouteEdit: (routeId: string) => void;
    onRenameRoute: (routeId: string, name: string) => void;
    onRecolorRoute: (routeId: string, color: string) => void;
    onToggleRouteActive: (routeId: string) => void;
    onDeleteRoute: (routeId: string) => void;
    onSelectRoute: (routeId: string | null) => void;
    onFocusRouteFailure: (routeId: string, legIndex: number) => void;
  }

  let p: Props = $props();

  const titles: Record<HudCategory, string> = {
    build: "Build",
    area: "Area",
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
        buildCategory={p.buildCategory}
        activeTool={p.activeTool}
        selectedBuilding={p.selectedBuilding}
        roadPreset={p.roadPreset}
        roundaboutSize={p.roundaboutSize}
        buildingRotation={p.buildingRotation}
        onSetBuildCategory={p.onSetBuildCategory}
        onSelectItem={p.onSelectBuildItem}
        onRotateBuilding={p.onRotateBuilding}
      />
    {:else if p.category === "area"}
      <AreaPanel selectedArea={p.selectedArea} onSetArea={p.onSetArea} />
    {:else if p.category === "routes"}
      <RoutesPanel
        activeTool={p.activeTool}
        selectedBuilding={p.selectedBuilding}
        routeDraft={p.routeDraft}
        onSetTool={p.onSetTool}
        onSelectWaypoint={p.onSelectRouteWaypoint}
        onRemove={p.onRemoveRouteWaypoint}
        onUndo={p.onUndoRouteDraft}
        onRedo={p.onRedoRouteDraft}
        onMove={p.onMoveRouteWaypoint}
        onReverse={p.onReverseRouteDraft}
        onPattern={p.onSetRoutePattern}
        onSave={p.onSaveRouteDraft}
        onCancel={p.onCancelRouteDraft}
        onReload={p.onReloadRouteDraft}
      />
    {:else if p.category === "manage"}
      {#if p.routeDraft?.source === "edit"}
        <RouteEditor
          editor={p.routeDraft}
          onSelectWaypoint={p.onSelectRouteWaypoint}
          onRemove={p.onRemoveRouteWaypoint}
          onUndo={p.onUndoRouteDraft}
          onRedo={p.onRedoRouteDraft}
          onMove={p.onMoveRouteWaypoint}
          onReverse={p.onReverseRouteDraft}
          onPattern={p.onSetRoutePattern}
          onSave={p.onSaveRouteDraft}
          onCancel={p.onCancelRouteDraft}
          onReload={p.onReloadRouteDraft}
        />
      {:else}
        <ManagePanel
          routes={p.routes}
          onRenameRoute={p.onRenameRoute}
          onRecolorRoute={p.onRecolorRoute}
          onToggleRouteActive={p.onToggleRouteActive}
          onDeleteRoute={p.onDeleteRoute}
          onSelectRoute={p.onSelectRoute}
          onFocusRouteFailure={p.onFocusRouteFailure}
          onEditRoute={p.onStartRouteEdit}
        />
      {/if}
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

<script lang="ts">
  import { tick } from "svelte";
  import type {
    BuildingType,
    ServicePattern,
    Tool,
  } from "../../../domain/types";
  import type { RouteDraft, RouteEditorView } from "../../../runtime/types";
  import type { ShellRouteListState } from "../../../runtime/types";
  import { ROUTE_COLOR_PALETTE } from "../../../ui/routePalette";
  import RouteEditor from "./RouteEditor.svelte";

  type RouteTool = Extract<Tool, "busRoute" | "metroLine">;

  interface Props {
    activeTool: Tool;
    selectedBuilding: BuildingType | null;
    routeDraft: RouteEditorView | null;
    routes: ShellRouteListState;
    onSetTool: (tool: RouteTool) => void;
    onSelectWaypoint: (
      index: number | null,
      interaction: RouteDraft["interaction"],
    ) => void;
    onRemove: () => void;
    onUndo: () => void;
    onRedo: () => void;
    onMove: (delta: -1 | 1) => void;
    onReverse: () => void;
    onPattern: (pattern: ServicePattern) => void;
    onSave: () => void;
    onCancel: () => void;
    onReload: () => void;
    onRenameRoute: (routeId: string, name: string) => void;
    onRecolorRoute: (routeId: string, color: string) => void;
    onToggleRouteActive: (routeId: string) => void;
    onDeleteRoute: (routeId: string) => void;
    onFocusRouteFailure: (routeId: string, legIndex: number) => void;
    onEditRoute: (routeId: string) => void;
  }

  let {
    activeTool,
    selectedBuilding,
    routeDraft,
    routes,
    onSetTool,
    onSelectWaypoint,
    onRemove,
    onUndo,
    onRedo,
    onMove,
    onReverse,
    onPattern,
    onSave,
    onCancel,
    onReload,
    onRenameRoute,
    onRecolorRoute,
    onToggleRouteActive,
    onDeleteRoute,
    onFocusRouteFailure,
    onEditRoute,
  }: Props = $props();

  let pendingDeleteId = $state<string | null>(null);
  let routeNameDrafts = $state<Record<string, string>>({});
  let listRegion: HTMLElement | null = $state(null);
  let previousDraftActive = $state<boolean | null>(null);

  function routeNameFor(routeId: string, canonical: string): string {
    return routeNameDrafts[routeId] ?? canonical;
  }

  function handleRouteNameInput(
    routeId: string,
    event: Event & { currentTarget: HTMLInputElement },
  ): void {
    routeNameDrafts[routeId] = event.currentTarget.value;
  }

  function commitRouteName(routeId: string, value: string): void {
    if (!(routeId in routeNameDrafts)) return;
    delete routeNameDrafts[routeId];
    onRenameRoute(routeId, value);
  }

  function cancelRouteName(
    routeId: string,
    canonical: string,
    event: KeyboardEvent & { currentTarget: HTMLInputElement },
  ): void {
    delete routeNameDrafts[routeId];
    event.currentTarget.value = canonical;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.blur();
  }

  function handleDeleteClick(routeId: string): void {
    if (pendingDeleteId === routeId) {
      pendingDeleteId = null;
      onDeleteRoute(routeId);
    } else {
      pendingDeleteId = routeId;
    }
  }

  function statusLabel(primary: "running" | "paused" | "broken"): string {
    return primary[0].toUpperCase() + primary.slice(1);
  }

  $effect(() => {
    const draftActive = routeDraft !== null;
    if (previousDraftActive === true && !draftActive) {
      void tick().then(() => listRegion?.focus());
    }
    previousDraftActive = draftActive;
  });
</script>

<div class="hud-panel" data-testid="panel-lines">
  {#if routeDraft !== null}
    <section class="panel-section lines-section">
      <h3 class="section-head"><span class="num">03</span> Lines</h3>
      <p
        id="route-draft-panel-gate"
        data-testid="route-draft-panel-gate"
        class="route-draft-gate"
      >
        Save or Cancel this line before changing commands
      </p>
      <RouteEditor
        editor={routeDraft}
        {onSelectWaypoint}
        {onRemove}
        {onUndo}
        {onRedo}
        {onMove}
        {onReverse}
        {onPattern}
        {onSave}
        {onCancel}
        {onReload}
      />
    </section>
  {:else}
    <section class="panel-section lines-section">
      <h3 class="section-head"><span class="num">03</span> Lines</h3>
      <div class="toolbar toolbar--compact" aria-label="Line creation">
        <button
          type="button"
          aria-label="New Bus"
          data-tool="busRoute"
          aria-pressed={selectedBuilding === null && activeTool === "busRoute"}
          class:active={selectedBuilding === null && activeTool === "busRoute"}
          onclick={() => onSetTool("busRoute")}
        >
          New Bus
        </button>
        <button
          type="button"
          aria-label="New Metro"
          data-tool="metroLine"
          aria-pressed={selectedBuilding === null && activeTool === "metroLine"}
          class:active={selectedBuilding === null && activeTool === "metroLine"}
          onclick={() => onSetTool("metroLine")}
        >
          New Metro
        </button>
      </div>

      <section
        bind:this={listRegion}
        class="lines-list-region"
        data-testid="lines-list"
        aria-label="Lines list"
        tabindex="-1"
      >
        {#if routes.length === 0}
          <p class="brief-id">No lines yet</p>
        {:else}
          <ul class="route-list">
            {#each routes as route (route.id)}
              <li
                class="route-item"
                class:route-item--inactive={route.status.primary === "paused"}
              >
                <div class="route-item-head">
                  <button
                    type="button"
                    class="route-select"
                    class:active={route.selected}
                    aria-label={`Edit ${route.name}`}
                    aria-pressed={route.selected}
                    style={`--route-color: ${route.color}`}
                    onclick={() => {
                      pendingDeleteId = null;
                      onEditRoute(route.id);
                    }}
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
                    value={routeNameFor(route.id, route.name)}
                    aria-label={`Rename ${route.name}`}
                    oninput={(event) =>
                      handleRouteNameInput(
                        route.id,
                        event as Event & { currentTarget: HTMLInputElement },
                      )}
                    onblur={(event) =>
                      commitRouteName(route.id, event.currentTarget.value)}
                    onkeydown={(event) => {
                      if (event.key === "Escape") {
                        cancelRouteName(
                          route.id,
                          route.name,
                          event as KeyboardEvent & {
                            currentTarget: HTMLInputElement;
                          },
                        );
                      } else if (event.key === "Enter") {
                        commitRouteName(route.id, event.currentTarget.value);
                        event.currentTarget.blur();
                      }
                    }}
                  />
                </div>
                <div
                  class="route-service-status"
                  data-testid={`route-status-${route.id}`}
                >
                  <span
                    class={`route-status route-status--${route.status.primary}`}
                  >
                    {statusLabel(route.status.primary)}
                  </span>
                  {#if route.status.pausedAfterRepair}
                    <span class="route-status-note">Paused after repair</span>
                  {/if}
                </div>
                {#if route.failures.length > 0}
                  <ul class="route-failures">
                    {#each route.failures as failure (failure.legIndex)}
                      <li class="route-failure">
                        <span class="route-failure-detail">
                          {failure.fromLabel} → {failure.toLabel}
                        </span>
                        <button
                          type="button"
                          class="route-failure-focus"
                          aria-label={`Focus ${failure.fromLabel} to ${failure.toLabel}`}
                          aria-describedby={`route-repair-${route.id}-${failure.legIndex}`}
                          onclick={() =>
                            onFocusRouteFailure(route.id, failure.legIndex)}
                        >
                          Focus
                        </button>
                        <span
                          class="route-repair-guidance"
                          id={`route-repair-${route.id}-${failure.legIndex}`}
                        >
                          {failure.guidance}
                        </span>
                      </li>
                    {/each}
                  </ul>
                {/if}
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
                  <div
                    class="route-colors"
                    role="group"
                    aria-label="Route color"
                  >
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
    </section>
  {/if}
</div>

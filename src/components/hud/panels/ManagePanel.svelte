<script lang="ts">
  import type { ShellRouteListState } from "../../../runtime/types";
  import { ROUTE_COLOR_PALETTE } from "../../../ui/routePalette";

  interface Props {
    routes: ShellRouteListState;
    onRenameRoute: (routeId: string, name: string) => void;
    onRecolorRoute: (routeId: string, color: string) => void;
    onToggleRouteActive: (routeId: string) => void;
    onDeleteRoute: (routeId: string) => void;
    onSelectRoute: (routeId: string | null) => void;
  }

  let {
    routes,
    onRenameRoute,
    onRecolorRoute,
    onToggleRouteActive,
    onDeleteRoute,
    onSelectRoute,
  }: Props = $props();

  let pendingDeleteId = $state<string | null>(null);
  // Local drafts for route-name inputs so live snapshots don't reset the input
  // mid-keystroke. Drafts read first; committed on blur/Enter then cleared.
  let routeNameDrafts = $state<Record<string, string>>({});

  function routeNameFor(routeId: string, canonical: string): string {
    return routeNameDrafts[routeId] ?? canonical;
  }

  function handleRouteNameInput(
    routeId: string,
    event: Event & { currentTarget: EventTarget & HTMLInputElement },
  ): void {
    routeNameDrafts[routeId] = event.currentTarget.value;
  }

  function commitRouteName(routeId: string, value: string): void {
    if (!(routeId in routeNameDrafts)) return;
    delete routeNameDrafts[routeId];
    onRenameRoute(routeId, value);
  }

  function handleDeleteClick(routeId: string): void {
    if (pendingDeleteId === routeId) {
      pendingDeleteId = null;
      onDeleteRoute(routeId);
    } else {
      pendingDeleteId = routeId;
    }
  }
</script>

<div class="hud-panel" data-testid="panel-manage">
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
                onclick={() => {
                  pendingDeleteId = null;
                  onSelectRoute(route.id);
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
                    event as Event & {
                      currentTarget: EventTarget & HTMLInputElement;
                    },
                  )}
                onblur={(event) =>
                  commitRouteName(route.id, event.currentTarget.value)}
                onkeydown={(event) => {
                  if (event.key === "Enter") {
                    commitRouteName(route.id, event.currentTarget.value);
                    event.currentTarget.blur();
                  }
                }}
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
              <div class="route-colors" role="group" aria-label="Route color">
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
</div>

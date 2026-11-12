<script lang="ts">
  import { formatMinutes } from "../../../format";
  import type { GameMap } from "../../../domain/types";
  import type { Camera } from "../../../render/boardTransform";
  import { placeInspectorPopover } from "../../../render/inspectorPlacement";
  import { parseSelectedPoint } from "../../../runtime/runtimeSelectors";
  import type { ShellInspectorState } from "../../../runtime/types";

  interface Props {
    inspector: ShellInspectorState;
    selectedId: string | null;
    map: Pick<GameMap, "width" | "height">;
    camera: Camera | null;
    stageWidth: number;
    stageHeight: number;
    onAssignRouteToPlatform: (
      nodeId: string,
      routeId: string,
      platformId: string,
    ) => void;
    onOpenServiceControls: (routeId: string) => void;
  }

  let {
    inspector,
    selectedId,
    map,
    camera,
    stageWidth,
    stageHeight,
    onAssignRouteToPlatform,
    onOpenServiceControls,
  }: Props = $props();

  let cardWidth = $state(0);
  let cardHeight = $state(0);

  // Svelte's bindings feed these; until a real layout exists (jsdom or the
  // first frame) the card keeps its fixed corner placement.
  const measured = $derived(
    stageWidth > 0 && stageHeight > 0 && cardWidth > 0 && cardHeight > 0,
  );

  const placement = $derived.by(() => {
    if (!measured) return null;
    const point = parseSelectedPoint(selectedId);
    if (point === null) return null;
    return placeInspectorPopover({
      stage: { width: stageWidth, height: stageHeight },
      card: { width: cardWidth, height: cardHeight },
      tile: point,
      map,
      camera,
    });
  });
</script>

<aside
  class="card inspection-card"
  class:inspection-card--floating={placement === null}
  class:inspection-card--hidden={measured && placement === null}
  style:left={placement === null ? undefined : `${placement.left}px`}
  style:top={placement === null ? undefined : `${placement.top}px`}
  bind:clientWidth={cardWidth}
  bind:clientHeight={cardHeight}
  data-testid="panel-inspect"
  aria-label="Inspector"
>
  {#if inspector.kind === "transit"}
    <section class="panel-section platform-panel" data-testid="platform-panel">
      <h3 class="section-head"><span class="num">07</span> Platforms</h3>
      <p class="brief-id">{inspector.nodeLabel}</p>
      {#each inspector.platforms as platform (platform.id)}
        <div class="platform-row">
          <div class="platform-head">
            <span class="platform-label">Platform {platform.label}</span>
            <span
              class="platform-occupancy"
              data-testid={`platform-queue-${platform.id}`}
            >
              Queue {platform.occupancy}/{platform.capacity}
            </span>
          </div>
          {#if platform.routes.length === 0}
            <p class="platform-empty">No routes</p>
          {:else}
            <ul class="platform-routes">
              {#each platform.routes as route (route.id)}
                <li class="platform-route">
                  <button
                    type="button"
                    class="chip route-chip"
                    style={`--route-color: ${route.color}`}
                    aria-label={`Open service controls for ${route.name}`}
                    data-testid={`open-service-${route.id}`}
                    onclick={() => onOpenServiceControls(route.id)}
                  >
                    {route.name}
                  </button>
                  <span
                    class="platform-route-wait"
                    data-testid={`route-wait-${route.id}`}
                  >
                    {route.waitingCount} waiting ·
                    {route.longestWaitSeconds === null
                      ? "No current wait"
                      : formatMinutes(route.longestWaitSeconds)}
                  </span>
                  {#if inspector.canReassign}
                    {#each route.moveTargets as target (target.platformId)}
                      <button
                        type="button"
                        class="btn move-route"
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
  {:else if inspector.kind === "vehicle"}
    <section class="panel-section vehicle-panel" data-testid="vehicle-panel">
      <h3 class="section-head"><span class="num">07</span> Vehicle</h3>
      <p class="brief-id">{inspector.vehicleLabel}</p>
      <div class="platform-route">
        <button
          type="button"
          class="chip route-chip"
          style={`--route-color: ${inspector.lineColor}`}
          aria-label={`Open service controls for ${inspector.lineName}`}
          data-testid={`open-service-${inspector.lineId}`}
          onclick={() => onOpenServiceControls(inspector.lineId)}
        >
          {inspector.lineName}
        </button>
      </div>
      <dl>
        <div class="dispatch-row">
          <dt class="dispatch-key">Load</dt>
          <dd
            class="dispatch-val dispatch-val--mono"
            data-testid="vehicle-load"
          >
            {inspector.riders} / {inspector.capacity}
          </dd>
        </div>
        <div class="dispatch-row">
          <dt class="dispatch-key">Next</dt>
          <dd class="dispatch-val" data-testid="vehicle-destination">
            {inspector.destinationLabel}
          </dd>
        </div>
      </dl>
    </section>
  {:else}
    <section class="panel-section building-panel" data-testid="building-panel">
      <h3 class="section-head"><span class="num">07</span> Building</h3>
      <p class="brief-id">{inspector.buildingLabel}</p>
      <span class="building-occupancy">
        {inspector.metricLabel}
        {inspector.occupancy} / {inspector.capacity}
      </span>
      {#if inspector.workPattern !== null && inspector.currentDestinationDemand !== null}
        <p data-testid="workplace-status">
          {#if inspector.occupancy === 0}
            Unstaffed
          {:else if inspector.currentDestinationDemand === 0}
            Staffed · quiet now
          {:else}
            Staffed · current destination demand
            {inspector.currentDestinationDemand}
          {/if}
        </p>
        <p class="workplace-pattern">{inspector.workPattern}</p>
      {/if}
    </section>
  {/if}
</aside>

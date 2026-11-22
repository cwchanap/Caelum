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
    onClose: () => void;
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
    onClose,
  }: Props = $props();

  let cardEl: HTMLElement | null = $state(null);
  let cardWidth = $state(0);
  let cardHeight = $state(0);

  // Measure synchronously after mount or content changes so remounting the
  // card (for instance when a dock closes) does not leave it hidden for a
  // frame waiting on ResizeObserver; bind:offset* keeps tracking later resizes.
  $effect(() => {
    void inspector;
    void selectedId;
    if (cardEl === null) return;
    cardWidth = cardEl.offsetWidth;
    cardHeight = cardEl.offsetHeight;
  });

  // Stage and card size stay 0 until measured. The card remains mounted (and
  // hidden) so measurements can populate, then the helper either places it
  // beside the selected tile or keeps it hidden.
  const placement = $derived.by(() => {
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

  // One queue bar per transit node across all its platforms.
  const queue = $derived.by(() => {
    if (inspector.kind !== "transit") return null;
    const occupancy = inspector.platforms.reduce(
      (sum, platform) => sum + platform.occupancy,
      0,
    );
    const capacity = inspector.platforms.reduce(
      (sum, platform) => sum + platform.capacity,
      0,
    );
    return {
      occupancy,
      capacity,
      ratio: capacity === 0 ? 0 : Math.min(1, occupancy / capacity),
    };
  });
</script>

<aside
  bind:this={cardEl}
  class="card inspection-card"
  class:inspection-card--hidden={placement === null}
  data-side={placement?.side}
  style:left={placement === null ? undefined : `${placement.left}px`}
  style:top={placement === null ? undefined : `${placement.top}px`}
  bind:offsetWidth={cardWidth}
  bind:offsetHeight={cardHeight}
  data-testid="panel-inspect"
  aria-label="Inspector"
>
  <header class="inspect-head">
    <h3 class="inspect-title" data-testid="inspect-title">
      {inspector.kind === "transit"
        ? inspector.nodeLabel
        : inspector.kind === "building"
          ? inspector.buildingLabel
          : inspector.kind === "vehicle"
            ? inspector.vehicleLabel
            : inspector.zoneLabel}
    </h3>
    <button
      type="button"
      class="inspect-close"
      aria-label="Close inspector"
      data-testid="inspect-close"
      onclick={onClose}
    >
      ×
    </button>
  </header>

  {#if inspector.kind === "transit"}
    <div
      class="inspect-queue"
      data-testid="inspect-queue-bar"
      role="img"
      aria-label={`Queue ${queue?.occupancy}/${queue?.capacity}`}
    >
      <span
        class="inspect-queue-fill"
        data-testid="inspect-queue-fill"
        style:width={`${(queue?.ratio ?? 0) * 100}%`}
      ></span>
    </div>
    <section class="panel-section platform-panel" data-testid="platform-panel">
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
  {:else if inspector.kind === "building"}
    <section class="panel-section building-panel" data-testid="building-panel">
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
  {:else}
    <section class="panel-section zone-panel" data-testid="zone-panel">
      {#if inspector.runningHint === null}
        <p class="zone-hint" data-testid="zone-quiet">
          No running line serves this land yet
        </p>
      {:else}
        <span
          class="chip route-chip"
          style={`--route-color: ${inspector.runningHint.routeColor}`}
          data-testid="zone-hint-route"
        >
          {inspector.runningHint.routeName}
        </span>
        <p class="zone-hint" data-testid="zone-hint">
          {inspector.runningHint.nodeKind === "stop"
            ? "Bus stop"
            : "Metro station"}
          nearby on a running line · proximity hint, growth not guaranteed
        </p>
      {/if}
    </section>
  {/if}
</aside>

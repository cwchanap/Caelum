<script lang="ts">
  import { tick } from "svelte";
  import type {
    BuildingType,
    ServicePattern,
    Tool,
  } from "../../../domain/types";
  import type { RouteDraft, RouteEditorView } from "../../../runtime/types";
  import type { ShellRouteListState } from "../../../runtime/types";
  import { formatMinutes } from "../../../format";
  import { formatBudget } from "../../../runtime/runtimeSelectors";
  import { ROUTE_COLOR_PALETTE } from "../../../ui/routePalette";
  import InlineNameEditor from "../../city/InlineNameEditor.svelte";
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
    onSelectRoute: (routeId: string | null) => void;
    onFocusWaitLocation: (routeId: string, nodeId: string) => void;
    onSetServiceTargetHeadway: (
      routeId: string,
      targetHeadwaySeconds: number,
    ) => void;
    onDeployInitialFleet: (routeId: string) => void;
    onAddServiceVehicle: (routeId: string) => Promise<void>;
    onRetireServiceVehicle: (routeId: string) => Promise<void>;
    pendingServiceActions: Record<string, boolean>;
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
    onSelectRoute,
    onFocusWaitLocation,
    onSetServiceTargetHeadway,
    onDeployInitialFleet,
    onAddServiceVehicle,
    onRetireServiceVehicle,
    pendingServiceActions,
  }: Props = $props();

  let pendingDeleteId = $state<string | null>(null);
  let headwayMinuteDrafts = $state<Record<string, string>>({});
  let listRegion: HTMLElement | null = $state(null);
  let previousDraftActive = $state<boolean | null>(null);
  let previousSelectedRouteId: string | null = null;

  // Rust stores target_headway_seconds as u32; minutes * 60 must not overflow it.
  const MAX_HEADWAY_MINUTES = Math.floor(0xffff_ffff / 60);

  function handleDeleteClick(routeId: string): void {
    if (pendingDeleteId === routeId) {
      pendingDeleteId = null;
      onDeleteRoute(routeId);
    } else {
      pendingDeleteId = routeId;
    }
  }

  function handleHeadwayInput(
    routeId: string,
    event: Event & { currentTarget: HTMLInputElement },
  ): void {
    headwayMinuteDrafts[routeId] = event.currentTarget.value;
  }

  function commitHeadway(routeId: string): void {
    const minutes = Number(headwayMinuteDrafts[routeId]);
    delete headwayMinuteDrafts[routeId];
    // UI validation is convenience; Rust's 60s floor is authoritative.
    if (!Number.isInteger(minutes) || minutes < 1) return;
    if (minutes > MAX_HEADWAY_MINUTES) return;
    onSetServiceTargetHeadway(routeId, minutes * 60);
  }

  function headwayMinuteValue(
    routeId: string,
    targetHeadwaySeconds: number | null,
  ): string {
    const draft = headwayMinuteDrafts[routeId];
    return draft !== undefined
      ? draft
      : targetHeadwaySeconds === null
        ? ""
        : String(targetHeadwaySeconds / 60);
  }

  function statusLabel(
    primary: "running" | "paused" | "broken" | "noFleet",
  ): string {
    return primary === "noFleet"
      ? "No fleet"
      : primary[0].toUpperCase() + primary.slice(1);
  }

  function vehicleNoun(mode: "bus" | "metro"): string {
    return mode === "metro" ? "train" : "bus";
  }

  // jsdom/fireEvent can dispatch clicks at disabled buttons, so the Rust
  // authorization gates are enforced here as well as in the runtime latch.
  function addVehicle(route: ShellRouteListState[number]): void {
    if (route.service.nextVehicleCost === null) return;
    if (pendingServiceActions[route.id] === true) return;
    void onAddServiceVehicle(route.id);
  }

  function retireVehicle(route: ShellRouteListState[number]): void {
    if (!route.service.canRetireVehicle) return;
    if (pendingServiceActions[route.id] === true) return;
    void onRetireServiceVehicle(route.id);
  }

  function fleetNoun(mode: "bus" | "metro", count: number): string {
    if (mode === "metro") return count === 1 ? "train" : "trains";
    return count === 1 ? "bus" : "buses";
  }

  // Live interval while Rust projects one. A valid undeployed route marks
  // its target as the "~" estimate; a broken path has no derivable interval
  // (Rust withholds service metrics), so the value stays unavailable.
  // No TypeScript service math.
  function intervalLabel(route: ShellRouteListState[number]): string {
    if (route.service.nominalHeadwaySeconds !== null) {
      return formatMinutes(route.service.nominalHeadwaySeconds);
    }
    if (
      route.status.primary === "broken" ||
      route.service.targetHeadwaySeconds === null
    ) {
      return formatMinutes(null);
    }
    return `~${formatMinutes(route.service.targetHeadwaySeconds)}`;
  }

  $effect(() => {
    const draftActive = routeDraft !== null;
    if (previousDraftActive === true && !draftActive) {
      void tick().then(() => listRegion?.focus({ preventScroll: true }));
    }
    previousDraftActive = draftActive;
  });

  // Scroll the selected service card into view once per selection change. The
  // list is rebuilt on every tick, so compare the selected ID instead of
  // scrolling on each snapshot. A selection made while the editor replaces the
  // list has no card yet, so leave it pending until the card returns — and
  // clear the tracking then too, so the card scrolls back if the panel
  // scroller clamped while the shorter editor stood in for the list.
  $effect(() => {
    const selectedId = routes.find((route) => route.selected)?.id ?? null;
    if (selectedId === null || routeDraft !== null) {
      previousSelectedRouteId = null;
      return;
    }
    if (selectedId === previousSelectedRouteId) return;
    // Reading listRegion before deciding keeps this effect dependent on the
    // list mounting, so a pending selection scrolls when the cards return.
    const card =
      listRegion?.querySelector<HTMLElement>(
        `[data-route-id="${selectedId}"]`,
      ) ?? null;
    if (card === null) return;
    previousSelectedRouteId = selectedId;
    card.scrollIntoView({ block: "nearest" });
  });
</script>

<div class="hud-panel" data-testid="panel-lines">
  {#if routeDraft !== null}
    <section class="panel-section lines-section">
      <h3 class="section-head">Lines</h3>
      <p
        id="route-draft-panel-gate"
        data-testid="route-draft-panel-gate"
        class="route-draft-gate"
      >
        Save or Cancel this line before changing commands
      </p>
      <RouteEditor
        editor={routeDraft}
        color={routeDraft.color}
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
      <h3 class="section-head">Lines</h3>
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
                class:route-item--selected={route.selected}
                data-route-id={route.id}
                data-testid={`route-item-${route.id}`}
                style:--route-color={route.color}
              >
                <div class="route-item-head">
                  <button
                    type="button"
                    class="route-select"
                    class:active={route.selected}
                    aria-label={`Select ${route.name}`}
                    aria-pressed={route.selected}
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
                  <div class="route-name-chip">
                    <InlineNameEditor
                      value={route.name}
                      label={`Rename ${route.name}`}
                      testId={`route-name-${route.id}`}
                      entityId={route.id}
                      onCommit={(name) => onRenameRoute(route.id, name)}
                    />
                  </div>
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
                <div
                  class="route-service"
                  data-testid={`route-service-${route.id}`}
                >
                  <div class="route-service-row">
                    <span class="route-service-label">Every</span>
                    <span class="route-service-value"
                      >{intervalLabel(route)}</span
                    >
                  </div>
                  <div class="route-service-row">
                    <span class="route-service-label">Target</span>
                    <input
                      type="number"
                      min="1"
                      max={MAX_HEADWAY_MINUTES}
                      step="1"
                      class="route-headway-input route-input"
                      data-testid={`route-headway-${route.id}`}
                      value={headwayMinuteValue(
                        route.id,
                        route.service.targetHeadwaySeconds,
                      )}
                      aria-label={`Set target headway for ${route.name}`}
                      oninput={(event) =>
                        handleHeadwayInput(
                          route.id,
                          event as Event & {
                            currentTarget: HTMLInputElement;
                          },
                        )}
                    />
                    <span class="route-service-label">min</span>
                    <button
                      type="button"
                      class="route-toggle"
                      data-testid={`route-headway-set-${route.id}`}
                      onclick={() => commitHeadway(route.id)}
                    >
                      Set
                    </button>
                  </div>
                  <div class="route-service-row">
                    <span class="route-service-label">Fleet</span>
                    <button
                      type="button"
                      class="route-step-btn"
                      data-testid={`route-retire-vehicle-${route.id}`}
                      disabled={!route.service.canRetireVehicle ||
                        pendingServiceActions[route.id] === true}
                      aria-label={`Retire ${vehicleNoun(route.mode)} on ${route.name} · no refund`}
                      title={`Retire ${vehicleNoun(route.mode)} · no refund`}
                      onclick={() => retireVehicle(route)}
                    >
                      −
                    </button>
                    <span class="route-service-value route-fleet-count"
                      >{route.service.assignedFleet}</span
                    >
                    <button
                      type="button"
                      class="route-step-btn"
                      data-testid={`route-add-vehicle-${route.id}`}
                      disabled={route.service.nextVehicleCost === null ||
                        pendingServiceActions[route.id] === true}
                      aria-label={`Add ${vehicleNoun(route.mode)} on ${route.name}${route.service.nextVehicleCost === null ? "" : ` · ${formatBudget(route.service.nextVehicleCost)}`}`}
                      title={route.service.nextVehicleCost === null
                        ? `Add ${vehicleNoun(route.mode)}`
                        : `Add ${vehicleNoun(route.mode)} · ${formatBudget(route.service.nextVehicleCost)}`}
                      onclick={() => addVehicle(route)}
                    >
                      +
                    </button>
                  </div>
                  <div class="route-service-row">
                    <span class="route-service-label">Daily cost</span>
                    <span class="route-service-value">
                      {formatBudget(route.service.dailyOperatingCost)}
                    </span>
                  </div>
                  {#if route.service.assignedFleet === 0}
                    {#if route.service.requiredFleet !== null}
                      <div class="route-service-row">
                        <span class="route-service-label">Recommended</span>
                        <span class="route-service-value"
                          >{`${route.service.requiredFleet} ${fleetNoun(
                            route.mode,
                            route.service.requiredFleet,
                          )}`}</span
                        >
                      </div>
                    {/if}
                    <div class="route-service-row">
                      <span class="route-service-label">Est. deploy cost</span>
                      <span class="route-service-value"
                        >{route.service.estimatedDeploymentCost === null
                          ? "—"
                          : formatBudget(
                              route.service.estimatedDeploymentCost,
                            )}</span
                      >
                    </div>
                    {#if route.service.estimatedDailyOperatingCost !== null}
                      <div class="route-service-row">
                        <span class="route-service-label">Est. daily cost</span>
                        <span class="route-service-value">
                          {formatBudget(
                            route.service.estimatedDailyOperatingCost,
                          )}
                        </span>
                      </div>
                    {/if}
                    {#if route.service.deployShortfallReason !== null}
                      <p
                        class="route-deploy-shortfall"
                        data-testid={`route-deploy-shortfall-${route.id}`}
                      >
                        {route.service.deployShortfallReason}
                      </p>
                    {/if}
                    {#if route.status.primary === "noFleet" && route.service.targetHeadwaySeconds !== null && route.service.requiredFleet !== null}
                      <button
                        type="button"
                        class="route-toggle"
                        data-testid={`route-deploy-${route.id}`}
                        onclick={() => onDeployInitialFleet(route.id)}
                      >
                        {route.service.estimatedDeploymentCost === null
                          ? "Deploy fleet"
                          : `Deploy fleet · est. ${formatBudget(route.service.estimatedDeploymentCost)}`}
                      </button>
                    {/if}
                  {:else}
                    <div class="route-service-row">
                      <span class="route-service-label">Recommended</span>
                      <span class="route-service-value"
                        >{route.service.requiredFleet === null
                          ? "—"
                          : `${route.service.requiredFleet} ${fleetNoun(
                              route.mode,
                              route.service.requiredFleet,
                            )}`}</span
                      >
                    </div>
                    {#if route.service.longestWaitSeconds !== null}
                      <div class="route-service-row">
                        <span class="route-service-label">Longest wait</span>
                        <span class="route-service-value"
                          >{formatMinutes(
                            route.service.longestWaitSeconds,
                          )}</span
                        >
                      </div>
                    {/if}
                  {/if}
                </div>
                {#if route.status.primary === "running" && route.service.waitingAtRiskCount > 0}
                  <p
                    class="route-status-note"
                    data-testid={`route-health-${route.id}`}
                  >
                    {route.service.waitingAtRiskCount}
                    {route.service.waitingAtRiskCount === 1
                      ? "rider"
                      : "riders"}
                    at risk
                  </p>
                  {#if route.waitLocations.length > 0}
                    <ul
                      class="route-wait-locations"
                      data-testid={`route-wait-locations-${route.id}`}
                    >
                      {#each route.waitLocations as location (location.nodeId)}
                        <li>
                          <button
                            type="button"
                            class="route-wait-location"
                            data-testid={`route-wait-location-${route.id}-${location.nodeId}`}
                            aria-label={`Inspect ${location.nodeLabel}`}
                            onclick={() =>
                              onFocusWaitLocation(route.id, location.nodeId)}
                          >
                            {location.nodeLabel} · {location.atRiskCount}
                            {location.atRiskCount === 1 ? "rider" : "riders"}
                            at risk · {formatMinutes(
                              location.longestWaitSeconds,
                            )}
                          </button>
                        </li>
                      {/each}
                    </ul>
                  {/if}
                {/if}
                <div class="route-item-controls">
                  <button
                    type="button"
                    class="route-toggle route-icon"
                    data-testid={`route-edit-${route.id}`}
                    aria-label={`Edit route ${route.name}`}
                    onclick={() => {
                      pendingDeleteId = null;
                      onEditRoute(route.id);
                    }}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path
                        d="M11.3 1.6a1.3 1.3 0 0 1 1.85 0l1.25 1.25a1.3 1.3 0 0 1 0 1.85l-8.4 8.4-3.9 1.05 1.05-3.9z"
                      />
                    </svg>
                  </button>
                  <button
                    type="button"
                    class="route-toggle route-icon"
                    data-testid={`route-toggle-${route.id}`}
                    aria-label={`${route.active ? "Pause" : "Resume"} ${route.name}`}
                    onclick={() => onToggleRouteActive(route.id)}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      {#if route.active}
                        <path d="M4.5 3h2.4v10H4.5zM9.1 3h2.4v10H9.1z" />
                      {:else}
                        <path d="M4.8 3l8.4 5-8.4 5z" />
                      {/if}
                    </svg>
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
                    class="route-delete route-icon"
                    class:route-delete--armed={pendingDeleteId === route.id}
                    data-testid={`route-delete-${route.id}`}
                    aria-label={pendingDeleteId === route.id
                      ? `Confirm delete ${route.name}`
                      : `Delete route ${route.name}`}
                    onclick={() => handleDeleteClick(route.id)}
                  >
                    <svg
                      viewBox="0 0 16 16"
                      aria-hidden="true"
                      class="route-delete-icon"
                    >
                      <path
                        d="M3 4.5h10M6.4 4.5v-2h3.2v2M4.6 4.5l.8 9.2h5.2l.8-9.2M6.8 7v4M9.2 7v4"
                      />
                    </svg>
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

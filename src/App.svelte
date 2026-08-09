<script lang="ts">
  import { onMount } from "svelte";
  import CommandShelf from "./components/hud/CommandShelf.svelte";
  import CommandPanel from "./components/hud/CommandPanel.svelte";
  import BuildPanel from "./components/hud/panels/BuildPanel.svelte";
  import LinesPanel from "./components/hud/panels/LinesPanel.svelte";
  import DataPanel from "./components/hud/panels/DataPanel.svelte";
  import CityPanel from "./components/hud/panels/CityPanel.svelte";
  import InspectPanel from "./components/hud/panels/InspectPanel.svelte";
  import GameCanvas from "./components/GameCanvas.svelte";
  import Topbar from "./components/Topbar.svelte";
  import ActionFeedback from "./components/ActionFeedback.svelte";
  import type { Overlay, ServicePattern, Tool } from "./domain/types";
  import type {
    RouteDraft,
    RuntimeCommandResult,
    RuntimeController,
    RuntimeSnapshot,
  } from "./runtime/types";
  import type { CommandDestination } from "./ui/uiState";
  import type {
    BuildGroup,
    BuildItemAction,
  } from "./domain/catalog/buildGroups";

  interface Props {
    runtime: RuntimeController | null;
    error?: string | null;
  }

  let { runtime, error = null }: Props = $props();
  let shellError = $state<string | null>(null);
  let snapshot = $state<RuntimeSnapshot | null>(null);

  function setSnapshot(nextSnapshot: RuntimeSnapshot): void {
    snapshot = nextSnapshot;
    if (nextSnapshot.backendError !== null) {
      shellError = nextSnapshot.backendError;
    }
  }

  function handleDismissRejection(): void {
    if (runtime !== null) {
      setSnapshot(runtime.dismissRejection());
    }
  }

  async function applyRuntimeResult(
    getResult: () => RuntimeCommandResult,
  ): Promise<void> {
    // Accept a thunk (not the already-invoked result) so a synchronous throw
    // from the controller method (e.g. a guard firing before it returns a
    // promise) is caught here and surfaced as `shellError`, instead of
    // escaping unhandled. The call happens inside the try block.
    try {
      setSnapshot(await getResult());
    } catch (err) {
      shellError =
        err instanceof Error ? err.message : "Runtime command failed";
    }
  }

  function handleSetCommandDestination(
    destination: CommandDestination | null,
  ): void {
    if (runtime !== null) {
      setSnapshot(runtime.setCommandDestination(destination));
    }
  }

  function handleTogglePause(): void {
    if (runtime !== null) {
      void applyRuntimeResult(() => runtime.togglePause());
    }
  }

  function handleSetSpeed(speed: 1 | 2 | 4): void {
    if (runtime !== null) {
      void applyRuntimeResult(() => runtime.setSpeed(speed));
    }
  }

  function handleSetTool(tool: Tool): void {
    if (runtime !== null) {
      setSnapshot(runtime.setTool(tool));
    }
  }

  function handleRotateBuilding(): void {
    if (runtime !== null) {
      setSnapshot(runtime.rotateBuilding());
    }
  }

  function handleSetBuildGroup(group: BuildGroup | null): void {
    if (runtime !== null) {
      setSnapshot(runtime.setBuildGroup(group));
    }
  }

  function handleSelectBuildItem(action: BuildItemAction): void {
    if (runtime === null) {
      return;
    }
    if (action.kind === "road") {
      setSnapshot(runtime.armRoad(action.roadPreset));
    } else if (action.kind === "roundabout") {
      setSnapshot(runtime.armRoundabout(action.size));
    } else if (action.kind === "track") {
      setSnapshot(runtime.setTool("track"));
    } else if (action.kind === "tool") {
      setSnapshot(runtime.setTool(action.tool));
    } else if (action.kind === "area") {
      setSnapshot(runtime.setArea(action.area));
    } else {
      setSnapshot(runtime.setBuilding(action.building));
    }
  }

  function handleSetOverlay(overlay: Overlay | null): void {
    if (runtime !== null) {
      setSnapshot(runtime.setOverlay(overlay));
    }
  }

  function handleAssignRouteToPlatform(
    nodeId: string,
    routeId: string,
    platformId: string,
  ): void {
    if (runtime !== null) {
      void applyRuntimeResult(() =>
        runtime.assignRouteToPlatform(nodeId, routeId, platformId),
      );
    }
  }

  function handleSelectRouteWaypoint(
    index: number | null,
    interaction: RouteDraft["interaction"],
  ): void {
    if (runtime !== null) {
      setSnapshot(runtime.selectRouteWaypoint(index, interaction));
    }
  }

  function handleRemoveRouteWaypoint(): void {
    if (runtime !== null) {
      setSnapshot(runtime.removeRouteWaypoint());
    }
  }

  function handleUndoRouteDraft(): void {
    if (runtime !== null) {
      setSnapshot(runtime.undoRouteDraft());
    }
  }

  function handleRedoRouteDraft(): void {
    if (runtime !== null) {
      setSnapshot(runtime.redoRouteDraft());
    }
  }

  function handleMoveRouteWaypoint(delta: -1 | 1): void {
    if (runtime !== null) {
      setSnapshot(runtime.moveRouteWaypoint(delta));
    }
  }

  function handleReverseRouteDraft(): void {
    if (runtime !== null) {
      setSnapshot(runtime.reverseRouteDraft());
    }
  }

  function handleSetRoutePattern(pattern: ServicePattern): void {
    if (runtime !== null) {
      setSnapshot(runtime.setRoutePattern(pattern));
    }
  }

  function handleSaveRouteDraft(): void {
    if (runtime !== null) {
      void applyRuntimeResult(() => runtime.saveRouteDraft());
    }
  }

  function handleCancelRouteDraft(): void {
    if (runtime !== null) {
      setSnapshot(runtime.cancelRouteDraft());
    }
  }

  function handleReloadRouteDraft(): void {
    if (runtime !== null) {
      setSnapshot(runtime.reloadRouteDraft());
    }
  }

  function handleStartRouteEdit(routeId: string): void {
    if (runtime !== null) {
      setSnapshot(runtime.startRouteEdit(routeId));
    }
  }

  function handleRenameRoute(routeId: string, name: string): void {
    if (runtime !== null) {
      void applyRuntimeResult(() => runtime.renameRoute(routeId, name));
    }
  }

  function handleRecolorRoute(routeId: string, color: string): void {
    if (runtime !== null) {
      void applyRuntimeResult(() => runtime.recolorRoute(routeId, color));
    }
  }

  function handleToggleRouteActive(routeId: string): void {
    if (runtime !== null) {
      void applyRuntimeResult(() => runtime.toggleRouteActive(routeId));
    }
  }

  function handleDeleteRoute(routeId: string): void {
    if (runtime !== null) {
      void applyRuntimeResult(() => runtime.deleteRoute(routeId));
    }
  }

  function handleFocusRouteFailure(routeId: string, legIndex: number): void {
    if (runtime !== null) {
      setSnapshot(runtime.focusRouteFailure(routeId, legIndex));
    }
  }

  function handleShellError(message: string): void {
    shellError = message;
  }

  function isTextInput(target: EventTarget | null): boolean {
    return (
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable)
    );
  }

  function handleCancelOrEscape(): void {
    if (shellError || runtime === null) {
      return;
    }
    setSnapshot(runtime.handleEscape());
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (shellError || runtime === null) {
      return;
    }

    if (event.key === "Escape") {
      // An in-flight drag is abandoned first (spec §C/§G): drop the preview
      // line but keep the active tool and drawer so the player can resume
      // building. A subsequent Escape (no drag in flight) falls through to the
      // full reset below.
      // Escape mirrors the Cancel button (its label is "Cancel · Esc"). Respect
      // the same canCancel gate so Escape can't fire a reset when Cancel is
      // disabled (bare inspect with no in-flight draft, building, or overlay) —
      // otherwise it would silently jump the drawer to "Brief" while the button
      // looks dead.
      handleCancelOrEscape();
      return;
    }

    const targetIsInput = isTextInput(event.target);
    const key = event.key.toLowerCase();
    const routeDraftActive =
      snapshot !== null && snapshot.ui.routeDraft !== null;
    const routeDraftHasSelectedWaypoint =
      snapshot !== null &&
      snapshot.ui.routeDraft !== null &&
      snapshot.ui.routeDraft.selectedIndex !== null;

    if (
      !targetIsInput &&
      routeDraftActive &&
      (event.metaKey || event.ctrlKey) &&
      key === "z"
    ) {
      event.preventDefault();
      setSnapshot(
        event.shiftKey ? runtime.redoRouteDraft() : runtime.undoRouteDraft(),
      );
      return;
    }

    if (
      !targetIsInput &&
      routeDraftActive &&
      (event.metaKey || event.ctrlKey) &&
      key === "y"
    ) {
      event.preventDefault();
      setSnapshot(runtime.redoRouteDraft());
      return;
    }

    if (
      !targetIsInput &&
      routeDraftHasSelectedWaypoint &&
      (event.key === "Delete" || event.key === "Backspace")
    ) {
      event.preventDefault();
      setSnapshot(runtime.removeRouteWaypoint());
      return;
    }

    if (event.metaKey || event.ctrlKey || event.altKey || targetIsInput) {
      return;
    }

    if (key === "b") {
      const next =
        snapshot?.ui.activeCommandDestination === "build" ? null : "build";
      setSnapshot(runtime.setCommandDestination(next));
      return;
    }
    if (key === "r") {
      if (snapshot?.ui.selectedBuilding != null) {
        setSnapshot(runtime.rotateBuilding());
      } else {
        setSnapshot(runtime.setTool("road"));
      }
      return;
    }
    if (key === "t") {
      setSnapshot(runtime.setTool("track"));
      return;
    }
    if (key === "x") {
      setSnapshot(runtime.setTool("remove"));
      return;
    }
    if (key === "v") {
      setSnapshot(runtime.setTool("inspect"));
      return;
    }
    if (
      (key === "1" || key === "2" || key === "3") &&
      snapshot?.ui.activeTool === "road"
    ) {
      const preset =
        key === "1" ? "twoWay" : key === "2" ? "oneWay" : "dualBidirectional";
      setSnapshot(runtime.setRoadPreset(preset));
    }
  }

  $effect(() => {
    snapshot = runtime?.getSnapshot() ?? null;
  });

  $effect(() => {
    if (error !== null) {
      shellError = error;
    }
  });

  $effect(() => {
    if (shellError !== null && runtime !== null) {
      runtime.stop();
    }
  });

  onMount(() => {
    if (!shellError && runtime !== null) {
      const unsubscribe = runtime.subscribe((nextSnapshot: RuntimeSnapshot) => {
        setSnapshot(nextSnapshot);
      });

      runtime.start();

      return () => {
        unsubscribe();
        // Dispose (not just stop) so this runtime becomes terminal
        // synchronously. A mere `stop()` leaves the runtime alive — the canvas
        // loop can be restarted and pending work can still settle. After
        // disposal, late work cannot render or publish.
        runtime.dispose();
      };
    }
  });
</script>

<svelte:window onkeydown={handleWindowKeydown} />

{#if shellError || runtime === null}
  <main class="shell" data-testid="game-shell">
    <div class="shell-error" role="alert">
      <strong>Shell Error:</strong>
      {shellError ?? "Runtime unavailable"}
      <button
        type="button"
        class="shell-error-reload"
        data-testid="shell-error-reload"
        onclick={() => window.location.reload()}
      >
        Reload
      </button>
    </div>
  </main>
{:else}
  <main
    class="shell"
    data-testid="game-shell"
    data-command-destination={snapshot?.ui.activeCommandDestination ?? "none"}
  >
    {#if snapshot !== null}
      <Topbar
        shell={snapshot.shell.topbar}
        paused={snapshot.state.paused}
        speed={snapshot.state.speed}
        onTogglePause={handleTogglePause}
        onSetSpeed={handleSetSpeed}
      />

      <ActionFeedback
        feedback={snapshot.shell.actionFeedback}
        onDismiss={handleDismissRejection}
      />

      <div class="game-workspace">
        <GameCanvas {runtime} onShellError={handleShellError} />
        {#if snapshot.shell.inspector !== null && snapshot.ui.activeCommandDestination === null}
          <InspectPanel
            inspector={snapshot.shell.inspector}
            onAssignRouteToPlatform={handleAssignRouteToPlatform}
          />
        {/if}
      </div>

      {@const currentSnapshot = snapshot}
      {#if snapshot.ui.activeCommandDestination === "build"}
        <CommandPanel
          destination="build"
          title="Build"
          canClose={currentSnapshot.ui.routeDraft === null}
          onClose={() => handleSetCommandDestination(null)}
        >
          <BuildPanel
            activeBuildGroup={currentSnapshot.ui.activeBuildGroup}
            activeTool={currentSnapshot.ui.activeTool}
            selectedArea={currentSnapshot.ui.selectedArea}
            selectedBuilding={currentSnapshot.ui.selectedBuilding}
            roadPreset={currentSnapshot.ui.roadPreset}
            roundaboutSize={currentSnapshot.ui.roundaboutSize}
            buildingRotation={currentSnapshot.ui.buildingRotation}
            onSetBuildGroup={handleSetBuildGroup}
            onSelectItem={handleSelectBuildItem}
            onRotateBuilding={handleRotateBuilding}
          />
        </CommandPanel>
      {:else if snapshot.ui.activeCommandDestination === "lines"}
        <CommandPanel
          destination="lines"
          title="Lines"
          canClose={currentSnapshot.ui.routeDraft === null}
          onClose={() => handleSetCommandDestination(null)}
        >
          <LinesPanel
            activeTool={currentSnapshot.ui.activeTool}
            selectedBuilding={currentSnapshot.ui.selectedBuilding}
            routeDraft={currentSnapshot.shell.routeDraft}
            routes={currentSnapshot.shell.routes}
            onSetTool={(tool) => handleSetTool(tool)}
            onSelectWaypoint={handleSelectRouteWaypoint}
            onRemove={handleRemoveRouteWaypoint}
            onUndo={handleUndoRouteDraft}
            onRedo={handleRedoRouteDraft}
            onMove={handleMoveRouteWaypoint}
            onReverse={handleReverseRouteDraft}
            onPattern={handleSetRoutePattern}
            onSave={handleSaveRouteDraft}
            onCancel={handleCancelRouteDraft}
            onReload={handleReloadRouteDraft}
            onRenameRoute={handleRenameRoute}
            onRecolorRoute={handleRecolorRoute}
            onToggleRouteActive={handleToggleRouteActive}
            onDeleteRoute={handleDeleteRoute}
            onFocusRouteFailure={handleFocusRouteFailure}
            onEditRoute={handleStartRouteEdit}
          />
        </CommandPanel>
      {:else if snapshot.ui.activeCommandDestination === "data"}
        <CommandPanel
          destination="data"
          title="Data"
          canClose={currentSnapshot.ui.routeDraft === null}
          onClose={() => handleSetCommandDestination(null)}
        >
          <DataPanel
            activeOverlay={currentSnapshot.ui.activeOverlay}
            metrics={currentSnapshot.shell.topbar}
            onSetOverlay={handleSetOverlay}
          />
        </CommandPanel>
      {:else if snapshot.ui.activeCommandDestination === "city"}
        <CommandPanel
          destination="city"
          title="City"
          canClose={currentSnapshot.ui.routeDraft === null}
          onClose={() => handleSetCommandDestination(null)}
        >
          <CityPanel
            shell={currentSnapshot.shell.city}
            cityName={currentSnapshot.persistence.activeCity?.name ?? null}
          />
        </CommandPanel>
      {/if}

      <CommandShelf
        command={currentSnapshot.shell.command}
        onSetDestination={handleSetCommandDestination}
        onSetTool={(tool) => handleSetTool(tool)}
      />
    {/if}
  </main>
{/if}

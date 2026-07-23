<script lang="ts">
  import { onMount } from "svelte";
  import BottomHud from "./components/hud/BottomHud.svelte";
  import HudDrawer from "./components/hud/HudDrawer.svelte";
  import GameCanvas from "./components/GameCanvas.svelte";
  import Topbar from "./components/Topbar.svelte";
  import RoadMutationNotice from "./components/RoadMutationNotice.svelte";
  import type { AreaKind, Overlay, ServicePattern, Tool } from "./domain/types";
  import type {
    RouteDraft,
    RouteEditorView,
    RuntimeCommandResult,
    RuntimeController,
    RuntimeSnapshot,
  } from "./runtime/types";
  import { rejectionMessage } from "./runtime/rejectionMessages";
  import type { HudCategory } from "./ui/uiState";
  import type {
    BuildCategoryId,
    BuildItemAction,
  } from "./domain/catalog/buildMenu";

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

  function handleSetHudCategory(category: HudCategory | null): void {
    if (runtime !== null) {
      setSnapshot(runtime.setHudCategory(category));
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

  function handleSetArea(area: AreaKind): void {
    if (runtime !== null) {
      setSnapshot(runtime.setArea(area));
    }
  }

  function handleRotateBuilding(): void {
    if (runtime !== null) {
      setSnapshot(runtime.rotateBuilding());
    }
  }

  function handleSetBuildCategory(category: BuildCategoryId | null): void {
    if (runtime !== null) {
      setSnapshot(runtime.setBuildCategory(category));
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

  function handleSelectRoute(routeId: string | null): void {
    if (runtime !== null) {
      setSnapshot(runtime.selectRoute(routeId));
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

  type RouteEditorViewWithHistory = RouteEditorView & {
    canUndo: boolean;
    canRedo: boolean;
    notice: RuntimeSnapshot["ui"]["routeDraftNotice"];
  };

  function routeEditorView(
    current: RuntimeSnapshot,
  ): RouteEditorViewWithHistory | null {
    const editor = current.shell.routeDraft;
    return editor === null
      ? null
      : {
          ...editor,
          canUndo: current.ui.routeDraftHistory.past.length > 0,
          canRedo: current.ui.routeDraftHistory.future.length > 0,
          notice: current.ui.routeDraftNotice,
        };
  }

  function handleCancelOrEscape(): void {
    if (shellError || runtime === null) {
      return;
    }
    if (snapshot !== null && snapshot.ui.drag !== null) {
      setSnapshot(runtime.cancelDrag());
      return;
    }
    if (snapshot !== null && !snapshot.shell.hud.canCancel) {
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
      routeDraftActive &&
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
      const next = snapshot?.ui.activeHudCategory === "build" ? null : "build";
      setSnapshot(runtime.setHudCategory(next));
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
        runtime.stop();
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
    data-hud-category={snapshot?.ui.activeHudCategory ?? "none"}
  >
    {#if snapshot !== null}
      <Topbar
        shell={snapshot.shell.topbar}
        paused={snapshot.state.paused}
        speed={snapshot.state.speed}
        onTogglePause={handleTogglePause}
        onSetSpeed={handleSetSpeed}
      />

      {#if snapshot.rejection !== null && !(snapshot.rejection.code === "routeChangedWhileEditing" && snapshot.shell.routeDraft?.canReload === true)}
        <div
          class="rejection-banner"
          data-testid="rejection-banner"
          role="status"
        >
          <span>{rejectionMessage(snapshot.rejection)}</span>
          <button
            type="button"
            class="rejection-dismiss"
            aria-label="Dismiss"
            onclick={handleDismissRejection}
          >
            &times;
          </button>
        </div>
      {/if}

      <RoadMutationNotice
        preview={snapshot.shell.roadMutationPreview}
        error={snapshot.ui.roadMutationPreviewError}
      />

      <GameCanvas {runtime} onShellError={handleShellError} />

      <HudDrawer
        category={snapshot.ui.activeHudCategory}
        brief={snapshot.shell.brief}
        activeTool={snapshot.ui.activeTool}
        activeOverlay={snapshot.ui.activeOverlay}
        selectedArea={snapshot.ui.selectedArea}
        selectedBuilding={snapshot.ui.selectedBuilding}
        buildingRotation={snapshot.ui.buildingRotation}
        roadPreset={snapshot.ui.roadPreset}
        roundaboutSize={snapshot.ui.roundaboutSize}
        buildCategory={snapshot.ui.buildCategory}
        inspector={snapshot.shell.inspector}
        routeDraft={routeEditorView(snapshot)}
        routes={snapshot.shell.routes}
        onCloseDrawer={() => handleSetHudCategory(null)}
        onSetTool={handleSetTool}
        onSetArea={handleSetArea}
        onRotateBuilding={handleRotateBuilding}
        onSetBuildCategory={handleSetBuildCategory}
        onSelectBuildItem={handleSelectBuildItem}
        onSetOverlay={handleSetOverlay}
        onAssignRouteToPlatform={handleAssignRouteToPlatform}
        onSelectRouteWaypoint={handleSelectRouteWaypoint}
        onRemoveRouteWaypoint={handleRemoveRouteWaypoint}
        onUndoRouteDraft={handleUndoRouteDraft}
        onRedoRouteDraft={handleRedoRouteDraft}
        onMoveRouteWaypoint={handleMoveRouteWaypoint}
        onReverseRouteDraft={handleReverseRouteDraft}
        onSetRoutePattern={handleSetRoutePattern}
        onSaveRouteDraft={handleSaveRouteDraft}
        onCancelRouteDraft={handleCancelRouteDraft}
        onReloadRouteDraft={handleReloadRouteDraft}
        onStartRouteEdit={handleStartRouteEdit}
        onRenameRoute={handleRenameRoute}
        onRecolorRoute={handleRecolorRoute}
        onToggleRouteActive={handleToggleRouteActive}
        onDeleteRoute={handleDeleteRoute}
        onSelectRoute={handleSelectRoute}
        onFocusRouteFailure={handleFocusRouteFailure}
      />

      <BottomHud
        hud={snapshot.shell.hud}
        onSetHudCategory={handleSetHudCategory}
        onCancel={handleCancelOrEscape}
        onSetTool={handleSetTool}
      />
    {/if}
  </main>
{/if}

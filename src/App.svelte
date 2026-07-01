<script lang="ts">
  import { onMount } from "svelte";
  import BottomHud from "./components/hud/BottomHud.svelte";
  import HudDrawer from "./components/hud/HudDrawer.svelte";
  import GameCanvas from "./components/GameCanvas.svelte";
  import Topbar from "./components/Topbar.svelte";
  import type {
    AreaKind,
    BuildingType,
    Overlay,
    RoadPreset,
    Tool,
  } from "./domain/types";
  import type {
    RuntimeCommandResult,
    RuntimeController,
    RuntimeSnapshot,
  } from "./runtime/types";
  import type { HudCategory } from "./ui/uiState";

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

  function handleSetBuilding(building: BuildingType): void {
    if (runtime !== null) {
      setSnapshot(runtime.setBuilding(building));
    }
  }

  function handleRotateBuilding(): void {
    if (runtime !== null) {
      setSnapshot(runtime.rotateBuilding());
    }
  }

  function handleSetRoadPreset(preset: RoadPreset): void {
    if (runtime !== null) {
      setSnapshot(runtime.setRoadPreset(preset));
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

  function handleRemoveDraftStop(index: number): void {
    if (runtime !== null) {
      setSnapshot(runtime.removeDraftStop(index));
    }
  }

  function handleFinishRoute(): void {
    if (runtime !== null) {
      void applyRuntimeResult(() => runtime.finishRoute());
    }
  }

  function handleCancelRoute(): void {
    if (runtime !== null) {
      setSnapshot(runtime.cancelRoute());
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

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (shellError || runtime === null) {
      return;
    }

    if (event.key === "Escape") {
      // An in-flight drag is abandoned first (spec §C/§G): drop the preview
      // line but keep the active tool and drawer so the player can resume
      // building. A subsequent Escape (no drag in flight) falls through to the
      // full reset below.
      if (snapshot !== null && snapshot.ui.drag !== null) {
        setSnapshot(runtime.cancelDrag());
        return;
      }
      // Escape mirrors the Cancel button (its label is "Cancel · Esc"). Respect
      // the same canCancel gate so Escape can't fire a reset when Cancel is
      // disabled (bare inspect with no in-flight draft, building, or overlay) —
      // otherwise it would silently jump the drawer to "Brief" while the button
      // looks dead.
      if (snapshot !== null && !snapshot.shell.hud.canCancel) {
        return;
      }
      setSnapshot(runtime.resetUi());
      return;
    }

    if (
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      isTextInput(event.target)
    ) {
      return;
    }

    const key = event.key.toLowerCase();
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

      {#if snapshot.rejection !== null}
        <div
          class="rejection-banner"
          data-testid="rejection-banner"
          role="status"
        >
          <span>{snapshot.rejection}</span>
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
        inspector={snapshot.shell.inspector}
        routeDraft={snapshot.shell.routeDraft}
        routes={snapshot.shell.routes}
        onCloseDrawer={() => handleSetHudCategory(null)}
        onSetTool={handleSetTool}
        onSetArea={handleSetArea}
        onSetBuilding={handleSetBuilding}
        onRotateBuilding={handleRotateBuilding}
        onSetRoadPreset={handleSetRoadPreset}
        onSetOverlay={handleSetOverlay}
        onAssignRouteToPlatform={handleAssignRouteToPlatform}
        onRemoveDraftStop={handleRemoveDraftStop}
        onFinishRoute={handleFinishRoute}
        onCancelRoute={handleCancelRoute}
        onRenameRoute={handleRenameRoute}
        onRecolorRoute={handleRecolorRoute}
        onToggleRouteActive={handleToggleRouteActive}
        onDeleteRoute={handleDeleteRoute}
        onSelectRoute={handleSelectRoute}
      />

      <BottomHud
        hud={snapshot.shell.hud}
        onSetHudCategory={handleSetHudCategory}
        onCancel={() => setSnapshot(runtime.resetUi())}
      />
    {/if}
  </main>
{/if}

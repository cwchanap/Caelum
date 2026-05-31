<script lang="ts">
  import { onMount } from "svelte";
  import ControlTower from "./components/ControlTower.svelte";
  import GameCanvas from "./components/GameCanvas.svelte";
  import Topbar from "./components/Topbar.svelte";
  import type { Overlay, Tool } from "./domain/types";
  import type { RuntimeController, RuntimeSnapshot } from "./runtime/types";

  interface Props {
    runtime: RuntimeController;
    error?: string | null;
  }

  let { runtime, error = null }: Props = $props();
  let shellError = $state<string | null>(null);
  let snapshot = $state<RuntimeSnapshot | null>(null);

  function setSnapshot(nextSnapshot: RuntimeSnapshot): void {
    snapshot = nextSnapshot;
  }

  function handleToggleControlTower(): void {
    setSnapshot(runtime.toggleControlTower());
  }

  function handleTogglePause(): void {
    setSnapshot(runtime.togglePause());
  }

  function handleSetSpeed(speed: 1 | 2 | 4): void {
    setSnapshot(runtime.setSpeed(speed));
  }

  function handleSetTool(tool: Tool): void {
    setSnapshot(runtime.setTool(tool));
  }

  function handleSetOverlay(overlay: Overlay | null): void {
    setSnapshot(runtime.setOverlay(overlay));
  }

  function handleShellError(message: string): void {
    shellError = message;
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (shellError || event.key !== "Escape") {
      return;
    }

    setSnapshot(runtime.resetUi());
  }

  $effect(() => {
    snapshot = runtime.getSnapshot();
  });

  $effect(() => {
    if (error !== null) {
      shellError = error;
    }
  });

  $effect(() => {
    if (shellError !== null) {
      runtime.stop();
    }
  });

  onMount(() => {
    if (!shellError) {
      const unsubscribe = runtime.subscribe((nextSnapshot: RuntimeSnapshot) => {
        snapshot = nextSnapshot;
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

{#if shellError}
  <main class="shell" data-testid="game-shell">
    <div class="shell-error" role="alert">
      <strong>Shell Error:</strong>
      {shellError}
    </div>
  </main>
{:else}
  <main
    class="shell"
    data-testid="game-shell"
    data-tower-open={snapshot?.ui.controlTowerOpen ?? false}
  >
    {#if snapshot !== null}
      <Topbar
        shell={snapshot.shell.topbar}
        paused={snapshot.state.paused}
        speed={snapshot.state.speed}
        controlTowerOpen={snapshot.ui.controlTowerOpen}
        onToggleControlTower={handleToggleControlTower}
        onTogglePause={handleTogglePause}
        onSetSpeed={handleSetSpeed}
      />

      <GameCanvas {runtime} onShellError={handleShellError} />

      <ControlTower
        shell={snapshot.shell.controlTower}
        activeTool={snapshot.ui.activeTool}
        activeOverlay={snapshot.ui.activeOverlay}
        onToggleControlTower={handleToggleControlTower}
        onSetTool={handleSetTool}
        onSetOverlay={handleSetOverlay}
      />
    {/if}
  </main>
{/if}

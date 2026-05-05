<script lang="ts">
  import { onMount } from "svelte";
  import ControlTower from "./components/ControlTower.svelte";
  import Topbar from "./components/Topbar.svelte";
  import type { Overlay, Tool } from "./domain/types";
  import type { RuntimeController, RuntimeSnapshot } from "./runtime/types";

  interface Props {
    runtime: RuntimeController;
    error?: string | null;
  }

  let props: Props = $props();
  let snapshot = $state<RuntimeSnapshot | null>(null);
  let canvasHost = $state<HTMLDivElement | null>(null);

  function setSnapshot(nextSnapshot: RuntimeSnapshot): void {
    snapshot = nextSnapshot;
  }

  function handleToggleControlTower(): void {
    setSnapshot(props.runtime.toggleControlTower());
  }

  function handleTogglePause(): void {
    setSnapshot(props.runtime.togglePause());
  }

  function handleSetSpeed(speed: 1 | 2 | 4): void {
    setSnapshot(props.runtime.setSpeed(speed));
  }

  function handleSetTool(tool: Tool): void {
    setSnapshot(props.runtime.setTool(tool));
  }

  function handleSetOverlay(overlay: Overlay | null): void {
    setSnapshot(props.runtime.setOverlay(overlay));
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (props.error || event.key !== "Escape") {
      return;
    }

    setSnapshot(props.runtime.resetUi());
  }

  $effect(() => {
    snapshot = props.runtime.getSnapshot();
  });

  $effect(() => {
    if (props.error || canvasHost === null) {
      return;
    }

    return props.runtime.mountCanvas(canvasHost);
  });

  onMount(() => {
    if (!props.error) {
      const unsubscribe = props.runtime.subscribe((nextSnapshot: RuntimeSnapshot) => {
        snapshot = nextSnapshot;
      });

      props.runtime.start();

      return () => {
        unsubscribe();
        props.runtime.stop();
      };
    }
  });
</script>

<svelte:window onkeydown={handleWindowKeydown} />

{#if props.error}
  <main class="shell" data-testid="game-shell">
    <div class="shell-error" role="alert">
      <strong>Shell Error:</strong> {props.error}
    </div>
  </main>
{:else}
  <main class="shell" data-testid="game-shell" data-tower-open={snapshot?.ui.controlTowerOpen ?? false}>
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

      <div class="board" data-testid="game-canvas-host" bind:this={canvasHost}></div>

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

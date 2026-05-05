<script lang="ts">
  import { onMount } from "svelte";
  import type { RuntimeController, RuntimeSnapshot } from "./runtime/types";

  interface Props {
    runtime: RuntimeController;
    error?: string | null;
  }

  let props: Props = $props();
  let snapshot = $state<RuntimeSnapshot | null>(null);
  let canvasHost = $state<HTMLDivElement | null>(null);

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

{#if props.error}
  <main class="shell" data-testid="game-shell">
    <div class="shell-error" role="alert">
      <strong>Shell Error:</strong> {props.error}
    </div>
  </main>
{:else}
  <main class="shell" data-testid="game-shell">
    {#if snapshot !== null}
      <section class="topbar" data-testid="topbar">
        <div class="topbar-readout">
          <span class="readout-label">Budget</span>
          <strong>{snapshot.shell.topbar.budget}</strong>
        </div>
        <div class="topbar-readout">
          <span class="readout-label">Signal</span>
          <strong>{snapshot.shell.topbar.signalState}</strong>
        </div>
      </section>

      <div class="board" data-testid="game-canvas-host" bind:this={canvasHost}></div>

      <aside
        class="panel control-tower"
        data-testid="control-tower"
        data-open={snapshot.shell.controlTower.controlTowerOpen}
        aria-hidden={!snapshot.shell.controlTower.controlTowerOpen}
      >
        <div class="panel-header">
          <h2>{snapshot.shell.controlTower.title}</h2>
          <span>{snapshot.shell.controlTower.status}</span>
        </div>
        <p>{snapshot.shell.controlTower.objective}</p>
      </aside>
    {/if}
  </main>
{/if}

<style>
  .shell {
    display: grid;
    grid-template-rows: auto 1fr;
    grid-template-columns: 1fr auto;
    height: 100vh;
    width: 100vw;
  }

  .topbar {
    grid-column: 1 / -1;
    background: #1a1a1a;
    padding: 0.5rem;
    display: flex;
    gap: 1rem;
  }

  .board {
    grid-row: 2;
    grid-column: 1;
    position: relative;
    overflow: hidden;
  }

  .panel {
    grid-row: 2;
    grid-column: 2;
    background: #2a2a2a;
    min-width: 300px;
    color: #f4f4f5;
    padding: 1rem;
  }

  .shell-error {
    grid-column: 1 / -1;
    background: #ff4444;
    color: white;
    padding: 1rem;
    font-weight: bold;
  }

  .topbar-readout {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    color: #f4f4f5;
  }

  .readout-label {
    color: #888;
    font-size: 0.75rem;
    text-transform: uppercase;
  }

  .panel-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
  }

  .control-tower[data-open="false"] {
    min-width: 0;
    width: 0;
    padding: 0;
    overflow: hidden;
    opacity: 0;
    transform: translateX(1rem);
  }
</style>

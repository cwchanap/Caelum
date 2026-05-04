<script lang="ts">
import { onMount } from "svelte";

interface ShellState {
  shell: {
    topbar: { budget: string; signalState: string };
    controlTower: { title: string; controlTowerOpen: boolean };
  };
}

interface RuntimeController {
  getSnapshot: () => ShellState;
  subscribe: (listener: (snapshot: ShellState) => void) => () => void;
  start: () => void;
  stop: () => void;
}

interface Props {
  runtime: RuntimeController;
  error?: string | null;
}

let { runtime, error = null }: Props = $props();

onMount(() => {
  runtime.start();
  return () => {
    runtime.stop();
  };
});
</script>

{#if error}
  <main class="shell" data-testid="game-shell">
    <div class="shell-error" role="alert">
      <strong>Shell Error:</strong> {error}
    </div>
  </main>
{:else}
  <main class="shell" data-testid="game-shell">
    <section class="topbar" data-testid="topbar">
      <div class="topbar-placeholder">Topbar Placeholder</div>
    </section>
    
    <div class="board" data-testid="game-canvas-host">
      <div class="canvas-placeholder">Canvas Host Placeholder</div>
    </div>
    
    <aside class="panel control-tower" data-testid="control-tower">
      <div class="panel-placeholder">Panel Placeholder</div>
    </aside>
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
  }

  .shell-error {
    grid-column: 1 / -1;
    background: #ff4444;
    color: white;
    padding: 1rem;
    font-weight: bold;
  }

  .topbar-placeholder,
  .canvas-placeholder,
  .panel-placeholder {
    padding: 1rem;
    color: #888;
  }
</style>

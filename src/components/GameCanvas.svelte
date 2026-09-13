<script lang="ts">
  import type { RuntimeController, RuntimeSnapshot } from "../runtime/types";
  import MapTextOverlay from "./MapTextOverlay.svelte";

  interface Props {
    runtime: Pick<RuntimeController, "mountCanvas">;
    snapshot: RuntimeSnapshot | null;
    onShellError: (message: string) => void;
  }

  let { runtime, snapshot, onShellError }: Props = $props();
  let host = $state<HTMLDivElement | null>(null);

  // Mount into the surface only, so the Svelte-owned map text overlay
  // survives the runtime's canvas replacement.
  function mountRuntime(element: HTMLDivElement) {
    let teardown: (() => void) | undefined;
    try {
      teardown = runtime.mountCanvas(element);
    } catch (error) {
      onShellError(
        error instanceof Error
          ? error.message
          : "Failed to attach game canvas.",
      );
    }
    return { destroy: () => teardown?.() };
  }

  export function focus(): void {
    host?.focus();
  }
</script>

<div
  class="board"
  data-testid="game-canvas-host"
  bind:this={host}
  tabindex="-1"
  role="region"
  aria-label="City map"
  aria-describedby="game-canvas-description"
>
  <div class="board-surface" use:mountRuntime></div>
  {#if snapshot !== null}
    <MapTextOverlay state={snapshot.state} ui={snapshot.ui} />
  {/if}
</div>
<p id="game-canvas-description" class="sr-only">
  Build and inspect the transport sandbox on the city map.
</p>

<script lang="ts">
  import { onMount } from "svelte";
  import type { RuntimeController, RuntimeSnapshot } from "../runtime/types";
  import MapTextOverlay from "./MapTextOverlay.svelte";

  interface Props {
    runtime: Pick<RuntimeController, "mountCanvas">;
    snapshot: RuntimeSnapshot | null;
    onShellError: (message: string) => void;
  }

  let { runtime, snapshot, onShellError }: Props = $props();
  let host = $state<HTMLDivElement | null>(null);
  let surface = $state<HTMLDivElement | null>(null);

  onMount(() => {
    if (surface === null) {
      onShellError("Canvas host is unavailable");
      return;
    }

    try {
      // Mount into the surface only, so the Svelte-owned map text overlay
      // survives the runtime's canvas replacement.
      return runtime.mountCanvas(surface);
    } catch (error) {
      onShellError(
        error instanceof Error
          ? error.message
          : "Failed to attach game canvas.",
      );
    }
  });

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
  <div class="board-surface" bind:this={surface}></div>
  {#if snapshot !== null}
    <MapTextOverlay state={snapshot.state} ui={snapshot.ui} />
  {/if}
</div>
<p id="game-canvas-description" class="sr-only">
  Build and inspect the transport sandbox on the city map.
</p>

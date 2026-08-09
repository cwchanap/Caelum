<script lang="ts">
  import { onMount } from "svelte";
  import type { RuntimeController } from "../runtime/types";

  interface Props {
    runtime: Pick<RuntimeController, "mountCanvas">;
    onShellError: (message: string) => void;
  }

  let { runtime, onShellError }: Props = $props();
  let host = $state<HTMLDivElement | null>(null);

  onMount(() => {
    if (host === null) {
      onShellError("Canvas host is unavailable");
      return;
    }

    try {
      return runtime.mountCanvas(host);
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
  aria-label="City map"
  aria-describedby="game-canvas-description"
></div>
<p id="game-canvas-description" class="sr-only">
  Build and inspect the transport sandbox on the city map.
</p>

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
</script>

<div class="board" data-testid="game-canvas-host" bind:this={host}></div>

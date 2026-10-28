<script lang="ts">
  import type { RuntimeController, RuntimeSnapshot } from "../runtime/types";
  import MapTextOverlay from "./MapTextOverlay.svelte";
  import OverlayLegend from "./OverlayLegend.svelte";

  interface Props {
    runtime: Pick<RuntimeController, "mountCanvas" | "adjustCamera">;
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
    <MapTextOverlay
      state={snapshot.state}
      ui={snapshot.ui}
      camera={snapshot.camera}
    />
    <OverlayLegend activeOverlay={snapshot.ui.activeOverlay} />
  {/if}
  <div class="board-zoom" role="group" aria-label="Map view">
    <button
      type="button"
      data-testid="map-zoom-in"
      aria-label="Zoom in"
      title="Zoom in (+)"
      onclick={() => runtime.adjustCamera({ kind: "zoomIn" })}>+</button
    >
    <button
      type="button"
      data-testid="map-zoom-out"
      aria-label="Zoom out"
      title="Zoom out (-)"
      onclick={() => runtime.adjustCamera({ kind: "zoomOut" })}>−</button
    >
    <button
      type="button"
      data-testid="map-zoom-fit"
      aria-label="Show whole map"
      title="Show whole map (0)"
      disabled={snapshot?.camera == null}
      onclick={() => runtime.adjustCamera({ kind: "fit" })}>Fit</button
    >
  </div>
</div>
<p id="game-canvas-description" class="sr-only">
  Build and inspect the transport sandbox on the city map. Scroll to zoom; drag,
  middle-drag, or hold Space and drag to pan.
</p>

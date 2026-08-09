<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import type { CommandDestination } from "../../ui/uiState";

  interface Props {
    destination: CommandDestination;
    title: string;
    canClose: boolean;
    onClose: () => void;
    children?: Snippet;
  }

  let { destination, title, canClose, onClose, children }: Props = $props();
  let region: HTMLElement | null = $state(null);

  $effect(() => {
    const openedDestination = destination;
    void tick().then(() => {
      if (destination === openedDestination) region?.focus();
    });
  });
</script>

<section
  bind:this={region}
  id={`command-panel-${destination}`}
  class="command-panel"
  data-testid="command-panel"
  data-command-panel={destination}
  aria-labelledby={`command-panel-title-${destination}`}
  tabindex="-1"
>
  <header class="command-panel__header">
    <h2 id={`command-panel-title-${destination}`}>{title}</h2>
    <button
      type="button"
      disabled={!canClose}
      onclick={onClose}
      aria-label={`Close ${title}`}>×</button
    >
  </header>
  <div class="command-panel__body">
    {#if children}{@render children()}{/if}
  </div>
</section>

<style>
  .command-panel {
    --panel-surface: var(--surface, #0d161a);
    --panel-line: var(--line-strong, rgba(255, 255, 255, 0.16));
    --panel-ink: var(--ink, #e6f1f4);
    --panel-muted: var(--ink-mid, #9aaeb6);
    --panel-signal: var(--cyan, #3fe0c5);
    max-width: calc(100vw - 32px);
    max-height: min(540px, calc(100vh - 120px));
    overflow: hidden;
    color: var(--panel-ink);
    background: var(--panel-surface);
    border: 1px solid var(--panel-line);
    border-radius: 8px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.25);
  }

  .command-panel:focus-visible {
    outline: 2px solid var(--panel-signal);
    outline-offset: 3px;
  }

  .command-panel__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--panel-line);
  }

  .command-panel__header h2 {
    margin: 0;
    font-family: var(--font-display, system-ui, sans-serif);
    font-size: 18px;
    line-height: 1.2;
  }

  .command-panel__header button {
    display: grid;
    width: 36px;
    height: 36px;
    place-items: center;
    border: 1px solid transparent;
    border-radius: 6px;
    color: var(--panel-muted);
    background: transparent;
    cursor: pointer;
    font-size: 24px;
    line-height: 1;
  }

  .command-panel__header button:hover:not(:disabled) {
    color: var(--panel-ink);
    border-color: var(--panel-line);
  }

  .command-panel__header button:focus-visible {
    outline: 2px solid var(--panel-signal);
    outline-offset: 2px;
  }

  .command-panel__header button:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .command-panel__body {
    max-height: min(470px, calc(100vh - 190px));
    overflow: auto;
    padding: 16px;
  }

  @media (prefers-reduced-motion: reduce) {
    .command-panel {
      scroll-behavior: auto;
    }
  }
</style>

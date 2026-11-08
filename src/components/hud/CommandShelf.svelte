<script lang="ts">
  import type { Tool } from "../../domain/types";
  import type { ShellCommandState } from "../../runtime/types";
  import type { CommandDestination } from "../../ui/uiState";
  import { BUILD_KEY, DEMOLISH_KEY, SELECT_KEY } from "../../ui/shortcuts";

  interface Props {
    command: ShellCommandState;
    onSetDestination: (destination: CommandDestination | null) => void;
    onSetTool: (tool: Extract<Tool, "inspect" | "remove">) => void;
  }

  let { command, onSetDestination, onSetTool }: Props = $props();
  let triggers: Partial<Record<CommandDestination, HTMLButtonElement>> = $state(
    {},
  );

  const destinations = [
    {
      id: "build",
      label: "Build",
      path: "M4 20h16M6 20V8l6-4 6 4v12M9 20v-6h6v6",
    },
    {
      id: "lines",
      label: "Lines",
      path: "M5 5h4v4H5zM15 15h4v4h-4zM9 7h4a4 4 0 0 1 4 4v4",
    },
    { id: "data", label: "Data", path: "M5 19V9M12 19V5M19 19v-7" },
    {
      id: "city",
      label: "City",
      path: "M4 20V8h7v12M11 20V4h9v16M7 12h1M7 16h1M15 8h1M15 12h1M15 16h1",
    },
  ] as const satisfies ReadonlyArray<{
    id: CommandDestination;
    label: string;
    path: string;
  }>;

  function activate(destination: CommandDestination): void {
    if (command.routeDraftActive && destination !== "lines") return;
    onSetDestination(
      command.activeDestination === destination ? null : destination,
    );
  }

  function activateTool(tool: "inspect" | "remove"): void {
    if (command.routeDraftActive) return;
    onSetTool(tool);
  }

  export function focusDestination(destination: CommandDestination): void {
    triggers[destination]?.focus();
  }
</script>

<nav
  class="command-shelf"
  data-testid="command-shelf"
  aria-label="Game commands"
>
  <div class="command-shelf__destinations">
    {#each destinations as destination (destination.id)}
      <button
        type="button"
        class="command-shelf__destination"
        class:is-active={command.activeDestination === destination.id}
        aria-expanded={command.activeDestination === destination.id}
        aria-controls={`command-panel-${destination.id}`}
        aria-keyshortcuts={destination.id === "build" ? BUILD_KEY : undefined}
        title={destination.id === "build"
          ? `Build (${BUILD_KEY.toUpperCase()})`
          : undefined}
        aria-disabled={command.routeDraftActive && destination.id !== "lines"
          ? "true"
          : undefined}
        aria-describedby={command.routeDraftActive && destination.id !== "lines"
          ? "route-draft-shelf-gate"
          : undefined}
        data-testid={`command-destination-${destination.id}`}
        onclick={() => activate(destination.id)}
        bind:this={triggers[destination.id]}
      >
        <svg
          class="command-shelf__icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d={destination.path} />
        </svg>
        <span class="command-shelf__label">
          {destination.label}{#if destination.id === "build"}<kbd
              class="command-shelf__shortcut"
              aria-hidden="true">{BUILD_KEY.toUpperCase()}</kbd
            >{:else if destination.id === "lines"}<span
              class="chip command-shelf__badge"
              aria-label={`${command.lineCount} lines`}
              >{command.lineCount}</span
            >{:else if destination.id === "data" && command.activeOverlayLabel !== null}<span
              class="chip command-shelf__badge command-shelf__badge--overlay"
              >{command.activeOverlayLabel}</span
            >{/if}
        </span>
      </button>
    {/each}
  </div>

  <div class="command-shelf__tools" aria-label="Tool modes">
    <button
      type="button"
      class="command-shelf__tool"
      class:is-active={command.selectActive}
      aria-pressed={command.selectActive}
      aria-keyshortcuts={SELECT_KEY}
      title={`Select (${SELECT_KEY.toUpperCase()})`}
      aria-disabled={command.routeDraftActive ? "true" : undefined}
      aria-describedby={command.routeDraftActive
        ? "route-draft-shelf-gate"
        : undefined}
      data-testid="command-tool-select"
      onclick={() => activateTool("inspect")}
    >
      <span class="command-shelf__tool-mark" aria-hidden="true">⌖</span>
      <span>Select</span>
      <kbd class="command-shelf__shortcut" aria-hidden="true"
        >{SELECT_KEY.toUpperCase()}</kbd
      >
    </button>
    <button
      type="button"
      class="command-shelf__tool command-shelf__tool--danger"
      class:is-active={command.demolishActive}
      aria-pressed={command.demolishActive}
      aria-keyshortcuts={DEMOLISH_KEY}
      title={`Demolish (${DEMOLISH_KEY.toUpperCase()})`}
      aria-disabled={command.routeDraftActive ? "true" : undefined}
      aria-describedby={command.routeDraftActive
        ? "route-draft-shelf-gate"
        : undefined}
      data-testid="command-tool-demolish"
      onclick={() => activateTool("remove")}
    >
      <span class="command-shelf__tool-mark" aria-hidden="true">⌫</span>
      <span>Demolish</span>
      <kbd class="command-shelf__shortcut" aria-hidden="true"
        >{DEMOLISH_KEY.toUpperCase()}</kbd
      >
    </button>
    <div class="command-shelf__mode" data-testid="command-active-mode">
      <span class="command-shelf__eyebrow">Active mode</span>
      <span class="command-shelf__mode-value">{command.activeModeLabel}</span>
    </div>
  </div>

  {#if command.routeDraftActive}
    <span
      id="route-draft-shelf-gate"
      data-testid="route-draft-shelf-gate"
      class="command-shelf__gate"
    >
      Save or cancel the active route draft to switch commands.
    </span>
  {/if}
</nav>

<style>
  .command-shelf {
    --shelf-surface: var(--surface-raised, #fffdf6);
    --shelf-line: var(--line-strong, rgba(62, 54, 38, 0.28));
    --shelf-ink: var(--ink, #2f3a3f);
    --shelf-muted: var(--ink-mid, #5d6d72);
    --shelf-signal: var(--accent, #0f8a70);
    --shelf-danger: var(--danger, #bd4a3f);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
    min-height: 60px;
    padding: 8px 14px;
    border-radius: 16px;
    color: var(--shelf-ink);
    background: linear-gradient(
      180deg,
      var(--shelf-surface),
      var(--surface, #faf6ea)
    );
    border: 1px solid var(--shelf-line);
    box-shadow: 0 10px 28px rgba(62, 54, 38, 0.18);
    font-family: var(--font-body, system-ui, sans-serif);
  }

  .command-shelf__destinations,
  .command-shelf__tools {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .command-shelf__destinations {
    justify-content: center;
  }

  .command-shelf__tools {
    justify-content: flex-end;
    min-width: 0;
    padding-left: 16px;
    border-left: 1px solid var(--shelf-line);
  }

  .command-shelf__destination,
  .command-shelf__tool {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    border: 1px solid transparent;
    border-radius: 6px;
    color: var(--shelf-muted);
    background: transparent;
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    transition:
      color 150ms ease,
      background-color 150ms ease,
      border-color 150ms ease,
      opacity 150ms ease,
      transform 150ms ease;
  }

  .command-shelf__destination {
    gap: 7px;
    padding: 7px 12px;
  }

  .command-shelf__label {
    display: inline-flex;
    align-items: center;
    gap: 7px;
  }

  .command-shelf__destination:hover,
  .command-shelf__tool:hover {
    color: var(--shelf-ink);
    background: color-mix(in srgb, var(--shelf-signal) 8%, transparent);
    border-color: color-mix(in srgb, var(--shelf-signal) 24%, transparent);
    transform: translateY(-1px);
  }

  .command-shelf__destination:focus-visible,
  .command-shelf__tool:focus-visible {
    outline: 2px solid var(--shelf-signal);
    outline-offset: 2px;
  }

  .command-shelf__destination.is-active,
  .command-shelf__tool.is-active {
    color: var(--shelf-signal);
    background: color-mix(in srgb, var(--shelf-signal) 12%, transparent);
    border-color: color-mix(in srgb, var(--shelf-signal) 42%, transparent);
  }

  .command-shelf__icon {
    width: 20px;
    height: 20px;
    flex: 0 0 auto;
  }

  .command-shelf__badge {
    min-width: 20px;
    padding: 1px 5px;
    border-color: color-mix(in srgb, var(--shelf-signal) 45%, transparent);
    color: var(--shelf-signal);
    font-variant-numeric: tabular-nums;
    text-align: center;
  }

  .command-shelf__badge--overlay {
    max-width: 100px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .command-shelf__shortcut {
    display: inline-grid;
    place-items: center;
    min-width: 18px;
    padding: 1px 4px;
    border: 1px solid var(--shelf-line);
    border-radius: 4px;
    color: var(--shelf-muted);
    font-family: var(--font-body, system-ui, sans-serif);
    font-size: 10px;
    line-height: 1.2;
    text-align: center;
  }

  .command-shelf__tool {
    gap: 6px;
    padding: 7px 10px;
  }

  .command-shelf__tool--danger.is-active {
    color: var(--shelf-danger);
    background: color-mix(in srgb, var(--shelf-danger) 12%, transparent);
    border-color: color-mix(in srgb, var(--shelf-danger) 42%, transparent);
  }

  .command-shelf__tool-mark {
    font-size: 18px;
    line-height: 1;
  }

  .command-shelf__mode {
    display: grid;
    gap: 2px;
    min-width: 112px;
    padding-left: 12px;
    border-left: 1px solid var(--shelf-line);
  }

  .command-shelf__eyebrow {
    color: var(--shelf-muted);
    font-family: var(--font-body, system-ui, sans-serif);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .command-shelf__mode-value {
    color: var(--shelf-ink);
    font-family: var(--font-body, system-ui, sans-serif);
    font-size: 12px;
    font-weight: 600;
  }

  .command-shelf__gate {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  @media (max-width: 1199px) {
    .command-shelf {
      gap: 10px;
      padding: 8px 10px;
    }

    .command-shelf__destinations,
    .command-shelf__tools {
      gap: 6px;
    }

    .command-shelf__tools {
      padding-left: 10px;
    }

    .command-shelf__destination {
      gap: 6px;
      padding: 7px 9px;
    }

    .command-shelf__label {
      gap: 6px;
    }

    .command-shelf__tool {
      padding: 7px 8px;
    }

    .command-shelf__mode {
      min-width: 96px;
      padding-left: 8px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .command-shelf__destination,
    .command-shelf__tool {
      transition: none;
    }

    .command-shelf__destination:hover,
    .command-shelf__tool:hover {
      transform: none;
    }
  }
</style>

<script lang="ts">
  import type { GameState } from "../domain/types";
  import type { ShellTopbarState } from "../runtime/types";

  interface Props {
    shell: ShellTopbarState;
    cityName: string;
    busy: boolean;
    dirty: boolean;
    status: { label: string; canRetry: boolean };
    paused: boolean;
    speed: GameState["speed"];
    onTogglePause: () => void;
    onSetSpeed: (speed: 1 | 2 | 4) => void;
    onRetrySave: () => void;
  }

  const stats: Array<{
    key: "budget" | "dailyOperatingCost" | "population" | "avgWait";
    label: string;
  }> = [
    { key: "budget", label: "Money" },
    { key: "dailyOperatingCost", label: "Daily cost" },
    { key: "population", label: "Population" },
    { key: "avgWait", label: "Avg Wait" },
  ];

  let {
    shell,
    cityName,
    busy,
    dirty,
    status,
    paused,
    speed,
    onTogglePause,
    onSetSpeed,
    onRetrySave,
  }: Props = $props();
</script>

<section class="topbar" data-testid="topbar">
  <div class="card topbar-cluster topbar-cluster--city">
    <div class="topbar-city">
      <span class="readout-label">Active city</span>
      <span
        class="topbar-city-name"
        data-testid="topbar-city-name"
        title={cityName}>{cityName}</span
      >
    </div>
    <span
      class="chip topbar-save-status"
      data-testid="topbar-save-status"
      data-busy={busy}
      data-dirty={dirty}
      >{status.label}{#if status.canRetry}
        &nbsp;· <button type="button" disabled={busy} onclick={onRetrySave}
          >Retry</button
        >{/if}</span
    >
  </div>

  <div
    class="card topbar-cluster topbar-cluster--clock"
    data-testid="topbar-clock"
  >
    <button
      type="button"
      class="btn ctrl-pause"
      data-action="pause"
      aria-label={paused ? "Resume" : "Pause"}
      aria-pressed={paused}
      onclick={onTogglePause}
    >
      <span aria-hidden="true">{paused ? "▶" : "⏸"}</span>
    </button>

    <div class="readout readout--clock">
      <span class="readout-label">Time</span>
      <span class="readout-value">{shell.time}</span>
    </div>

    <div
      class={["segmented speed-group", { "speed-group--paused": paused }]}
      role="group"
      aria-label="Simulation speed"
    >
      {#each [1, 2, 4] as speedOption (speedOption)}
        <button
          type="button"
          data-speed={speedOption}
          aria-pressed={speed === speedOption}
          class={{ active: speed === speedOption }}
          onclick={() => onSetSpeed(speedOption as 1 | 2 | 4)}
        >
          {speedOption}x
        </button>
      {/each}
    </div>
  </div>

  <div class="card topbar-cluster topbar-cluster--stats">
    {#each stats as stat (stat.key)}
      <div class="readout">
        <span class="readout-label">{stat.label}</span>
        <span class="readout-value" title={shell[stat.key]}
          >{shell[stat.key]}</span
        >
      </div>
    {/each}
    {#if shell.tripIssues !== null}
      <span
        class="chip topbar-trip-issues"
        data-testid="topbar-trip-issues"
        title={shell.tripIssues}>{shell.tripIssues}</span
      >
    {/if}
  </div>
</section>

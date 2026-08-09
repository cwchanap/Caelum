<script lang="ts">
  import type { GameState } from "../domain/types";
  import type { ShellTopbarState } from "../runtime/types";

  interface Props {
    shell: ShellTopbarState;
    paused: boolean;
    speed: GameState["speed"];
    onTogglePause: () => void;
    onSetSpeed: (speed: 1 | 2 | 4) => void;
  }

  const readouts: Array<{
    key: keyof ShellTopbarState;
    label: string;
    wide?: boolean;
  }> = [
    { key: "budget", label: "Money" },
    { key: "time", label: "Time" },
    { key: "networkSummary", label: "Network" },
    { key: "population", label: "Population", wide: true },
    { key: "avgWait", label: "Avg Wait", wide: true },
  ];

  let { shell, paused, speed, onTogglePause, onSetSpeed }: Props = $props();
</script>

<section class="topbar" data-testid="topbar">
  <div class="brand">
    <span class="brand-mark" aria-hidden="true"></span>
    <span class="brand-name">CAELUM</span>
    <span class="brand-tag">Transit Ops</span>
  </div>

  <div class="readouts">
    {#each readouts as readout (readout.key)}
      <div class:topbar-readout--wide={readout.wide === true} class="readout">
        <span class="readout-label">{readout.label}</span>
        <span class="readout-value">{shell[readout.key]}</span>
      </div>
    {/each}
  </div>

  <div class="controls">
    <button
      type="button"
      class="ctrl-pause"
      data-action="pause"
      aria-pressed={paused}
      onclick={onTogglePause}
    >
      <span data-button-label>{paused ? "Resume" : "Pause"}</span>
    </button>

    <div
      class:speed-group--paused={paused}
      class="speed-group"
      role="group"
      aria-label="Simulation speed"
    >
      {#each [1, 2, 4] as speedOption (speedOption)}
        <button
          type="button"
          data-speed={speedOption}
          aria-pressed={speed === speedOption}
          class:active={speed === speedOption}
          onclick={() => onSetSpeed(speedOption as 1 | 2 | 4)}
        >
          {speedOption}x
        </button>
      {/each}
    </div>
  </div>
</section>

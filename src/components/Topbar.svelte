<script lang="ts">
  import type { GameState } from "../domain/types";
  import type { ShellTopbarState } from "../runtime/types";

  interface Props {
    shell: ShellTopbarState;
    paused: boolean;
    speed: GameState["speed"];
    controlTowerOpen: boolean;
    onToggleControlTower: () => void;
    onTogglePause: () => void;
    onSetSpeed: (speed: 1 | 2 | 4) => void;
  }

  const readouts: Array<{ key: keyof ShellTopbarState; label: string; modifier?: string }> = [
    { key: "budget", label: "Budget" },
    { key: "time", label: "Clock" },
    { key: "population", label: "Population" },
    { key: "late", label: "Late", modifier: "readout--warn" },
    { key: "unserved", label: "Unserved", modifier: "readout--alert" },
    { key: "avgWait", label: "Avg Wait" }
  ];

  let { shell, paused, speed, controlTowerOpen, onToggleControlTower, onTogglePause, onSetSpeed }: Props = $props();
</script>

<section class="topbar" data-testid="topbar">
  <div class="brand">
    <span class="brand-mark" aria-hidden="true"></span>
    <span class="brand-name">CAELUM</span>
    <span class="brand-tag">Transit Ops</span>
  </div>

  <div class:signal--paused={paused} class="signal" aria-live="polite">
    <span class="signal-dot" aria-hidden="true"></span>
    <span class="signal-label">{shell.signalState}</span>
  </div>

  <div class="readouts">
    {#each readouts as readout}
      <div class:readout--warn={readout.modifier === "readout--warn"} class:readout--alert={readout.modifier === "readout--alert"} class="readout">
        <span class="readout-label">{readout.label}</span>
        <span class="readout-value">{shell[readout.key]}</span>
      </div>
    {/each}
  </div>

  <div class="controls">
    <button
      type="button"
      class="ctrl-tower"
      data-action="toggle-tower"
      aria-pressed={controlTowerOpen}
      onclick={onToggleControlTower}
    >
      <span data-button-label>Control Tower</span>
    </button>

    <button
      type="button"
      class="ctrl-pause"
      data-action="pause"
      aria-pressed={paused}
      onclick={onTogglePause}
    >
      <span data-button-label>{paused ? "Resume" : "Pause"}</span>
    </button>

    <div class="speed-group" role="group" aria-label="Simulation speed">
      {#each [1, 2, 4] as speedOption}
        <button
          type="button"
          data-speed={speedOption}
          aria-pressed={speed === speedOption}
          class:active={speed === speedOption && !paused}
          onclick={() => onSetSpeed(speedOption as 1 | 2 | 4)}
        >
          {speedOption}x
        </button>
      {/each}
    </div>
  </div>
</section>

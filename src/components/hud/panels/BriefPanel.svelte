<script lang="ts">
  import type { ShellBriefState } from "../../../runtime/types";

  interface Props {
    shell: ShellBriefState;
  }

  let { shell }: Props = $props();
</script>

<div class="hud-panel" data-testid="panel-brief">
  <section class="panel-section details">
    <h3 class="section-head"><span class="num">05</span> Brief</h3>
    <h2>{shell.title}</h2>
    <p class="brief-id">Scenario · 001</p>

    <div class="dispatch-row">
      <span class="dispatch-key">Status</span>
      <span class="dispatch-val dispatch-val--mono">{shell.status}</span>
    </div>
    <div class="dispatch-row">
      <span class="dispatch-key">Goal</span>
      <span class="dispatch-val">{shell.objective}</span>
    </div>
    <div class="dispatch-row">
      <span class="dispatch-key">Note</span>
      <span class="dispatch-val dispatch-val--mono">{shell.lossNote}</span>
    </div>
    <div class="dispatch-row">
      <span class="dispatch-key">Wave</span>
      <span class="dispatch-val">{shell.nextGrowth}</span>
    </div>

    <div class="dispatch-divider" aria-hidden="true"></div>

    <div class="dispatch-row">
      <span class="dispatch-key">Tool</span>
      <span class="dispatch-val dispatch-val--ok">{shell.activeTool}</span>
    </div>
    <div class="dispatch-row">
      <span class="dispatch-key">Target</span>
      <span class="dispatch-val dispatch-val--mono">{shell.selectedId}</span>
    </div>
  </section>
</div>

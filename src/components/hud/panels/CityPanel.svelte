<script lang="ts">
  import type { ShellCityState } from "../../../runtime/types";

  interface Props {
    shell: ShellCityState;
    cityName: string | null;
  }

  let { shell, cityName }: Props = $props();
</script>

<div class="hud-panel" data-testid="panel-city">
  <section class="panel-section city-section">
    <h3 class="section-head"><span class="num">04</span> City</h3>
    <h2>{cityName ?? shell.title}</h2>
    {#if cityName !== null}
      <p class="brief-id">{shell.title}</p>
    {/if}

    <dl class="city-overview">
      <div class="dispatch-row">
        <dt class="dispatch-key">Template</dt>
        <dd class="dispatch-val">{shell.template}</dd>
      </div>
      <div class="dispatch-row">
        <dt class="dispatch-key">Simulation</dt>
        <dd class="dispatch-val dispatch-val--mono">{shell.simulation}</dd>
      </div>
      <div class="dispatch-row">
        <dt class="dispatch-key">Population</dt>
        <dd class="dispatch-val dispatch-val--mono">{shell.population}</dd>
      </div>
      <div class="dispatch-row">
        <dt class="dispatch-key">Lines</dt>
        <dd class="dispatch-val dispatch-val--mono">{shell.lineCount}</dd>
      </div>
      <div class="dispatch-row">
        <dt class="dispatch-key">Network</dt>
        <dd class="dispatch-val dispatch-val--mono">{shell.networkSummary}</dd>
      </div>
    </dl>
  </section>
</div>

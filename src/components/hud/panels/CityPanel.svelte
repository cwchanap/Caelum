<script lang="ts">
  import type { CitySummary } from "../../../persistence/citySaveStore";
  import type { ShellCityState } from "../../../runtime/types";
  import CityList from "../../city/CityList.svelte";

  interface Props {
    shell: ShellCityState;
    activeCity: CitySummary;
    cities: CitySummary[] | null;
    busy: boolean;
    dirty: boolean;
    error: string | null;
    onSave: () => void;
    onLoad: (cityId: string) => void;
    onRename: (cityId: string, name: string) => void;
    onDelete: (cityId: string) => void;
    onNewCity: () => void;
    onRetryList?: () => void;
  }

  let {
    shell,
    activeCity,
    cities,
    busy,
    dirty,
    error,
    onSave,
    onLoad,
    onRename,
    onDelete,
    onNewCity,
    onRetryList,
  }: Props = $props();
</script>

<div class="hud-panel" data-testid="panel-city">
  <section class="panel-section city-section">
    <h3 class="section-head"><span class="num">04</span> City</h3>
    <h2 data-testid="active-city-name">{activeCity.name}</h2>
    <p class="brief-id">{shell.title}</p>

    <div
      class="city-save-status"
      data-testid="city-save-status"
      data-dirty={dirty}
    >
      {dirty ? "Unsaved changes" : "Saved"}
    </div>

    <div class="city-actions">
      <button type="button" disabled={busy} onclick={onSave}>
        {busy ? "Working…" : "Save Now"}
      </button>
      <button type="button" disabled={busy} onclick={onNewCity}>New City</button
      >
    </div>

    {#if error !== null}
      <p class="city-action-error" role="alert">{error}</p>
    {/if}
    {#if onRetryList !== undefined}
      <button type="button" disabled={busy} onclick={onRetryList}>
        Retry city list
      </button>
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

    {#if cities !== null}
      <section class="city-local-list" aria-label="Local cities">
        <CityList
          {cities}
          activeCityId={activeCity.id}
          {busy}
          {onLoad}
          {onRename}
          {onDelete}
        />
      </section>
    {/if}
  </section>
</div>

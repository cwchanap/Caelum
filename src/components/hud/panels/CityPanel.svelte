<script lang="ts">
  import type { CitySummary } from "../../../persistence/citySaveStore";
  import type { ShellCityState } from "../../../runtime/types";
  import CityList from "../../city/CityList.svelte";
  import InlineNameEditor from "../../city/InlineNameEditor.svelte";

  interface Props {
    shell: ShellCityState;
    activeCity: CitySummary;
    cities: CitySummary[] | null;
    busy: boolean;
    dirty: boolean;
    statusLabel: string;
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
    statusLabel,
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
    <h3 class="section-head">City</h3>
    <h2 class="city-title">
      <InlineNameEditor
        value={activeCity.name}
        label={`Rename ${activeCity.name}`}
        disabled={busy}
        testId="active-city-name"
        entityId={activeCity.id}
        onCommit={(name) => onRename(activeCity.id, name)}
      />
    </h2>
    <p class="brief-id">{shell.title}</p>

    <div
      class="city-save-status"
      data-testid="city-save-status"
      data-dirty={dirty}
    >
      {statusLabel}
    </div>

    <div class="city-actions">
      <!-- mousedown.preventDefault keeps the press from blurring the name
           editor: a blur-commit would flip busy and eat the click itself. -->
      <button
        type="button"
        class="btn"
        disabled={busy}
        onmousedown={(event) => event.preventDefault()}
        onclick={onSave}
      >
        {busy ? "Working…" : "Save Now"}
      </button>
      <button
        type="button"
        class="btn"
        disabled={busy || dirty}
        onmousedown={(event) => event.preventDefault()}
        onclick={onNewCity}>New City</button
      >
    </div>

    {#if dirty}
      <p class="city-switch-hint" data-testid="city-switch-hint">
        Pause and Save before switching cities.
      </p>
    {/if}

    {#if error !== null}
      <p class="city-action-error" role="alert">{error}</p>
    {/if}
    {#if onRetryList !== undefined}
      <button
        type="button"
        class="btn"
        disabled={busy}
        onmousedown={(event) => event.preventDefault()}
        onclick={onRetryList}
      >
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
          {dirty}
          activeNameReadOnly
          {onLoad}
          {onRename}
          {onDelete}
        />
      </section>
    {/if}
  </section>
</div>

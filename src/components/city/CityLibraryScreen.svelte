<script lang="ts">
  import type { CitySummary } from "../../persistence/citySaveStore";
  import CityList from "./CityList.svelte";

  interface Props {
    cities: CitySummary[] | null;
    activeCityId: string | null;
    busy: boolean;
    error: string | null;
    onContinue: (cityId: string) => void;
    onLoad: (cityId: string) => void;
    onRename: (cityId: string, name: string) => void;
    onDelete: (cityId: string) => void;
    onNewCity: () => void;
    onRetry?: () => void;
  }

  let {
    cities,
    activeCityId,
    busy,
    error,
    onContinue,
    onLoad,
    onRename,
    onDelete,
    onNewCity,
    onRetry,
  }: Props = $props();
</script>

<main class="city-library-screen" data-testid="city-library-screen">
  <section class="city-library-card">
    <p class="new-city-kicker">CAELUM // LOCAL CITIES</p>
    <h1>City Library</h1>

    {#if error !== null}
      <p role="alert">{error}</p>
      <div class="city-library-actions">
        {#if onRetry !== undefined}
          <button type="button" disabled={busy} onclick={onRetry}>
            Retry city list
          </button>
        {/if}
        <button type="button" disabled={busy} onclick={onNewCity}>
          New City
        </button>
      </div>
    {:else if cities === null}
      <p>Loading cities…</p>
    {:else if cities.length > 0}
      <div class="city-library-actions">
        <button
          type="button"
          disabled={busy}
          onclick={() => onContinue(cities[0].id)}>Continue</button
        >
        <button type="button" disabled={busy} onclick={onNewCity}>
          New City
        </button>
      </div>
      <CityList {cities} {activeCityId} {busy} {onLoad} {onRename} {onDelete} />
    {/if}
  </section>
</main>

<script lang="ts">
  import keyArt from "../../assets/sunny-diorama/menu/city-library.webp";
  import appIcon from "../../assets/sunny-diorama/brand/app-icon.png";
  import type { CitySummary } from "../../persistence/citySaveStore";
  import CityList from "./CityList.svelte";

  interface Props {
    cities: CitySummary[] | null;
    activeCityId: string | null;
    busy: boolean;
    error: string | null;
    onContinue: (cityId: string) => void;
    onLoad: (cityId: string) => void;
    onRename: (cityId: string, name: string) => Promise<boolean>;
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

<main
  class="city-library-screen"
  data-testid="city-library-screen"
  style={`background-image: url(${keyArt})`}
>
  <section class="card city-library-card">
    <header class="city-library-brand">
      <img class="city-library-brand-icon" src={appIcon} alt="" />
      <div>
        <p class="city-library-wordmark">Caelum</p>
        <p class="city-library-tagline">Build a city. Run its transport.</p>
      </div>
    </header>
    <h1>City Library</h1>

    {#if error !== null && onRetry !== undefined}
      <p role="alert">{error}</p>
      <div class="city-library-actions">
        <button type="button" disabled={busy} onclick={onRetry}>
          Retry city list
        </button>
        <button type="button" disabled={busy} onclick={onNewCity}>
          New City
        </button>
      </div>
    {:else}
      {#if error !== null}
        <p role="alert">{error}</p>
      {/if}
      {#if cities === null}
        <p>Loading cities…</p>
      {:else if cities.length > 0}
        <div class="city-library-actions">
          <button
            type="button"
            class="btn city-library-continue"
            disabled={busy}
            onclick={() => onContinue(cities[0].id)}
          >
            Continue
            <span class="city-library-continue-name">{cities[0].name}</span>
          </button>
          <button type="button" disabled={busy} onclick={onNewCity}>
            New City
          </button>
        </div>
        <CityList
          {cities}
          {activeCityId}
          {busy}
          {onLoad}
          {onRename}
          {onDelete}
        />
      {/if}
    {/if}
  </section>
</main>

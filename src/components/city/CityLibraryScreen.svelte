<script lang="ts">
  import keyArt from "../../assets/sunny-diorama/menu/city-library.webp";
  import appIcon from "../../assets/sunny-diorama/brand/app-icon.png";
  import { SANDBOX_TEMPLATE_LABELS } from "../../domain/catalog/sandboxTemplates";
  import type { CitySummary } from "../../persistence/citySaveStore";
  import { MAP_SIZES, NEW_CITY_DEFAULTS } from "../../scenario/sandbox";
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

  let cityList: { flushCityNames: () => Promise<boolean> } | null =
    $state(null);

  const savedAtFormat = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const newCityHint = `${SANDBOX_TEMPLATE_LABELS[NEW_CITY_DEFAULTS.templateId]} · ${MAP_SIZES[NEW_CITY_DEFAULTS.mapSize].label}`;

  // Continue/New City use the same prevented-mousedown contract as a row's
  // Load: it keeps a blur-commit's busy flip from eating the click, so the
  // click itself must flush any row-name draft before the action replaces
  // the library.
  async function flushThen(action: () => void): Promise<void> {
    if ((await cityList?.flushCityNames()) !== false) action();
  }
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
        <div class="city-library-actions city-library-actions--column">
          <button
            type="button"
            class="btn city-library-continue"
            disabled={busy}
            onmousedown={(event) => event.preventDefault()}
            onclick={() => void flushThen(() => onContinue(cities[0].id))}
          >
            <svg
              class="city-library-action-icon"
              viewBox="0 0 16 16"
              aria-hidden="true"
            >
              <path d="M3.5 2.5v11l9-5.5z" />
            </svg>
            <span class="city-library-action-body">
              <span class="city-library-action-label">
                Continue
                <span class="city-library-continue-name">{cities[0].name}</span>
              </span>
              <span class="city-library-action-hint">
                Saved
                <time datetime={cities[0].savedAt}>
                  {savedAtFormat.format(new Date(cities[0].savedAt))}
                </time>
              </span>
            </span>
          </button>
          <button
            type="button"
            class="btn city-library-new"
            disabled={busy}
            onmousedown={(event) => event.preventDefault()}
            onclick={() => void flushThen(onNewCity)}
          >
            <svg
              class="city-library-action-icon"
              viewBox="0 0 16 16"
              aria-hidden="true"
            >
              <path
                d="M8 2v12M2 8h12"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              />
            </svg>
            <span class="city-library-action-body">
              <span class="city-library-action-label">New City</span>
              <span class="city-library-action-hint">{newCityHint}</span>
            </span>
          </button>
        </div>
        <h2 class="city-library-list-head">
          Your cities
          <span class="city-library-count">{cities.length}</span>
        </h2>
        <CityList
          bind:this={cityList}
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

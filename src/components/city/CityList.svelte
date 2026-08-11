<script lang="ts">
  import type { CitySummary } from "../../persistence/citySaveStore";

  interface Props {
    cities: CitySummary[];
    activeCityId: string | null;
    busy: boolean;
    onLoad: (cityId: string) => void;
    onRename: (cityId: string, name: string) => void;
    onDelete: (cityId: string) => void;
  }

  let { cities, activeCityId, busy, onLoad, onRename, onDelete }: Props =
    $props();
  let pendingDeleteId = $state<string | null>(null);
  let cityNameDrafts = $state<Record<string, string>>({});

  const savedAtFormat = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  function cityNameFor(cityId: string, canonical: string): string {
    return cityNameDrafts[cityId] ?? canonical;
  }

  function handleCityNameInput(
    cityId: string,
    event: Event & { currentTarget: HTMLInputElement },
  ): void {
    cityNameDrafts[cityId] = event.currentTarget.value;
  }

  function commitCityName(city: CitySummary, input: HTMLInputElement): void {
    if (!(city.id in cityNameDrafts)) return;
    const trimmed = input.value.trim();
    delete cityNameDrafts[city.id];
    if (trimmed.length === 0) {
      input.value = city.name;
      return;
    }
    input.value = trimmed;
    if (trimmed !== city.name) onRename(city.id, trimmed);
  }

  function cancelCityName(
    city: CitySummary,
    event: KeyboardEvent & { currentTarget: HTMLInputElement },
  ): void {
    delete cityNameDrafts[city.id];
    event.currentTarget.value = city.name;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.blur();
  }

  function handleDeleteClick(cityId: string): void {
    if (busy) return;
    if (pendingDeleteId === cityId) {
      pendingDeleteId = null;
      onDelete(cityId);
    } else {
      pendingDeleteId = cityId;
    }
  }
</script>

<div class="city-list" data-testid="city-list">
  {#each cities as city (city.id)}
    <article class="city-list-row" data-testid={`city-row-${city.id}`}>
      <div class="city-list-meta">
        <input
          type="text"
          class="city-name"
          data-testid={`city-name-${city.id}`}
          value={cityNameFor(city.id, city.name)}
          aria-label={`Rename ${city.name}`}
          disabled={busy}
          autocomplete="off"
          oninput={(event) =>
            handleCityNameInput(
              city.id,
              event as Event & { currentTarget: HTMLInputElement },
            )}
          onblur={(event) => commitCityName(city, event.currentTarget)}
          onkeydown={(event) => {
            if (event.key === "Escape") {
              cancelCityName(
                city,
                event as KeyboardEvent & {
                  currentTarget: HTMLInputElement;
                },
              );
            } else if (event.key === "Enter") {
              commitCityName(city, event.currentTarget);
              event.currentTarget.blur();
            }
          }}
        />
        <span>
          Saved
          <time datetime={city.savedAt}>
            {savedAtFormat.format(new Date(city.savedAt))}
          </time>
        </span>
      </div>

      <div class="city-list-actions">
        {#if city.id === activeCityId}
          <span class="city-list-active">Active</span>
        {:else}
          <button
            type="button"
            aria-label={`Load ${city.name}`}
            disabled={busy}
            onclick={() => {
              pendingDeleteId = null;
              onLoad(city.id);
            }}>Load</button
          >
        {/if}
        <button
          type="button"
          class:city-delete--armed={pendingDeleteId === city.id}
          data-testid={`city-delete-${city.id}`}
          disabled={busy}
          onclick={() => handleDeleteClick(city.id)}
        >
          {pendingDeleteId === city.id ? "Delete?" : "Delete"}
        </button>
      </div>
    </article>
  {/each}
</div>

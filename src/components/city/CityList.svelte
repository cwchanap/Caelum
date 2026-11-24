<script lang="ts">
  import type { CitySummary } from "../../persistence/citySaveStore";

  interface Props {
    cities: CitySummary[];
    activeCityId: string | null;
    busy: boolean;
    dirty?: boolean;
    /** Dock-only: the active row's name is read-only there; the City
     *  header owns active-city rename. Delete stays available. */
    activeNameReadOnly?: boolean;
    onLoad: (cityId: string) => void;
    onRename: (cityId: string, name: string) => Promise<boolean>;
    onDelete: (cityId: string) => void;
  }

  let {
    cities,
    activeCityId,
    busy,
    dirty = false,
    activeNameReadOnly = false,
    onLoad,
    onRename,
    onDelete,
  }: Props = $props();
  let pendingDeleteId = $state<string | null>(null);
  let cityNameDrafts = $state<Record<string, string>>({});

  const savedAtFormat = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  // Sunny Diorama material hues; the initial must stay legible on all of them.
  const AVATAR_COLORS = ["#ab5a45", "#3c6b35", "#a86f0e", "#5d6d72"];

  function avatarColor(cityId: string): string {
    let hash = 5381;
    for (let index = 0; index < cityId.length; index += 1) {
      hash = ((hash << 5) + hash + cityId.charCodeAt(index)) | 0;
    }
    return AVATAR_COLORS[(hash >>> 0) % AVATAR_COLORS.length];
  }

  function cityNameFor(cityId: string, canonical: string): string {
    return cityNameDrafts[cityId] ?? canonical;
  }

  function handleCityNameInput(
    cityId: string,
    event: Event & { currentTarget: HTMLInputElement },
  ): void {
    cityNameDrafts[cityId] = event.currentTarget.value;
  }

  // A refused or failed rename re-arms the draft (unless a newer edit has
  // replaced it) so the typed name is never silently discarded.
  function renameKeepingDraft(cityId: string, name: string): Promise<boolean> {
    return onRename(cityId, name).then((ok) => {
      if (!ok && !(cityId in cityNameDrafts)) cityNameDrafts[cityId] = name;
      return ok;
    });
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
    if (trimmed !== city.name) void renameKeepingDraft(city.id, trimmed);
  }

  // mousedown.preventDefault on a row's Load keeps the press from
  // blur-committing an open name editor, so the click must commit any
  // pending drafts itself before the load replaces the library. Renames go
  // one at a time through the persistence gate; a refusal keeps the draft
  // and blocks the load rather than discarding the typed name. Exported for
  // sibling actions outside the list (library Continue/New City, dock New
  // City) whose prevented mousedown suppresses the same blur commit.
  export async function flushCityNames(): Promise<boolean> {
    for (const city of cities) {
      const draft = cityNameDrafts[city.id];
      if (draft === undefined) continue;
      const trimmed = draft.trim();
      delete cityNameDrafts[city.id];
      if (trimmed.length === 0 || trimmed === city.name) continue;
      if (!(await renameKeepingDraft(city.id, trimmed))) return false;
    }
    return true;
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

  // The armed second click is also a prevented-mousedown press: deleting the
  // active city swaps the library out from under every open editor, so the
  // drafts flush first, same as Load.
  async function handleDeleteClick(cityId: string): Promise<void> {
    if (busy) return;
    if (pendingDeleteId === cityId) {
      pendingDeleteId = null;
      if (await flushCityNames()) onDelete(cityId);
    } else {
      pendingDeleteId = cityId;
    }
  }
</script>

<div class="city-list" data-testid="city-list">
  {#each cities as city (city.id)}
    <article class="city-list-row" data-testid={`city-row-${city.id}`}>
      <div class="city-list-meta">
        <span
          class="city-avatar"
          data-testid="city-avatar"
          style={`background-color: ${avatarColor(city.id)}`}
          aria-hidden="true">{Array.from(city.name.trim())[0] ?? ""}</span
        >
        {#if activeNameReadOnly && city.id === activeCityId}
          <span
            class="city-name city-name--readonly"
            data-testid={`city-name-${city.id}`}>{city.name}</span
          >
        {:else}
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
        {/if}
        <span>
          Saved
          <time datetime={city.savedAt}>
            {savedAtFormat.format(new Date(city.savedAt))}
          </time>
        </span>
      </div>

      <div class="city-list-actions">
        {#if city.id === activeCityId}
          <span class="city-list-active">
            {activeNameReadOnly ? "Playing" : "Active"}
          </span>
        {:else}
          <button
            type="button"
            class="btn"
            aria-label={`Load ${city.name}`}
            disabled={busy || dirty}
            onmousedown={(event) => event.preventDefault()}
            onclick={async () => {
              pendingDeleteId = null;
              if (await flushCityNames()) onLoad(city.id);
            }}>Load</button
          >
        {/if}
        <button
          type="button"
          class="btn"
          class:city-delete--armed={pendingDeleteId === city.id}
          data-testid={`city-delete-${city.id}`}
          disabled={busy}
          onmousedown={(event) => event.preventDefault()}
          onclick={() => void handleDeleteClick(city.id)}
        >
          {pendingDeleteId === city.id ? "Delete?" : "Delete"}
        </button>
      </div>
    </article>
  {/each}
</div>

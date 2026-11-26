<script lang="ts">
  import type { CitySummary } from "../../persistence/citySaveStore";
  import { SANDBOX_TEMPLATE_LABELS } from "../../domain/catalog/sandboxTemplates";
  import InlineNameEditor from "./InlineNameEditor.svelte";

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
  // One InlineNameEditor ref per mounted editable row, keyed by city id; the
  // keyed each sets the slot to null when a row unmounts.
  let nameEditors = $state<
    Record<string, { commit: () => Promise<boolean> } | null>
  >({});

  const savedAtFormat = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  // Several cities can share a name (repeated "Riverside" saves); the row
  // controls then append the saved timestamp to their accessible name so
  // Rename/Load/Delete stay distinguishable per city. Two saves can also
  // land inside the same formatted minute, so a per-row ordinal backs up
  // the timestamp when the formatted contexts still collide.
  const contexts = $derived.by(() => {
    // Accessible-name computation collapses whitespace runs and trims, so
    // "North  Point" and "North Point" announce identically. Duplicate
    // detection and generated-name collision checks run on the normalized
    // form; the saved name itself is never changed.
    const accessible = (name: string) => name.replace(/\s+/g, " ").trim();
    // A city may literally be named like a generated label
    // ("Riverside saved <time> (1)"), so suffixes are chosen against every
    // reserved literal name and every label already assigned, not just the
    // colliding base.
    const literalNames = new Set(cities.map((city) => accessible(city.name)));
    const bases = cities.map((city) =>
      cities.some(
        (other) =>
          other !== city && accessible(other.name) === accessible(city.name),
      )
        ? `${accessible(city.name)} saved ` +
          savedAtFormat.format(new Date(city.savedAt))
        : accessible(city.name),
    );
    const assigned: string[] = [];
    return bases.map((base, index) => {
      if (bases.filter((other) => other === base).length <= 1) {
        assigned.push(base);
        return base;
      }
      let ordinal =
        bases.slice(0, index).filter((other) => other === base).length + 1;
      let candidate = `${base} (${ordinal})`;
      while (literalNames.has(candidate) || assigned.includes(candidate)) {
        ordinal += 1;
        candidate = `${base} (${ordinal})`;
      }
      assigned.push(candidate);
      return candidate;
    });
  });

  function controlContext(index: number): string {
    return contexts[index] ?? "";
  }

  // Sunny Diorama material hues; the initial must stay legible on all of them.
  const AVATAR_COLORS = ["#ab5a45", "#3c6b35", "#a86f0e", "#5d6d72"];

  function avatarColor(cityId: string): string {
    let hash = 5381;
    for (let index = 0; index < cityId.length; index += 1) {
      hash = ((hash << 5) + hash + cityId.charCodeAt(index)) | 0;
    }
    return AVATAR_COLORS[(hash >>> 0) % AVATAR_COLORS.length];
  }

  // mousedown.preventDefault on a row's Load keeps the press from
  // blur-committing an open name editor, so the click must commit any
  // pending drafts itself before the load replaces the library. Renames go
  // one at a time through the persistence gate; a refusal re-opens the
  // editor with its draft and blocks the load rather than discarding the
  // typed name. Exported for sibling actions outside the list (library
  // Continue/New City, dock Save/New City) whose prevented mousedown
  // suppresses the same blur commit.
  export async function flushCityNames(): Promise<boolean> {
    for (const city of cities) {
      const editor = nameEditors[city.id];
      if (editor == null) continue;
      if (!(await editor.commit())) return false;
    }
    return true;
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
  {#each cities as city, index (city.id)}
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
            dir="auto"
            data-testid={`city-name-${city.id}`}>{city.name}</span
          >
        {:else}
          <span class="city-name-field">
            <InlineNameEditor
              bind:this={nameEditors[city.id]}
              value={city.name}
              label={`Rename ${controlContext(index)}`}
              disabled={busy}
              testId={`city-name-${city.id}`}
              entityId={city.id}
              onCommit={(name) => onRename(city.id, name)}
            />
          </span>
        {/if}
        <span class="city-template">
          {SANDBOX_TEMPLATE_LABELS[city.templateId]}
        </span>
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
            aria-label={`Load ${controlContext(index)}`}
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
          aria-label={pendingDeleteId === city.id
            ? `Confirm delete ${controlContext(index)}`
            : `Delete ${controlContext(index)}`}
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

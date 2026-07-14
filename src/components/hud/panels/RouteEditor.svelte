<script lang="ts">
  import type {
    RouteDraft,
    RouteEditorView,
    ServicePattern,
  } from "../../../runtime/types";

  let {
    editor,
    onSelectWaypoint,
    onRemove,
    onMove,
    onReverse,
    onPattern,
    onSave,
    onCancel,
    onReload,
  }: {
    editor: RouteEditorView;
    onSelectWaypoint: (
      index: number | null,
      interaction: RouteDraft["interaction"],
    ) => void;
    onRemove: () => void;
    onMove: (delta: -1 | 1) => void;
    onReverse: () => void;
    onPattern: (pattern: ServicePattern) => void;
    onSave: () => void;
    onCancel: () => void;
    onReload: () => void;
  } = $props();

  const hasSelection = $derived(editor.selectedIndex !== null);
  const canMoveUp = $derived(
    editor.selectedIndex !== null && editor.selectedIndex > 0,
  );
  const canMoveDown = $derived(
    editor.selectedIndex !== null &&
      editor.selectedIndex < editor.waypoints.length - 1,
  );
</script>

<div class="route-editor" data-testid="route-draft">
  <header class="route-editor-head">
    <h4>{editor.title}</h4>
    {#if editor.source === "edit"}
      <p>Saved service stays live until Save.</p>
    {/if}
  </header>

  <fieldset class="route-pattern">
    <legend>Service pattern</legend>
    <label>
      <input
        type="radio"
        name="route-pattern"
        value="loop"
        checked={editor.pattern === "loop"}
        onchange={() => onPattern("loop")}
      />
      Loop
    </label>
    <label>
      <input
        type="radio"
        name="route-pattern"
        value="shuttle"
        checked={editor.pattern === "shuttle"}
        onchange={() => onPattern("shuttle")}
      />
      Shuttle
    </label>
  </fieldset>

  {#if editor.waypoints.length === 0}
    <p class="route-editor-empty">Select stops or stations on the map.</p>
  {:else}
    <ol class="route-waypoints">
      {#each editor.waypoints as waypoint (waypoint.index)}
        <li>
          <button
            type="button"
            class:active={waypoint.selected}
            class:missing={waypoint.status === "missing"}
            data-testid={`route-waypoint-${waypoint.index}`}
            aria-pressed={waypoint.selected}
            onclick={() => onSelectWaypoint(waypoint.index, editor.interaction)}
          >
            <span class="route-waypoint-number">{waypoint.index + 1}</span>
            <span>{waypoint.label}</span>
          </button>
        </li>
      {/each}
    </ol>
  {/if}

  <div class="route-edit-modes" role="group" aria-label="Map click action">
    <button
      type="button"
      class:active={editor.interaction === "append"}
      aria-pressed={editor.interaction === "append"}
      onclick={() => onSelectWaypoint(null, "append")}>Append</button
    >
    <button
      type="button"
      class:active={editor.interaction === "replace"}
      aria-pressed={editor.interaction === "replace"}
      disabled={!hasSelection}
      onclick={() => onSelectWaypoint(editor.selectedIndex, "replace")}
      >Replace</button
    >
    <button
      type="button"
      class:active={editor.interaction === "insertAfter"}
      aria-pressed={editor.interaction === "insertAfter"}
      disabled={!hasSelection}
      onclick={() => onSelectWaypoint(editor.selectedIndex, "insertAfter")}
      >Insert after</button
    >
  </div>

  <div class="route-waypoint-actions">
    <button type="button" disabled={!canMoveUp} onclick={() => onMove(-1)}
      >Move up</button
    >
    <button type="button" disabled={!canMoveDown} onclick={() => onMove(1)}
      >Move down</button
    >
    <button
      type="button"
      disabled={editor.waypoints.length < 2}
      onclick={onReverse}>Reverse</button
    >
    <button type="button" disabled={!hasSelection} onclick={onRemove}
      >Remove</button
    >
  </div>

  <p
    class={`route-preview route-preview--${editor.previewStatus}`}
    data-testid="route-preview-status"
    aria-live="polite"
  >
    {editor.previewMessage ?? editor.previewStatus}
  </p>

  <div class="route-editor-actions">
    <button
      type="button"
      class="route-save"
      disabled={editor.previewPending || !editor.canSave}
      onclick={onSave}
      >{editor.previewPending ? "Checking route…" : "Save route"}</button
    >
    <button type="button" class="route-cancel" onclick={onCancel}>Cancel</button
    >
    {#if editor.canReload}
      <button type="button" class="route-reload" onclick={onReload}
        >Reload saved route</button
      >
    {/if}
  </div>
</div>

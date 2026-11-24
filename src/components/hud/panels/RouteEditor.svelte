<script lang="ts">
  import { formatMinutes } from "../../../format";
  import { formatBudget } from "../../../runtime/runtimeSelectors";
  import type {
    RouteDraft,
    RouteEditorView,
    ServicePattern,
    TransitMode,
  } from "../../../runtime/types";

  let {
    editor,
    color = null,
    onSelectWaypoint,
    onRemove,
    onUndo,
    onRedo,
    onMove,
    onReverse,
    onPattern,
    onSave,
    onCancel,
    onReload,
  }: {
    editor: RouteEditorView;
    /** Saved route colour while editing; `null` for an unsaved new draft. */
    color?: string | null;
    onSelectWaypoint: (
      index: number | null,
      interaction: RouteDraft["interaction"],
    ) => void;
    onRemove: () => void;
    onUndo: () => void;
    onRedo: () => void;
    onMove: (delta: -1 | 1) => void;
    onReverse: () => void;
    onPattern: (pattern: ServicePattern) => void;
    onSave: () => void;
    onCancel: () => void;
    onReload: () => void;
  } = $props();

  const hasSelection = $derived(editor.selectedIndex !== null);

  // Matches the Lines card's fleet wording: mode-aware singular/plural.
  const fleetNoun = (mode: TransitMode, count: number): string => {
    if (mode === "metro") return count === 1 ? "train" : "trains";
    return count === 1 ? "bus" : "buses";
  };

  // Row actions select their row first, then reuse the runtime's synchronous
  // selected-waypoint move/remove; selection-only changes do not restart the
  // preview.
  const rowMove = (index: number, delta: -1 | 1): void => {
    onSelectWaypoint(index, editor.interaction);
    onMove(delta);
  };
  const rowRemove = (index: number): void => {
    onSelectWaypoint(index, editor.interaction);
    onRemove();
  };
</script>

<div class="route-editor" data-testid="route-draft">
  <header class="route-editor-head">
    <h4>{editor.title}</h4>
    {#if editor.source === "edit"}
      <p>Saved service stays live until Save.</p>
    {/if}
  </header>

  <fieldset class="route-pattern route-pattern--segmented">
    <legend>Service pattern</legend>
    <label class:checked={editor.pattern === "loop"}>
      <input
        type="radio"
        name="route-pattern"
        value="loop"
        checked={editor.pattern === "loop"}
        onchange={() => onPattern("loop")}
      />
      Loop
    </label>
    <label class:checked={editor.pattern === "shuttle"}>
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
    <ol class="route-waypoints" style:--route-color={color}>
      {#each editor.waypoints as waypoint (waypoint.index)}
        <li class:active={waypoint.selected}>
          <button
            type="button"
            class="route-waypoint-row"
            class:active={waypoint.selected}
            class:missing={waypoint.status === "missing"}
            data-testid={`route-waypoint-${waypoint.index}`}
            aria-pressed={waypoint.selected}
            onclick={() => onSelectWaypoint(waypoint.index, editor.interaction)}
          >
            <span class="route-waypoint-number">{waypoint.index + 1}</span>
            <span>{waypoint.label}</span>
          </button>
          <span class="route-waypoint-actions">
            <button
              type="button"
              aria-label={`Move up ${waypoint.label}`}
              data-testid={`route-waypoint-move-up-${waypoint.index}`}
              disabled={waypoint.index === 0}
              onclick={() => rowMove(waypoint.index, -1)}>↑</button
            >
            <button
              type="button"
              aria-label={`Move down ${waypoint.label}`}
              data-testid={`route-waypoint-move-down-${waypoint.index}`}
              disabled={waypoint.index === editor.waypoints.length - 1}
              onclick={() => rowMove(waypoint.index, 1)}>↓</button
            >
            <button
              type="button"
              aria-label={`Remove ${waypoint.label}`}
              data-testid={`route-waypoint-remove-${waypoint.index}`}
              onclick={() => rowRemove(waypoint.index)}>✕</button
            >
          </span>
        </li>
      {/each}
    </ol>
  {/if}

  <div
    class="route-draft-toolbar"
    role="group"
    aria-label="Route drafting tools"
  >
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
    <button
      type="button"
      disabled={editor.waypoints.length < 2}
      onclick={onReverse}>Reverse</button
    >
    <button type="button" disabled={!editor.canUndo} onclick={onUndo}
      >Undo</button
    >
    <button type="button" disabled={!editor.canRedo} onclick={onRedo}
      >Redo</button
    >
  </div>

  <p
    class={`route-preview route-preview--${editor.previewStatus}`}
    data-testid="route-preview-status"
    aria-live="polite"
  >
    {editor.previewMessage ?? editor.previewStatus}
  </p>

  {#if editor.failures.length > 0}
    <ul
      class="route-failures route-preview-failures"
      data-testid="route-preview-failures"
    >
      {#each editor.failures as failure (failure.legIndex)}
        <li class="route-failure">
          <span class="route-failure-detail">
            {failure.fromLabel} → {failure.toLabel}
          </span>
          <span class="route-repair-guidance">{failure.guidance}</span>
        </li>
      {/each}
    </ul>
  {/if}

  {#if editor.notice?.kind === "alreadyOnRoute"}
    <p
      class="route-preview route-draft-notice"
      data-testid="route-draft-notice"
      aria-live="polite"
    >
      Already on this route.
    </p>
  {/if}

  {#if editor.previewWarnings.length > 0}
    <ul class="route-preview-warnings" data-testid="route-preview-warnings">
      {#each editor.previewWarnings as warning (warning)}
        <li>{warning}</li>
      {/each}
    </ul>
  {/if}

  {#if editor.source === "create" && editor.initialFleet !== null}
    <h4 class="route-after-save-heading">After saving</h4>
    <dl class="route-after-save" data-testid="route-after-save">
      <div class="route-after-save-row">
        <dt>Fleet</dt>
        <dd data-testid="route-after-save-fleet">
          {editor.initialFleet.shortfall
            ? "None yet"
            : `${editor.initialFleet.vehicles} ${fleetNoun(
                editor.mode,
                editor.initialFleet.vehicles,
              )}`}
        </dd>
      </div>
      <div class="route-after-save-row">
        <dt>Target</dt>
        <dd data-testid="route-after-save-target">
          Every {formatMinutes(editor.initialFleet.targetHeadwaySeconds)}
        </dd>
      </div>
      <div class="route-after-save-row">
        <dt>Running cost</dt>
        <dd data-testid="route-after-save-running">
          {editor.initialFleet.shortfall
            ? "$0/day"
            : `${formatBudget(editor.initialFleet.estimatedDailyOperatingCost)}/day`}
        </dd>
      </div>
    </dl>
    <p
      class="route-after-save-qualifier"
      data-testid="route-after-save-qualifier"
    >
      Estimate from the current quote — actual fleet and cost depend on your
      budget when you save and show on the line's card.
    </p>
    {#if editor.initialFleet.shortfall}
      <p class="route-shortfall" data-testid="route-shortfall-reason">
        {editor.initialFleet.shortfallReason}
        Save the line now, replenish your budget, then deploy its fleet from the Lines
        panel.
      </p>
    {/if}
  {/if}

  <div class="route-editor-actions">
    <button
      type="button"
      class="route-save"
      class:route-save--deferred={editor.source === "create" &&
        editor.initialFleet?.shortfall}
      disabled={editor.previewPending || !editor.canSave}
      onclick={onSave}
      >{editor.previewPending
        ? "Checking route…"
        : editor.source === "edit"
          ? "Save route"
          : editor.initialFleet !== null && editor.initialFleet.shortfall
            ? "Save without fleet"
            : editor.initialFleet !== null
              ? `Save & run · ${formatBudget(editor.initialFleet.cost)}`
              : "Save & run"}</button
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

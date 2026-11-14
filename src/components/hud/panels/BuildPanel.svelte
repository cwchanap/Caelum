<script module lang="ts">
  import {
    BUILD_GROUPS,
    type BuildGroup,
  } from "../../../domain/catalog/buildGroups";
  import roadsPlate from "../../../assets/sunny-diorama/build-categories/roads.webp";
  import transitPlate from "../../../assets/sunny-diorama/build-categories/transit.webp";
  import zonesPlate from "../../../assets/sunny-diorama/build-categories/zones.webp";
  import buildingsPlate from "../../../assets/sunny-diorama/build-categories/buildings.webp";

  const plates = (
    [
      { id: "roads", label: "Roads", image: roadsPlate },
      { id: "transit", label: "Transit", image: transitPlate },
      { id: "zones", label: "Zones", image: zonesPlate },
      { id: "buildings", label: "Buildings", image: buildingsPlate },
    ] satisfies Array<{ id: BuildGroup; label: string; image: string }>
  ).filter((plate) => BUILD_GROUPS.some((group) => group.id === plate.id));

  const itemThumbnails: Record<string, string> = Object.fromEntries(
    Object.entries(
      import.meta.glob<string>(
        "../../../assets/sunny-diorama/build-items/*.webp",
        { eager: true, import: "default" },
      ),
    ).map(([path, image]) => [
      path.slice(path.lastIndexOf("/") + 1, -".webp".length),
      image,
    ]),
  );
</script>

<script lang="ts">
  import { tick } from "svelte";
  import {
    ROUNDABOUT_DIMENSIONS,
    type AreaKind,
    type BuildingRotation,
    type BuildingType,
    type RoadPreset,
    type RoundaboutSize,
    type Tool,
  } from "../../../domain/types";
  import {
    buildGroupItems,
    findBuildGroup,
    type BuildItemAction,
    type BuildItemCost,
    type BuildMenuItem,
  } from "../../../domain/catalog/buildGroups";
  import {
    BUILDING_CATALOG,
    getRotatedFootprintSize,
  } from "../../../domain/catalog/buildings";
  import { formatBudget } from "../../../runtime/runtimeSelectors";
  import CommandPlateGrid from "../CommandPlateGrid.svelte";
  import {
    ROTATE_KEY,
    TRACK_KEY,
    buildGroupShortcuts,
  } from "../../../ui/shortcuts";

  interface Props {
    activeBuildGroup: BuildGroup | null;
    activeTool: Tool;
    selectedArea: AreaKind | null;
    selectedBuilding: BuildingType | null;
    roadPreset: RoadPreset;
    roundaboutSize: RoundaboutSize;
    buildingRotation: BuildingRotation;
    onSetBuildGroup: (group: BuildGroup | null) => void;
    onSelectItem: (action: BuildItemAction) => void;
    onRotateBuilding: () => void;
  }

  let {
    activeBuildGroup,
    activeTool,
    selectedArea,
    selectedBuilding,
    roadPreset,
    roundaboutSize,
    buildingRotation,
    onSetBuildGroup,
    onSelectItem,
    onRotateBuilding,
  }: Props = $props();

  let plateGrid: {
    focusPlate: (group: BuildGroup) => void;
  } | null = $state(null);
  let backButton: HTMLButtonElement | null = $state(null);
  let previousGroup: BuildGroup | null = null;

  // Preserve keyboard focus through the category drilldown: Back on entry and
  // the activated category plate on return.
  $effect(() => {
    const group = activeBuildGroup;
    if (group === previousGroup) return;
    const restored = previousGroup;
    previousGroup = group;
    if (group !== null) {
      void tick().then(() => backButton?.focus());
    } else if (restored !== null) {
      void tick().then(() => plateGrid?.focusPlate(restored));
    }
  });

  const activeGroup = $derived(findBuildGroup(activeBuildGroup));
  const shortcuts = $derived(
    activeGroup === null ? {} : buildGroupShortcuts(activeGroup),
  );
  const rotateShortcut = $derived(
    selectedBuilding === null ? undefined : ROTATE_KEY,
  );

  const armedDefinition = $derived(
    selectedBuilding === null ? null : BUILDING_CATALOG[selectedBuilding],
  );
  const armedFactsSummary = $derived.by(() => {
    if (selectedBuilding === null || armedDefinition === null) return null;
    const size = getRotatedFootprintSize(selectedBuilding, buildingRotation);
    const capacity =
      armedDefinition.residentCapacity > 0
        ? `${armedDefinition.residentCapacity} residents`
        : armedDefinition.jobCapacity > 0
          ? `${armedDefinition.jobCapacity} jobs`
          : null;
    return [
      `${size.width} × ${size.height}`,
      formatBudget(armedDefinition.cost),
      ...(capacity === null ? [] : [capacity]),
    ].join(" · ");
  });

  function isItemActive(action: BuildItemAction): boolean {
    if (action.kind === "building") {
      return selectedBuilding === action.building;
    }
    if (action.kind === "area") {
      return (
        selectedBuilding === null &&
        activeTool === "area" &&
        action.area === selectedArea
      );
    }
    if (action.kind === "road") {
      return (
        selectedBuilding === null &&
        activeTool === "road" &&
        roadPreset === action.roadPreset
      );
    }
    if (action.kind === "roundabout") {
      return (
        selectedBuilding === null &&
        activeTool === "roundabout" &&
        roundaboutSize === action.size
      );
    }
    if (action.kind === "tool") {
      return selectedBuilding === null && activeTool === action.tool;
    }
    return selectedBuilding === null && activeTool === "track";
  }

  const activeItem = $derived.by((): BuildMenuItem | null => {
    if (activeGroup === null) return null;
    return (
      buildGroupItems(activeGroup).find((item) => isItemActive(item.action)) ??
      null
    );
  });

  function itemFootprint(
    action: BuildItemAction,
  ): { width: number; height: number } | null {
    if (action.kind === "building" || action.kind === "tool") {
      return getRotatedFootprintSize(
        action.kind === "building" ? action.building : action.tool,
        isItemActive(action) ? buildingRotation : 0,
      );
    }
    if (action.kind === "roundabout") {
      const dimension = ROUNDABOUT_DIMENSIONS[action.size];
      return { width: dimension, height: dimension };
    }
    if (action.kind === "road" || action.kind === "track") {
      return { width: 1, height: 1 };
    }
    return null;
  }

  function costLabel(cost: BuildItemCost): string {
    if (cost === "free") return "Free";
    const amount = formatBudget(cost.amount);
    return cost.unit === "each" ? `${amount} each` : `${amount}/tile`;
  }

  function itemMeta(action: BuildItemAction, cost: BuildItemCost): string {
    const size = itemFootprint(action);
    return `${size === null ? "Paint" : `${size.width} × ${size.height}`} · ${costLabel(cost)}`;
  }

  function itemKeyShortcuts(
    action: BuildItemAction,
    shortcut: string | undefined,
  ): string | undefined {
    const keys = [
      ...(shortcut === undefined ? [] : [shortcut]),
      ...(action.kind === "track" ? [TRACK_KEY] : []),
    ];
    return keys.length === 0 ? undefined : keys.join(" ");
  }
</script>

<div class="hud-panel" data-testid="panel-build">
  {#if activeGroup === null}
    <CommandPlateGrid
      bind:this={plateGrid}
      {plates}
      onSelect={onSetBuildGroup}
    />
  {:else}
    <div class="build-detail">
      <div class="build-nav">
        <button
          type="button"
          class="btn build-back"
          data-action="build-back"
          data-testid="build-back"
          aria-label="Back to build categories"
          bind:this={backButton}
          onclick={() => onSetBuildGroup(null)}
        >
          ‹ Back
        </button>
        <h3>{activeGroup.label}</h3>
      </div>

      {#each activeGroup.sections as section (section.id)}
        <section class="build-section" data-build-section={section.id}>
          {#if section.label !== null}
            <h4 class="section-head">{section.label}</h4>
          {/if}
          <div
            class="build-items"
            role="group"
            aria-label={`${section.label ?? activeGroup.label} items`}
          >
            {#each section.items as item (item.id)}
              {@const keyShortcuts = itemKeyShortcuts(
                item.action,
                shortcuts[item.id],
              )}
              {@const shortcutLabel = keyShortcuts
                ?.toUpperCase()
                .split(" ")
                .join(" / ")}
              <button
                type="button"
                class="build-item"
                class:active={isItemActive(item.action)}
                data-build-item={item.id}
                data-testid={`build-item-${item.id}`}
                data-building={item.action.kind === "building"
                  ? item.action.building
                  : undefined}
                aria-pressed={isItemActive(item.action)}
                aria-label={item.label}
                aria-describedby={`build-item-meta-${item.id} build-item-description-${item.id}`}
                aria-keyshortcuts={keyShortcuts}
                title={shortcutLabel === undefined
                  ? undefined
                  : `${item.label} (${shortcutLabel})`}
                onclick={() => onSelectItem(item.action)}
              >
                <span class="build-item__media">
                  <img
                    class="build-item__art"
                    src={itemThumbnails[item.id]}
                    alt=""
                    aria-hidden="true"
                  />
                  {#if shortcutLabel !== undefined}
                    <kbd class="build-item__key" aria-hidden="true"
                      >{shortcutLabel}</kbd
                    >
                  {/if}
                </span>
                <span class="build-item__label">{item.label}</span>
                <span id={`build-item-meta-${item.id}`} class="build-item__meta"
                  >{itemMeta(item.action, item.cost)}</span
                >
                <span
                  id={`build-item-description-${item.id}`}
                  class="build-item__description">{item.description}</span
                >
              </button>
            {/each}
          </div>
        </section>
      {/each}

      <footer class="build-footer" data-testid="build-footer">
        {#if activeItem !== null}
          <p class="footer-description" data-testid="active-item-description">
            {activeItem.description}
          </p>
        {/if}

        {#if armedDefinition !== null && armedFactsSummary !== null}
          <div class="armed-facts" data-testid="armed-building-facts">
            <p class="facts-line">{armedFactsSummary}</p>
            {#if armedDefinition.workPattern !== undefined}
              <p class="facts-pattern">{armedDefinition.workPattern}</p>
            {/if}
          </div>
        {/if}

        {#if activeGroup.hint !== undefined}
          <p class="build-hint" data-testid="build-hint">{activeGroup.hint}</p>
        {/if}

        <button
          type="button"
          class="rotate-control"
          aria-label={`Rotate building, current rotation ${buildingRotation} degrees`}
          aria-keyshortcuts={rotateShortcut}
          title={rotateShortcut === undefined
            ? undefined
            : `Rotate (${rotateShortcut.toUpperCase()})`}
          disabled={selectedBuilding === null}
          onclick={onRotateBuilding}
        >
          <span class="rotate-label">
            <span>Rotate</span>
            {#if rotateShortcut !== undefined}
              <kbd class="shortcut-chip" aria-hidden="true"
                >{rotateShortcut.toUpperCase()}</kbd
              >
            {/if}
          </span>
          <span class="rotate-value">{buildingRotation}°</span>
        </button>
      </footer>
    </div>
  {/if}
</div>

<style>
  .build-items {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
  }

  .build-item {
    display: grid;
    grid-template-columns: 52px minmax(0, 1fr);
    grid-template-rows: repeat(3, auto);
    align-content: start;
    align-items: start;
    gap: 1px 10px;
    min-width: 0;
    padding: 7px;
    border: 1px solid var(--line);
    border-left: 2px solid var(--ink-faint);
    border-radius: 0;
    background: var(--surface-sunk);
    color: var(--ink-mid);
    font-family: var(--font-display);
    text-align: left;
    cursor: pointer;
    transition:
      border-color 0.15s ease,
      background 0.15s ease,
      color 0.15s ease;
  }

  .build-item:hover {
    border-color: var(--line-strong);
    border-left-color: var(--accent);
    background: var(--surface);
    color: var(--ink);
  }

  .build-item.active {
    border-color: var(--accent-warm);
    border-left-color: var(--accent-warm);
    background: linear-gradient(
      135deg,
      color-mix(in srgb, var(--accent-warm) 12%, transparent),
      color-mix(in srgb, var(--accent-warm) 4%, transparent)
    );
    color: var(--ink);
  }

  .build-item__media {
    position: relative;
    grid-row: 1 / span 3;
    width: 52px;
    height: 52px;
  }

  .build-item__art {
    display: block;
    width: 52px;
    height: 52px;
    border-radius: 4px;
    object-fit: cover;
  }

  .build-item__key {
    position: absolute;
    top: -4px;
    right: -4px;
    display: inline-grid;
    place-items: center;
    min-width: 14px;
    padding: 0 3px;
    border: 1px solid var(--line-strong);
    background: var(--surface-raised);
    color: var(--ink);
    font-family: var(--font-body);
    font-size: 9px;
    font-weight: 600;
    line-height: 1.4;
  }

  .build-item__label {
    font-size: 11.5px;
    font-weight: 600;
    line-height: 1.12;
    color: var(--ink);
    overflow-wrap: anywhere;
  }

  .build-item__meta {
    font-family: var(--font-body);
    font-size: 9.5px;
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
  }

  .build-item__description {
    font-family: var(--font-body);
    font-size: 10px;
    line-height: 1.25;
  }

  /* Pins to the dock panel's scroll bottom; offsets match its 16px body padding. */
  .build-footer {
    position: sticky;
    z-index: 2;
    bottom: -16px;
    display: grid;
    gap: 6px;
    margin: 12px -16px -16px;
    padding: 10px 16px 12px;
    border-top: 1px solid var(--line);
    background: var(--surface);
  }

  .footer-description {
    margin: 0;
    font-family: var(--font-body);
    font-size: 11px;
    line-height: 1.3;
    color: var(--ink-mid);
  }

  .shortcut-chip {
    display: inline-grid;
    place-items: center;
    min-width: 16px;
    padding: 1px 4px;
    border: 1px solid var(--line-strong);
    background: var(--surface-sunk);
    color: var(--ink-mid);
    font-family: var(--font-body);
    font-size: 9px;
    font-weight: 600;
    line-height: 1.3;
    text-align: center;
  }

  .rotate-label {
    display: flex;
    align-items: center;
    gap: 8px;
  }
</style>

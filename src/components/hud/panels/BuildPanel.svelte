<script lang="ts">
  import type {
    AreaKind,
    BuildingRotation,
    BuildingType,
    RoadPreset,
    RoundaboutSize,
    Tool,
  } from "../../../domain/types";
  import {
    BUILD_GROUPS,
    findBuildGroup,
    type BuildGroup,
    type BuildItemAction,
  } from "../../../domain/catalog/buildGroups";
  import {
    BUILDING_CATALOG,
    getRotatedFootprintSize,
  } from "../../../domain/catalog/buildings";
  import CommandPlateGrid from "../CommandPlateGrid.svelte";
  import roadsPlate from "../../../assets/command-plates/roads.webp";
  import transitPlate from "../../../assets/command-plates/transit.webp";
  import zonesPlate from "../../../assets/command-plates/zones.webp";
  import buildingsPlate from "../../../assets/command-plates/buildings.webp";
  import { pad2 } from "../../../format";
  import {
    ROAD_PRESET_KEYS,
    ROTATE_KEY,
    TRACK_KEY,
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

  const plates = (
    [
      { id: "roads", label: "Roads", image: roadsPlate },
      { id: "transit", label: "Transit", image: transitPlate },
      { id: "zones", label: "Zones", image: zonesPlate },
      { id: "buildings", label: "Buildings", image: buildingsPlate },
    ] satisfies Array<{ id: BuildGroup; label: string; image: string }>
  ).filter((plate) => BUILD_GROUPS.some((group) => group.id === plate.id));

  const activeGroup = $derived(findBuildGroup(activeBuildGroup));
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
      `$${armedDefinition.cost.toLocaleString("en-US")}`,
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
</script>

<div class="hud-panel" data-testid="panel-build">
  {#if activeGroup === null}
    <CommandPlateGrid {plates} onSelect={onSetBuildGroup} />
  {:else}
    <div class="build-detail">
      <div class="build-nav">
        <button
          type="button"
          class="build-back"
          data-action="build-back"
          data-testid="build-back"
          aria-label="Back to build categories"
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
            class="toolbar"
            aria-label={`${section.label ?? activeGroup.label} items`}
          >
            {#each section.items as item, index (item.id)}
              {@const shortcut =
                item.action.kind === "track"
                  ? TRACK_KEY
                  : item.action.kind === "road" && activeTool === "road"
                    ? ROAD_PRESET_KEYS[item.action.roadPreset]
                    : undefined}
              {@const chip =
                item.action.kind === "track" ? TRACK_KEY : undefined}
              <button
                type="button"
                data-build-item={item.id}
                data-testid={`build-item-${item.id}`}
                data-building={item.action.kind === "building"
                  ? item.action.building
                  : undefined}
                aria-pressed={isItemActive(item.action)}
                aria-label={item.label}
                aria-keyshortcuts={shortcut}
                title={shortcut === undefined
                  ? undefined
                  : `${item.label} (${shortcut.toUpperCase()})`}
                class:active={isItemActive(item.action)}
                class:has-shortcut={chip !== undefined}
                onclick={() => onSelectItem(item.action)}
              >
                <span class="tool-num" aria-hidden="true"
                  >{pad2(index + 1)}</span
                >
                <span class="tool-label" aria-hidden="true">{item.label}</span>
                {#if chip !== undefined}
                  <kbd class="shortcut-chip" aria-hidden="true"
                    >{chip.toUpperCase()}</kbd
                  >
                {/if}
              </button>
            {/each}
          </div>
        </section>
      {/each}

      {#if activeGroup.hint !== undefined}
        <p class="build-hint" data-testid="build-hint">{activeGroup.hint}</p>
      {/if}

      {#if armedDefinition !== null && armedFactsSummary !== null}
        <div class="armed-facts" data-testid="armed-building-facts">
          <p class="facts-line">{armedFactsSummary}</p>
          {#if armedDefinition.workPattern !== undefined}
            <p class="facts-pattern">{armedDefinition.workPattern}</p>
          {/if}
        </div>
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
        <span class="rotate-value">{buildingRotation}</span>
      </button>
    </div>
  {/if}
</div>

<style>
  .toolbar button.has-shortcut {
    grid-template-columns: 28px minmax(0, 1fr) auto;
  }

  .shortcut-chip {
    display: inline-grid;
    place-items: center;
    min-width: 16px;
    padding: 1px 4px;
    border: 1px solid var(--line-strong);
    background: var(--surface-sunk);
    color: var(--ink-mid);
    font-family: var(--font-mono);
    font-size: 9px;
    font-weight: 600;
    line-height: 1.3;
    text-align: center;
  }

  .toolbar .shortcut-chip {
    grid-column: 3;
    grid-row: 1 / span 2;
  }

  .rotate-label {
    display: flex;
    align-items: center;
    gap: 8px;
  }
</style>

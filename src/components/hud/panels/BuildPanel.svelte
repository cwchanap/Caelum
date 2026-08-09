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
  import CommandPlateGrid from "../CommandPlateGrid.svelte";
  import roadsPlate from "../../../assets/command-plates/roads.webp";
  import transitPlate from "../../../assets/command-plates/transit.webp";
  import zonesPlate from "../../../assets/command-plates/zones.webp";
  import buildingsPlate from "../../../assets/command-plates/buildings.webp";
  import { pad2 } from "../../../format";

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
              <button
                type="button"
                data-build-item={item.id}
                data-testid={`build-item-${item.id}`}
                data-building={item.action.kind === "building"
                  ? item.action.building
                  : undefined}
                aria-pressed={isItemActive(item.action)}
                aria-label={item.label}
                class:active={isItemActive(item.action)}
                onclick={() => onSelectItem(item.action)}
              >
                <span class="tool-num" aria-hidden="true"
                  >{pad2(index + 1)}</span
                >
                <span class="tool-label" aria-hidden="true">{item.label}</span>
              </button>
            {/each}
          </div>
        </section>
      {/each}

      <button
        type="button"
        class="rotate-control"
        aria-label={`Rotate building, current rotation ${buildingRotation} degrees`}
        disabled={selectedBuilding === null}
        onclick={onRotateBuilding}
      >
        <span>Rotate</span>
        <span class="rotate-value">{buildingRotation}</span>
      </button>
    </div>
  {/if}
</div>

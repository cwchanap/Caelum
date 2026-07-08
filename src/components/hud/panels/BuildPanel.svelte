<script lang="ts">
  import type {
    BuildingRotation,
    BuildingType,
    RoadPreset,
    Tool,
  } from "../../../domain/types";
  import type {
    BuildCategoryId,
    BuildItemAction,
  } from "../../../domain/catalog/buildMenu";
  import { BUILD_MENU, findBuildCategory } from "../../../domain/catalog/buildMenu";

  interface Props {
    buildCategory: BuildCategoryId | null;
    activeTool: Tool;
    selectedBuilding: BuildingType | null;
    roadPreset: RoadPreset;
    buildingRotation: BuildingRotation;
    onSetBuildCategory: (id: BuildCategoryId | null) => void;
    onSelectItem: (action: BuildItemAction) => void;
    onRotateBuilding: () => void;
  }

  let {
    buildCategory,
    activeTool,
    selectedBuilding,
    roadPreset,
    buildingRotation,
    onSetBuildCategory,
    onSelectItem,
    onRotateBuilding,
  }: Props = $props();

  const activeCategory = $derived(findBuildCategory(buildCategory));

  function isItemActive(action: BuildItemAction): boolean {
    if (action.kind === "building") {
      return selectedBuilding === action.building;
    }
    if (action.kind === "road") {
      return (
        selectedBuilding === null &&
        activeTool === "road" &&
        roadPreset === action.roadPreset
      );
    }
    return selectedBuilding === null && activeTool === "track";
  }

  function itemBuilding(action: BuildItemAction): BuildingType | undefined {
    return action.kind === "building" ? action.building : undefined;
  }

  function pad2(value: number): string {
    return value.toString().padStart(2, "0");
  }
</script>

<div class="hud-panel" data-testid="panel-build">
  <section class="panel-section build-section">
    {#if activeCategory === null}
      <h3 class="section-head"><span class="num">01</span> Build</h3>
      <div class="toolbar" aria-label="Build categories">
        {#each BUILD_MENU as category, index (category.id)}
          <button
            type="button"
            data-build-category={category.id}
            aria-label={category.label}
            onclick={() => onSetBuildCategory(category.id)}
          >
            <span class="tool-num" aria-hidden="true">{pad2(index + 1)}</span>
            <span class="tool-label" aria-hidden="true">{category.label}</span>
          </button>
        {/each}
      </div>
    {:else}
      <div class="build-nav">
        <button
          type="button"
          class="build-back"
          data-action="build-back"
          aria-label="Back to build categories"
          onclick={() => onSetBuildCategory(null)}
        >
          ‹ Back
        </button>
        <span class="build-crumb">Build › {activeCategory.label}</span>
      </div>
      <div class="toolbar" aria-label={`${activeCategory.label} items`}>
        {#each activeCategory.items as item, index (item.id)}
          <button
            type="button"
            data-build-item={item.id}
            data-building={itemBuilding(item.action)}
            aria-pressed={isItemActive(item.action)}
            aria-label={item.label}
            class:active={isItemActive(item.action)}
            onclick={() => onSelectItem(item.action)}
          >
            <span class="tool-num" aria-hidden="true">{pad2(index + 1)}</span>
            <span class="tool-label" aria-hidden="true">{item.label}</span>
          </button>
        {/each}
      </div>
    {/if}

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
  </section>
</div>

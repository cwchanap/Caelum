<script lang="ts">
  import type { ShellHudState } from "../../runtime/types";
  import type { HudCategory } from "../../ui/uiState";

  interface Props {
    hud: ShellHudState;
    onSetHudCategory: (category: HudCategory | null) => void;
    onCancel: () => void;
  }

  let { hud, onSetHudCategory, onCancel }: Props = $props();

  type CategoryButton = { id: HudCategory; label: string };

  const categories: CategoryButton[] = [
    { id: "build", label: "Build" },
    { id: "routes", label: "Routes" },
    { id: "manage", label: "Manage" },
    { id: "data", label: "Data" },
    { id: "brief", label: "Brief" },
  ];

  function toggle(category: HudCategory): void {
    onSetHudCategory(hud.activeCategory === category ? null : category);
  }
</script>

<nav class="bottom-hud" data-testid="bottom-hud" aria-label="HUD categories">
  <div class="hud-categories">
    {#each categories as category (category.id)}
      <button
        type="button"
        class="hud-cat"
        class:active={hud.activeCategory === category.id}
        data-testid={`hud-cat-${category.id}`}
        aria-pressed={hud.activeCategory === category.id}
        onclick={() => toggle(category.id)}
      >
        <span class="hud-cat-label">{category.label}</span>
        {#if category.id === "routes" && hud.badges.routeDraftActive}
          <span class="hud-badge hud-badge--dot" data-testid="hud-badge-draft"
            >●</span
          >
        {/if}
        {#if category.id === "manage" && hud.badges.routeCount > 0}
          <span class="hud-badge" data-testid="hud-badge-count"
            >{hud.badges.routeCount}</span
          >
        {/if}
        {#if category.id === "data" && hud.badges.activeOverlayLabel !== null}
          <span class="hud-badge" data-testid="hud-badge-overlay"
            >{hud.badges.activeOverlayLabel}</span
          >
        {/if}
      </button>
    {/each}

    {#if hud.badges.inspectActive}
      <button
        type="button"
        class="hud-cat hud-cat--inspect"
        class:active={hud.activeCategory === "inspect"}
        data-testid="hud-cat-inspect"
        aria-pressed={hud.activeCategory === "inspect"}
        onclick={() => toggle("inspect")}
      >
        <span class="hud-cat-label">Inspect</span>
      </button>
    {/if}
  </div>

  <div class="hud-status">
    <span class="hud-tool-chip" data-testid="hud-tool-chip"
      >{hud.activeToolChip}</span
    >
    <button
      type="button"
      class="hud-cancel"
      data-testid="hud-cancel"
      disabled={!hud.canCancel}
      onclick={onCancel}
    >
      Cancel · Esc
    </button>
  </div>
</nav>

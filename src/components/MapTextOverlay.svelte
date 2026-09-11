<script lang="ts">
  import type { GameState } from "../domain/types";
  import type { UiState } from "../ui/uiState";
  import { getBoardTransform, tileSize } from "../render/boardTransform";
  import {
    selectMapTextOverlayItems,
    type MapTextOverlayItem,
  } from "../render/mapTextOverlay";

  interface Props {
    state: GameState;
    ui: UiState;
  }

  // Renamed to `game` so the local binding does not collide with the
  // `$state` rune.
  let { state: game, ui }: Props = $props();

  let overlayHost = $state<HTMLDivElement | null>(null);
  let box = $state<{ width: number; height: number } | null>(null);

  // The overlay shares the board's full CSS box; feed that same box into
  // getBoardTransform so DOM labels land on the GPU-drawn geometry.
  $effect(() => {
    const element = overlayHost;
    if (element === null) {
      return;
    }
    const measure = () => {
      box = { width: element.clientWidth, height: element.clientHeight };
    };
    measure();
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }
  });

  const items = $derived(selectMapTextOverlayItems(game, ui));

  type PlacedItem = MapTextOverlayItem & {
    left: number;
    top: number;
    below: boolean;
  };

  const placed = $derived.by(() => {
    const transform = box === null ? null : getBoardTransform(box, game.map);
    if (transform === null) {
      return [] as PlacedItem[];
    }
    return items.map((item): PlacedItem => {
      const left =
        transform.offsetX + (item.anchor.x + 0.5) * tileSize * transform.scale;
      if (item.kind === "routeWaypoint") {
        // Centered inside the GPU-drawn handle circle.
        return {
          ...item,
          left,
          top:
            transform.offsetY +
            (item.anchor.y + 0.5) * tileSize * transform.scale,
          below: false,
        };
      }
      // Labels hover above their tile, flipping below the tile on the top
      // row so they stay fully visible (same rule as the Canvas badge).
      const tileTop =
        transform.offsetY + item.anchor.y * tileSize * transform.scale;
      const below = item.anchor.y < 1;
      return {
        ...item,
        left,
        top: below ? tileTop + tileSize * transform.scale : tileTop,
        below,
      };
    });
  });
</script>

<div
  class="map-text-overlay"
  data-testid="map-text-overlay"
  bind:this={overlayHost}
  aria-hidden="true"
>
  {#each placed as item, index (index)}
    <span
      class="map-text-item"
      class:map-text-below={item.below}
      data-kind={item.kind}
      style:left="{item.left}px"
      style:top="{item.top}px">{item.text}</span
    >
  {/each}
</div>

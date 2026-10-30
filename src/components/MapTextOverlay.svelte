<script lang="ts">
  import type { GameState } from "../domain/types";
  import type { UiState } from "../ui/uiState";
  import {
    getBoardTransform,
    tileSize,
    type Camera,
  } from "../render/boardTransform";
  import {
    selectMapTextOverlayItems,
    type MapTextOverlayItem,
  } from "../render/mapTextOverlay";

  interface Props {
    state: GameState;
    ui: UiState;
    camera: Camera | null;
  }

  // Renamed to `game` so the local binding does not collide with the
  // `$state` rune.
  let { state: game, ui, camera }: Props = $props();

  let box = $state<{ width: number; height: number } | null>(null);

  // The overlay shares the board's full CSS box; feed that same box into
  // getBoardTransform so DOM labels land on the GPU-drawn geometry.
  function measureHost(element: HTMLDivElement) {
    const measure = () => {
      box = { width: element.clientWidth, height: element.clientHeight };
    };
    measure();
    if (typeof ResizeObserver !== "function") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return { destroy: () => observer.disconnect() };
  }

  const items = $derived(selectMapTextOverlayItems(game, ui));

  // The cursor badge is the only place preview cost, route impacts, and
  // rejections render, and the overlay below is aria-hidden. Mirror its
  // spoken text in a non-live sr-only element so assistive tech can inspect
  // the same preview before a click without announcing every hover change.
  const cursorReadout = $derived(
    items.find((item) => item.kind === "cursorBadge")?.a11yText ?? null,
  );

  // How far a label rises above its anchor: the 8px gap, 16px line and 2px
  // top/bottom padding of .map-text-item in styles.css.
  const LABEL_RISE_PX = 28;

  // Estimated label width: 12px JetBrains Mono advances ~7.5px/char; padding
  // is 6px each side plus slack for the inset border. Overestimating is safe —
  // it only flips the label to a roomier side sooner.
  const CHAR_PX = 7.5;
  const PAD_PX = 16;
  const EDGE_PX = 8;

  type PlacedItem = MapTextOverlayItem & {
    left: number;
    top: number;
    below: boolean;
    side: "left" | "center" | "right";
    maxWidth: number | null;
  };

  const placed = $derived.by(() => {
    const transform =
      box === null ? null : getBoardTransform(box, game.map, camera);
    if (transform === null) {
      return [] as PlacedItem[];
    }
    const boardWidth = box?.width ?? 0;
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
          side: "center",
          maxWidth: null,
        };
      }
      // Labels hover above their tile, flipping below it on the top visible
      // row, or lower when tiles are too short to hold the label's rise.
      const tileTop =
        transform.offsetY + item.anchor.y * tileSize * transform.scale;
      const below =
        tileTop <
        Math.max(transform.offsetY, 0) +
          Math.max(tileSize * transform.scale, LABEL_RISE_PX);
      // The nowrap label cannot wrap and the overlay clips overflow, so the
      // flip is by *estimated fit*, not board thirds: center when the whole
      // label fits around the anchor, otherwise the side with the most room.
      // maxWidth caps the box inside the board with an ellipsis as backstop.
      const width = item.text.length * CHAR_PX + PAD_PX;
      const spaceLeft = Math.max(0, left - EDGE_PX);
      const spaceRight = Math.max(0, boardWidth - left - EDGE_PX);
      const spaceCenter = Math.max(0, Math.min(2 * spaceLeft, 2 * spaceRight));
      const side =
        width <= spaceCenter
          ? ("center" as const)
          : spaceRight >= spaceLeft
            ? ("left" as const)
            : ("right" as const);
      const maxWidth =
        side === "center"
          ? spaceCenter
          : side === "left"
            ? spaceRight
            : spaceLeft;
      return {
        ...item,
        left,
        top: below ? tileTop + tileSize * transform.scale : tileTop,
        below,
        side,
        maxWidth,
      };
    });
  });
</script>

{#if cursorReadout !== null}
  <p class="sr-only" data-testid="map-text-cursor-readout">{cursorReadout}</p>
{/if}
<div
  class="map-text-overlay"
  data-testid="map-text-overlay"
  use:measureHost
  aria-hidden="true"
>
  {#each placed as item, index (index)}
    <span
      class={[
        "map-text-item",
        item.below && "map-text-below",
        item.side === "left" && "map-text-side-left",
        item.side === "right" && "map-text-side-right",
        item.kind === "cursorBadge" &&
          item.tone === "warning" &&
          "map-text-warning",
      ]}
      data-kind={item.kind}
      style="left: {item.left}px; top: {item.top}px"
      style:max-width={item.maxWidth === null
        ? undefined
        : `${item.maxWidth}px`}>{item.text}</span
    >
  {/each}
</div>

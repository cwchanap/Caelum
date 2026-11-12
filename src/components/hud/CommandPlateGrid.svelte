<script lang="ts">
  import type { BuildGroup } from "../../domain/catalog/buildGroups";

  interface Plate {
    id: BuildGroup;
    label: string;
    image: string;
  }

  interface Props {
    plates: readonly Plate[];
    onSelect: (group: BuildGroup) => void;
  }

  let { plates, onSelect }: Props = $props();
  let buttons: HTMLButtonElement[] = $state([]);

  function nextIndex(index: number, key: string): number {
    const row = Math.floor(index / 2);
    const column = index % 2;
    if (key === "ArrowRight" && column < 1) {
      return row * 2 + 1;
    }
    if (key === "ArrowLeft" && column > 0) {
      return row * 2;
    }
    if (key === "ArrowDown" && row < 1) {
      return 2 + column;
    }
    if (key === "ArrowUp" && row > 0) {
      return column;
    }
    return index;
  }

  function handleKeydown(index: number, event: KeyboardEvent): void {
    const target = nextIndex(index, event.key);
    if (target === index || target >= plates.length) return;
    event.preventDefault();
    buttons[target]?.focus();
  }

  /** Build drilldown focus return: focus the plate for a leaf group. */
  export function focusPlate(group: BuildGroup): void {
    const index = plates.findIndex((plate) => plate.id === group);
    if (index >= 0) buttons[index]?.focus();
  }
</script>

<div class="command-plate-grid" data-testid="command-plate-grid">
  {#each plates as plate, index (plate.id)}
    <button
      type="button"
      class="command-plate"
      data-testid={`command-plate-${plate.id}`}
      data-build-group={plate.id}
      onclick={() => onSelect(plate.id)}
      onkeydown={(event) => handleKeydown(index, event)}
      bind:this={buttons[index]}
    >
      <img src={plate.image} alt="" aria-hidden="true" />
      <span data-testid={`build-group-${plate.id}`}>{plate.label}</span>
    </button>
  {/each}
</div>

<style>
  .command-plate-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }

  .command-plate {
    display: grid;
    min-width: 0;
    min-height: 132px;
    place-items: center;
    gap: 8px;
    padding: 10px;
    border: 1px solid var(--line, rgba(62, 54, 38, 0.15));
    border-radius: 8px;
    color: var(--ink, #2f3a3f);
    background: var(--surface-raised, #fffdf6);
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    text-align: center;
    transition:
      color 150ms ease,
      background-color 150ms ease,
      border-color 150ms ease;
  }

  .command-plate:hover {
    border-color: color-mix(in srgb, var(--accent, #0f8a70) 40%, transparent);
    background: color-mix(in srgb, var(--accent, #0f8a70) 8%, transparent);
  }

  .command-plate:focus-visible {
    outline: 2px solid var(--accent, #0f8a70);
    outline-offset: 3px;
  }

  .command-plate img {
    width: clamp(88px, 11vw, 128px);
    height: clamp(88px, 11vw, 128px);
    object-fit: contain;
  }

  @media (prefers-reduced-motion: reduce) {
    .command-plate {
      transition: none;
    }
  }
</style>

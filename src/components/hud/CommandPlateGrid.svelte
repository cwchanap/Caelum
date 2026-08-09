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
    if (key === "ArrowRight" || key === "ArrowLeft") {
      return row * 2 + (column === 0 ? 1 : 0);
    }
    if (key === "ArrowDown" || key === "ArrowUp") {
      return (row === 0 ? 1 : 0) * 2 + column;
    }
    return index;
  }

  function handleKeydown(index: number, event: KeyboardEvent): void {
    const target = nextIndex(index, event.key);
    if (target === index || target >= plates.length) return;
    event.preventDefault();
    buttons[target]?.focus();
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
    border: 1px solid var(--line, rgba(255, 255, 255, 0.08));
    border-radius: 8px;
    color: var(--ink, #e6f1f4);
    background: var(--surface-raised, #111d22);
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    font-weight: 700;
    text-align: center;
    transition:
      color 150ms ease,
      background-color 150ms ease,
      border-color 150ms ease;
  }

  .command-plate:hover {
    border-color: rgba(63, 224, 197, 0.4);
    background: rgba(63, 224, 197, 0.08);
  }

  .command-plate:focus-visible {
    outline: 2px solid var(--cyan, #3fe0c5);
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

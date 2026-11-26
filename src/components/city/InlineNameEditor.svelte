<script lang="ts">
  interface Props {
    value: string;
    label: string;
    disabled?: boolean;
    testId?: string;
    /** Identifies the entity under edit: if the entity or its canonical name
     *  swaps while the editor is open, the open draft belongs to the old one
     *  and is discarded rather than applied to the replacement. */
    entityId?: string;
    onCommit: (value: string) => void | boolean | Promise<boolean>;
  }

  let {
    value,
    label,
    disabled = false,
    testId,
    entityId,
    onCommit,
  }: Props = $props();

  let editing = $state(false);
  let draft = $state("");
  let inputElement: HTMLInputElement | null = $state(null);
  let pencilElement: HTMLButtonElement | null = $state(null);
  // Escape arms this: unmounting the input drops focus to <body>, so the
  // close effect returns it to the pencil it was opened from. Commit and
  // blur paths deliberately leave focus alone.
  let focusPencilOnClose = false;
  let editingForId: string | undefined;
  let editingForValue = "";

  // Focus the freshly mounted editor; reading inputElement keeps the effect
  // tied to the input actually being in the DOM.
  $effect(() => {
    if (editing) {
      inputElement?.focus();
    } else if (focusPencilOnClose) {
      focusPencilOnClose = false;
      // A busy parent renders the pencil disabled, which cannot take focus;
      // an unmounted editor has no pencil at all. Both leave focus alone.
      if (pencilElement && !pencilElement.disabled) pencilElement.focus();
    }
  });

  // An open draft was typed for the entity/value captured at activation; if
  // either moves underneath the editor (e.g. a load swapping the active
  // city, or an external rename), discard it instead of letting a stale
  // draft land on the replacement.
  $effect(() => {
    if (editing && (entityId !== editingForId || value !== editingForValue)) {
      editing = false;
    }
  });

  function activate(): void {
    if (disabled) return;
    draft = value;
    editingForId = entityId;
    editingForValue = value;
    editing = true;
  }

  // Exported so a parent can flush an open draft before an action that
  // suppresses the blur commit (mousedown.preventDefault) and then unmounts
  // or retargets the editor — e.g. CityPanel's Load/New City buttons. The
  // result reports whether the action may proceed: false when the commit
  // was refused (a kept draft) or the commit callback itself failed.
  export function commit(): Promise<boolean> {
    // Enter commits and blurs; the blur handler must not commit a second time.
    // While the parent is busy the input itself is disabled, so a commit that
    // still reaches this point (e.g. a blur from the disabling flip) is
    // refused rather than queued — the draft stays for the user to retry.
    if (!editing) return Promise.resolve(true);
    if (disabled) return Promise.resolve(false);
    editing = false;
    const trimmed = draft.trim();
    if (trimmed.length === 0 || trimmed === value) return Promise.resolve(true);
    return Promise.resolve(onCommit(trimmed))
      .then(
        (result) => result !== false,
        () => false,
      )
      .then((committed) => {
        // A refused or failed commit re-opens the draft so the typed name
        // survives for an explicit retry — unless the entity or canonical
        // value already moved, where the open-draft effect drops it as stale.
        if (
          !committed &&
          entityId === editingForId &&
          value === editingForValue
        ) {
          editing = true;
        }
        return committed;
      });
  }

  function cancel(
    event: KeyboardEvent & { currentTarget: HTMLInputElement },
  ): void {
    focusPencilOnClose = true;
    editing = false;
    // Restore without triggering dock-level Escape handling.
    event.preventDefault();
    event.stopPropagation();
  }
</script>

{#if editing}
  <input
    bind:this={inputElement}
    bind:value={draft}
    type="text"
    dir="auto"
    class="inline-name-input"
    data-testid={testId}
    aria-label={label}
    {disabled}
    onkeydown={(event) => {
      if (event.isComposing) {
        if (event.key === "Escape") event.stopPropagation();
        return;
      }
      if (event.key === "Escape") {
        cancel(event as KeyboardEvent & { currentTarget: HTMLInputElement });
      } else if (event.key === "Enter") {
        commit();
        if (!editing) {
          event.currentTarget.blur();
        }
      }
    }}
    onblur={commit}
  />
{:else}
  <span class="inline-name-value" dir="auto" data-testid={testId}>{value}</span>
  <button
    bind:this={pencilElement}
    type="button"
    class="inline-name-pencil"
    aria-label={label}
    {disabled}
    onclick={activate}
  >
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M11.3 1.6a1.3 1.3 0 0 1 1.85 0l1.25 1.25a1.3 1.3 0 0 1 0 1.85l-8.4 8.4-3.9 1.05 1.05-3.9z"
      />
    </svg>
  </button>
{/if}

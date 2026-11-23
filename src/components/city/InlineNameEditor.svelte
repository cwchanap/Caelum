<script lang="ts">
  interface Props {
    value: string;
    label: string;
    disabled?: boolean;
    testId?: string;
    onCommit: (value: string) => void;
  }

  let { value, label, disabled = false, testId, onCommit }: Props = $props();

  let editing = $state(false);
  let draft = $state("");
  let inputElement: HTMLInputElement | null = $state(null);
  let pendingCommit = $state(false);
  // The value a held submission was captured for; if `value` moves
  // underneath (busy load/deletion swapping the edited entity), the held
  // submission is dropped instead of landing on the replacement.
  let heldForValue = $state("");

  // Focus the freshly mounted editor; reading inputElement keeps the effect
  // tied to the input actually being in the DOM.
  $effect(() => {
    if (editing) inputElement?.focus();
  });

  // A submission attempted while the parent is busy (e.g. an autosave) is
  // held, not discarded; land it once the parent goes idle again — unless
  // the user edited the draft again or the value changed under the editor,
  // in which case the next explicit submission decides.
  $effect(() => {
    if (!disabled && pendingCommit) {
      if (value !== heldForValue) {
        pendingCommit = false;
        return;
      }
      commit();
    }
  });

  // A submission still held when the editor unmounts (its panel closed or
  // switched away before the parent went idle) lands through the parent's
  // deferred path instead of being silently dropped with the component.
  $effect(() => {
    return () => {
      if (!pendingCommit) return;
      pendingCommit = false;
      const trimmed = draft.trim();
      if (trimmed.length === 0 || trimmed === value) return;
      onCommit(trimmed);
    };
  });

  function activate(): void {
    if (disabled) return;
    draft = value;
    editing = true;
  }

  function commit(): void {
    // Enter commits and blurs; the blur handler must not commit a second time.
    if (!editing) return;
    // Keep the editor and draft open while busy and defer the submission.
    if (disabled) {
      pendingCommit = true;
      heldForValue = value;
      return;
    }
    pendingCommit = false;
    editing = false;
    const trimmed = draft.trim();
    if (trimmed.length === 0 || trimmed === value) return;
    onCommit(trimmed);
  }

  function cancel(
    event: KeyboardEvent & { currentTarget: HTMLInputElement },
  ): void {
    editing = false;
    pendingCommit = false;
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
    class="inline-name-input"
    data-testid={testId}
    aria-label={label}
    oninput={() => {
      pendingCommit = false;
    }}
    onkeydown={(event) => {
      if (event.key === "Escape") {
        cancel(event as KeyboardEvent & { currentTarget: HTMLInputElement });
      } else if (event.key === "Enter") {
        commit();
        event.currentTarget.blur();
      }
    }}
    onblur={commit}
  />
{:else}
  <span class="inline-name-value" data-testid={testId}>{value}</span>
  <button
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

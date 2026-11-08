<script lang="ts">
  import type { ShellActionFeedback } from "../runtime/types";

  interface Props {
    feedback: ShellActionFeedback | null;
    onDismiss: () => void;
  }

  let { feedback, onDismiss }: Props = $props();
</script>

<!--
  A dedicated polite live region stays mounted permanently so screen readers
  observe a stable announcement container before any rejection text changes.
  Only `announce: true` feedback updates its text; the road preview host
  error (`announce: false`) renders in the visible strip below without
  live-region semantics. Continuous road-hover feedback lives at the cursor
  badge in the map text overlay, not in this strip.
-->
<aside class="action-feedback-slot" data-testid="action-feedback-slot">
  <div
    class="sr-only"
    role="status"
    aria-live="polite"
    data-testid="action-feedback-announce"
  >
    {feedback?.announce
      ? [feedback.message, ...feedback.details].join(" ")
      : ""}
  </div>
  {#if feedback !== null}
    <div
      class={`card action-feedback action-feedback--${feedback.tone}`}
      data-testid="action-feedback"
      data-source={feedback.source}
      data-tone={feedback.tone}
    >
      <!-- The 72px band makes this the only scrollable region; keyboard users
           need tabindex to scroll overflowed details (axe
           scrollable-region-focusable). Svelte can't detect the overflow, so
           the a11y warning is a false positive here. -->
      <!-- eslint-disable-next-line svelte/no-unused-svelte-ignore -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        class="action-feedback-body"
        tabindex="0"
        role="region"
        aria-label={feedback.message}
      >
        {#if feedback.tone === "error"}
          <svg
            class="action-feedback-icon"
            data-testid="action-feedback-icon"
            aria-hidden="true"
            viewBox="0 0 16 16"
          >
            <circle cx="8" cy="8" r="6.5" />
            <path d="m5.5 5.5 5 5m0-5-5 5" />
          </svg>
        {:else if feedback.tone === "warning"}
          <svg
            class="action-feedback-icon"
            data-testid="action-feedback-icon"
            aria-hidden="true"
            viewBox="0 0 16 16"
          >
            <path d="M8 1.5 14.5 14h-13L8 1.5Zm0 4v4m0 2v.5" />
          </svg>
        {:else}
          <svg
            class="action-feedback-icon"
            data-testid="action-feedback-icon"
            aria-hidden="true"
            viewBox="0 0 16 16"
          >
            <circle cx="8" cy="8" r="6.5" />
            <path d="M8 7v4m0-6v-.5" />
          </svg>
        {/if}

        <span class="action-feedback-message">{feedback.message}</span>

        {#if feedback.details.length > 0}
          <ul class="action-feedback-details">
            {#each feedback.details as detail, index (index)}
              <li>{detail}</li>
            {/each}
          </ul>
        {/if}
      </div>

      {#if feedback.dismissible}
        <button
          type="button"
          class="btn action-feedback-dismiss"
          aria-label="Dismiss"
          onclick={onDismiss}
        >
          &times;
        </button>
      {/if}
    </div>
  {/if}
</aside>

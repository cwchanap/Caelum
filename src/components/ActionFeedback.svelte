<script lang="ts">
  import type { ShellActionFeedback } from "../runtime/types";

  interface Props {
    feedback: ShellActionFeedback | null;
    onDismiss: () => void;
  }

  let { feedback, onDismiss }: Props = $props();
</script>

<!--
  The slot stays mounted so screen readers observe a stable container; the
  live-region semantics attach only when the current feedback is meant to be
  announced. Continuous road-hover feedback (`announce: false`) renders inside
  the slot without live-region attributes so it does not spam assistive tech,
  preserving the non-live road-hover contract.
-->
<aside
  class="action-feedback-slot"
  data-testid="action-feedback-slot"
  role={feedback?.announce ? "status" : undefined}
  aria-live={feedback?.announce ? "polite" : undefined}
>
  {#if feedback !== null}
    <div
      class={`action-feedback action-feedback--${feedback.tone}`}
      data-testid="action-feedback"
      data-source={feedback.source}
      data-tone={feedback.tone}
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

      {#if feedback.dismissible}
        <button
          type="button"
          class="action-feedback-dismiss"
          aria-label="Dismiss"
          onclick={onDismiss}
        >
          &times;
        </button>
      {/if}
    </div>
  {/if}
</aside>

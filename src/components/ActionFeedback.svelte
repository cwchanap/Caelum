<script lang="ts">
  import type { ShellActionFeedback } from "../runtime/types";

  interface Props {
    feedback: ShellActionFeedback | null;
    onDismiss: () => void;
  }

  let { feedback, onDismiss }: Props = $props();
</script>

{#if feedback !== null}
  <aside
    class={`action-feedback action-feedback--${feedback.tone}`}
    data-testid="action-feedback"
    data-source={feedback.source}
    data-tone={feedback.tone}
    role={feedback.announce ? "status" : undefined}
    aria-live={feedback.announce ? "polite" : undefined}
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
        {#each feedback.details as detail (detail)}
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
  </aside>
{/if}

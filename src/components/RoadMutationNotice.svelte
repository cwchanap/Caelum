<script lang="ts">
  import type { RoadMutationPreviewView } from "../runtime/types";
  import { rejectionMessage } from "../runtime/rejectionMessages";

  let {
    preview,
    error,
  }: { preview: RoadMutationPreviewView | null; error: string | null } =
    $props();
</script>

{#if error !== null || (preview && (preview.rejection !== null || preview.cost > 0 || preview.routeImpacts.length > 0))}
  <aside
    class="road-mutation-notice"
    data-testid="road-mutation-notice"
    role="status"
  >
    {#if error !== null}
      <span>Road preview unavailable: {error}</span>
    {:else if preview !== null}
      {#if preview.rejection !== null}
        <span>{rejectionMessage(preview.rejection)}</span>
      {:else}
        <span>{preview.costLabel}</span>
        {#each preview.routeImpacts as impact (impact.routeId)}
          <span>
            {impact.routeName}
            will {impact.kind === "broken" ? "become broken" : "reroute"}
          </span>
        {/each}
      {/if}
    {/if}
  </aside>
{/if}

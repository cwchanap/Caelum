<script lang="ts">
  import type { RoadMutationPreviewView } from "../runtime/types";

  let {
    preview,
    error,
  }: { preview: RoadMutationPreviewView | null; error: string | null } =
    $props();
</script>

{#if error !== null || (preview && (preview.cost > 0 || preview.routeImpacts.length > 0))}
  <aside
    class="road-mutation-notice"
    data-testid="road-mutation-notice"
    role="status"
  >
    {#if error !== null}
      <span>Road preview unavailable: {error}</span>
    {:else if preview !== null}
      <span>{preview.costLabel}</span>
      {#each preview.routeImpacts as impact (impact.routeId)}
        <span>
          {impact.routeName}
          will {impact.kind === "broken" ? "become broken" : "reroute"}
        </span>
      {/each}
    {/if}
  </aside>
{/if}

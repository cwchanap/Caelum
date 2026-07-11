<script lang="ts">
  import type { RoadMutationPreviewView } from "../runtime/types";

  let { preview }: { preview: RoadMutationPreviewView | null } = $props();
</script>

{#if preview && (preview.cost > 0 || preview.routeImpacts.length > 0)}
  <aside
    class="road-mutation-notice"
    data-testid="road-mutation-notice"
    role="status"
  >
    <span>{preview.costLabel}</span>
    {#each preview.routeImpacts as impact (impact.routeId)}
      <span>
        {impact.routeName}
        will {impact.kind === "broken" ? "become broken" : "reroute"}
      </span>
    {/each}
  </aside>
{/if}

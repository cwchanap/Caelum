<script lang="ts">
  import type { ShellInspectorState } from "../../../runtime/types";

  interface Props {
    inspector: ShellInspectorState;
    onAssignRouteToPlatform: (
      nodeId: string,
      routeId: string,
      platformId: string,
    ) => void;
  }

  let { inspector, onAssignRouteToPlatform }: Props = $props();
</script>

<div class="hud-panel" data-testid="panel-inspect">
  <section class="panel-section platform-panel" data-testid="platform-panel">
    <h3 class="section-head"><span class="num">07</span> Platforms</h3>
    <p class="brief-id">{inspector.nodeLabel}</p>
    {#each inspector.platforms as platform (platform.id)}
      <div class="platform-row">
        <div class="platform-head">
          <span class="platform-label">Platform {platform.label}</span>
          <span class="platform-occupancy"
            >{platform.occupancy}/{platform.capacity}</span
          >
        </div>
        {#if platform.routes.length === 0}
          <p class="platform-empty">No routes</p>
        {:else}
          <ul class="platform-routes">
            {#each platform.routes as route (route.id)}
              <li class="platform-route">
                <span class="route-chip" style={`--route-color: ${route.color}`}
                  >{route.name}</span
                >
                {#if inspector.canReassign}
                  {#each route.moveTargets as target (target.platformId)}
                    <button
                      type="button"
                      class="move-route"
                      aria-label={`Move ${route.name} to Platform ${target.label}`}
                      data-testid={`move-${route.id}-${target.platformId}`}
                      onclick={() =>
                        onAssignRouteToPlatform(
                          inspector.nodeId,
                          route.id,
                          target.platformId,
                        )}
                    >
                      → {target.label}
                    </button>
                  {/each}
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/each}
  </section>
</div>

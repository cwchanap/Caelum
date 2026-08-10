<script lang="ts">
  import type { EconomyPreset, SandboxTemplateId } from "../domain/types";
  import type { NewCityRequest } from "../runtime/workingSaveRuntime";

  interface Props {
    busy: boolean;
    error: string | null;
    onCreate: (request: NewCityRequest) => void;
  }

  let { busy, error, onCreate }: Props = $props();
  let name = $state("");
  let economyPreset = $state<EconomyPreset>("standard");
  let templateId = $state<SandboxTemplateId>("crossroads");
  const canCreate = $derived(!busy && name.trim().length > 0);

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    const trimmedName = name.trim();
    if (busy || trimmedName.length === 0) return;
    onCreate({ name: trimmedName, economyPreset, templateId });
  }
</script>

<main class="new-city-screen" data-testid="new-city-screen">
  <form class="new-city-card" onsubmit={submit}>
    <p class="new-city-kicker">CAELUM // LOCAL CITY</p>
    <h1>New City</h1>

    <label>
      <span>City name</span>
      <input bind:value={name} autocomplete="off" />
    </label>

    <label>
      <span>Economy</span>
      <select bind:value={economyPreset}>
        <option value="standard">Standard</option>
        <option value="creative">Creative</option>
      </select>
    </label>

    <label>
      <span>Template</span>
      <select bind:value={templateId}>
        <option value="crossroads">Crossroads</option>
        <option value="blankGrid">Blank Grid</option>
      </select>
    </label>

    {#if error !== null}
      <p class="new-city-error" role="alert">{error}</p>
    {/if}

    <button type="submit" disabled={!canCreate}>
      {busy ? "Creating…" : "Create City"}
    </button>
  </form>
</main>

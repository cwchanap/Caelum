<script lang="ts">
  import blankGridArt from "../assets/sunny-diorama/templates/blankGrid.webp";
  import crossroadsArt from "../assets/sunny-diorama/templates/crossroads.webp";
  import smallTownArt from "../assets/sunny-diorama/templates/smallTown.webp";
  import type {
    EconomyPreset,
    SandboxMapSize,
    SandboxTemplateId,
  } from "../domain/types";
  import { MAP_SIZES } from "../scenario/sandbox";
  import type { NewCityRequest } from "../runtime/workingSaveRuntime";

  interface Props {
    busy: boolean;
    error: string | null;
    onCreate: (request: NewCityRequest) => void;
    onCancel?: () => void;
  }

  let { busy, error, onCreate, onCancel }: Props = $props();
  let name = $state("");
  let economyPreset = $state<EconomyPreset>("standard");
  let templateId = $state<SandboxTemplateId>("crossroads");
  let mapSize = $state<SandboxMapSize>("small");
  const mapSizeIds = Object.keys(MAP_SIZES) as SandboxMapSize[];
  // Radio tiles are ordered Blank Grid, Crossroads, Small Town so native
  // arrow keys walk the illustrated choices in the mockup's order.
  const templateChoices: {
    id: SandboxTemplateId;
    label: string;
    art: string;
  }[] = [
    { id: "blankGrid", label: "Blank Grid", art: blankGridArt },
    { id: "crossroads", label: "Crossroads", art: crossroadsArt },
    { id: "smallTown", label: "Small Town", art: smallTownArt },
  ];
  const economyChoices: { id: EconomyPreset; label: string; note: string }[] = [
    { id: "standard", label: "Standard", note: "Money matters" },
    { id: "creative", label: "Creative", note: "Build for free" },
  ];
  const previewArt = $derived(
    templateChoices.find((choice) => choice.id === templateId)?.art ??
      crossroadsArt,
  );
  const canCreate = $derived(!busy && name.trim().length > 0);

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    const trimmedName = name.trim();
    if (busy || trimmedName.length === 0) return;
    onCreate({ name: trimmedName, economyPreset, templateId, mapSize });
  }
</script>

<main class="new-city-screen" data-testid="new-city-screen">
  <form class="card new-city-card" onsubmit={submit}>
    <h1>New City</h1>

    <div class="new-city-columns">
      <div class="new-city-form">
        <label>
          <span>City name</span>
          <input bind:value={name} autocomplete="off" />
        </label>

        <fieldset class="choice-group">
          <legend>Template</legend>
          <div class="choice-tiles">
            {#each templateChoices as choice (choice.id)}
              <label class="choice-tile choice-tile--template">
                <input
                  type="radio"
                  name="template"
                  value={choice.id}
                  bind:group={templateId}
                />
                <img src={choice.art} alt="" />
                <span>{choice.label}</span>
              </label>
            {/each}
          </div>
        </fieldset>

        <fieldset class="choice-group">
          <legend>Map size</legend>
          <div class="choice-tiles">
            {#each mapSizeIds as id (id)}
              <label class="choice-tile">
                <input
                  type="radio"
                  name="mapSize"
                  value={id}
                  bind:group={mapSize}
                />
                <span>{MAP_SIZES[id].label}</span>
                <span class="choice-detail" aria-hidden="true">
                  {MAP_SIZES[id].width}×{MAP_SIZES[id].height}
                </span>
              </label>
            {/each}
          </div>
        </fieldset>

        <fieldset class="choice-group">
          <legend>Economy</legend>
          <div class="choice-tiles">
            {#each economyChoices as choice (choice.id)}
              <label class="choice-tile">
                <input
                  type="radio"
                  name="economy"
                  value={choice.id}
                  bind:group={economyPreset}
                />
                <span>{choice.label}</span>
                <span class="choice-detail" aria-hidden="true"
                  >{choice.note}</span
                >
              </label>
            {/each}
          </div>
        </fieldset>

        {#if error !== null}
          <p class="new-city-error" role="alert">{error}</p>
        {/if}

        <div class="new-city-actions">
          <button class="btn" type="submit" disabled={!canCreate}>
            {busy ? "Creating…" : "Create City"}
          </button>
          {#if onCancel !== undefined}
            <button class="btn" type="button" disabled={busy} onclick={onCancel}
              >Cancel</button
            >
          {/if}
        </div>
      </div>

      <div class="new-city-preview">
        <img data-testid="new-city-preview" src={previewArt} alt="" />
      </div>
    </div>
  </form>
</main>

# HPA-350 — Deterministic Small Town Sandbox Template Design

**Date:** 2026-08-16  
**Issue:** HPA-350  
**Status:** Approved design, implementation not started

## Outcome

Add **Small Town** as the third Rust-owned sandbox starting template.

A new Small Town city starts paused with a compact authored road network, two Small Houses, one Supermarket, and one Factory. It starts with no residents, routes, stops, stations, vehicles, objectives, growth waves, or scripted onboarding. When the player resumes time, the existing Phase 2 move-in and workplace-assignment rules fill the houses deterministically; the existing commute scheduler then produces real trips against the authored town.

This replaces the older HPA-350 assumption that the template itself should seed residents. Resident creation is already a simulation rule and must not be duplicated inside template construction.

## Why this is the next slice

HPA-624 completed the first Phase 4 bus headway/deployment loop. The Phase 4 parent says additional service-control machinery should follow only when the playable loop exposes a concrete limitation.

Small Town is a better next step because it gives the current occupancy, commute, private-car congestion, and bus-service systems a repeatable player-facing environment without adding another operations subsystem.

## Design decision

Use one **static Rust template composition** inside the existing sandbox factory.

Small Town is authored with existing core functions and data:

- `author_scenario_road_line` for roads;
- `refresh_all_automatic_junctions` and `RoadTopology::compile` for road authority;
- `paint_area_rectangle` for zoning;
- `place_building_core` for cost-free authored buildings and canonical IDs;
- existing building catalog capacity;
- existing `apply_due_move_ins` and `assign_workplaces` behavior;
- existing commute/private-car routing after the game starts.

Do not add a template DSL, generic template builder, resident-seeding API, template-specific scheduler hook, or frontend-authored snapshot data.

## Reuse survey

| Need | Reuse | Decision |
| --- | --- | --- |
| Template identity | `SandboxTemplateId` | Add only `SmallTown` / `smallTown`. |
| Factory dispatch | `sandbox::create_sandbox_candidate` | Extend the existing match. |
| Map size | existing 28×18 `blank_map()` | Keep unchanged. |
| Authored roads | `author_scenario_road_line` | Reuse with `RoadPreset::TwoWay`. |
| Junction derivation | `refresh_all_automatic_junctions` | Reuse; no hand-authored structure IDs. |
| Zoning | `areas::paint_area_rectangle` | Reuse inside template construction. |
| Buildings | `buildings::place_building_core` | Reuse so footprints, IDs, `placedAt`, nodes, and workplace assignment follow gameplay rules without charging budget. |
| Population | `population::apply_due_move_ins` | Do not seed residents. Resume time to populate. |
| Jobs | building catalog `job_capacity` + `assign_workplaces` | Supermarket 4 + Factory 6 jobs cover the eventual 8 residents. |
| Commutes | existing trip scheduler/router | No template-specific demand code. |
| Private cars | existing footprint road-access derivation + road topology | Geometry guarantees every authored home/workplace has adjacent usable road access. |
| New City UI | existing `SandboxTemplateId` selector | Add one `Small Town` option. |
| City/template presentation | existing exhaustive `SANDBOX_TEMPLATE_LABELS` | Extend with `smallTown: "Small Town"`; do not create another registry. |

## Player-visible starting state

Small Town starts as a small readable settlement, not a solved transport network.

The player sees:

- a compact two-way main road and cross street;
- two residential houses on the west side;
- one commercial destination on the east side;
- one industrial destination south of the intersection;
- substantial empty map area for expansion;
- no public transport infrastructure or service.

On Resume, residents begin moving in under the normal sandbox rule. By the morning commute window the town has real worker demand. The player can then observe walk/car behavior and build bus service themselves.

## Authored layout

Keep the existing 28×18 map. Coordinates below are authoritative for this slice.

### Roads

Use `RoadPreset::TwoWay` for both strokes:

1. **Main Street:** `(3, 8)` through `(24, 8)`.
2. **Cross Street:** `(14, 2)` through `(14, 15)`.

After both strokes are authored, run the existing automatic-junction refresh and compile the topology. No roundabout, paired one-way arterial, secondary street, or prebuilt transit lane is required.

This shape deliberately leaves the map edges and most quadrants open for player expansion.

### Zones and buildings

Author the roads first, then create the normal snapshot shell, then paint only empty tiles, then place buildings with rotation `0`. This order is required because `can_place_building` enforces each catalog building’s `allowed_area`, while zoning/building placement do not mutate road fields and therefore do not invalidate the already-compiled topology.

| Area | Zone rectangle | Building | Origin | Footprint | Road access |
| --- | --- | --- | --- | --- | --- |
| Residential | `(4, 6)`–`(10, 7)` | Small House | `(4, 7)` | `(4..5, 7)` | Main Street immediately south |
| Residential | same zone | Small House | `(8, 7)` | `(8..9, 7)` | Main Street immediately south |
| Commercial | `(18, 6)`–`(19, 7)` | Supermarket | `(18, 6)` | `2×2` | Main Street immediately south |
| Industrial | `(15, 11)`–`(17, 12)` | Factory | `(15, 11)` | `3×2` | Cross Street immediately west |

The residential rectangle intentionally includes a little unused zoned land instead of fitting only the two house footprints. This makes the template read as a tiny neighborhood without introducing more buildings.

Every authored building footprint is adjacent to a normal two-way road tile, not the automatic junction footprint. This lets the existing `derive_stop_access_for_footprint` logic produce a usable private-car access point without storing new access metadata on buildings.

## Initial entities and budget

The initial snapshot contains exactly four authored buildings and zero simulation/transit entities:

- 2 × Small House;
- 1 × Supermarket;
- 1 × Factory;
- 0 sims;
- 0 active trips;
- 0 stops/stations/routes/metro lines/vehicles.

Authored roads/zones/buildings are part of the template and do **not** deduct construction cost from the requested starting budget. `place_building_core` is used rather than the costed player mutation for this reason.

Standard versus Creative continues to affect later player purchases through the existing cost policy. Small Town does not create a special economy rule.

## Population and demand behavior

Do not populate `snapshot.sims` in the factory.

Both Small Houses have existing resident capacity 4. Their authored `placedAt` is `0`, so once the paused game is resumed the normal move-in scheduler starts filling them immediately and deterministically.

The Supermarket and Factory already provide 4 and 6 jobs respectively. Existing stable workplace allocation therefore has 10 slots for at most 8 residents and requires no destination-capacity change.

The template does not force a particular transport mode. Its geometry is intentionally large enough that at least some representative commutes can naturally prefer the existing private-car candidate over walking, while public transport remains absent until the player creates it. Mode choice remains entirely authoritative to the existing router.

Behavioral tests should target a named in-game morning time derived from `GAME_DAY_SECONDS` and `MINUTES_PER_DAY` rather than hard-coding an opaque simulation delta. The current plan uses clock minute **480 (08:00)** so the invariant remains visible if game-day length or shift windows change.

## Factory and reset behavior

Extend the existing template enum/string mapping in all current sandbox seams:

- Rust `SandboxTemplateId::SmallTown` serialized as `smallTown`;
- Rust request parsing;
- `create_sandbox_candidate`;
- persisted-rule reset reconstruction;
- TypeScript `SandboxTemplateId`;
- TypeScript reset-error template-ID union/guard;
- existing `SANDBOX_TEMPLATE_LABELS` presentation map;
- New City template selector.

Reset must rebuild Small Town from its persisted rules exactly like Blank Grid and Crossroads. No compatibility alias or fallback template is added.

Adding an enum variant does not justify a snapshot/storage version bump by itself. Current v7 saves remain readable; new Small Town saves simply contain the newly supported `smallTown` value.

## Construction boundary

Keep Small Town authoring private to `sandbox.rs` unless one tiny local helper materially improves readability.

A suitable shape is:

1. start from `blank_map()`;
2. author the two road strokes;
3. refresh automatic junctions;
4. compile the road topology;
5. create the normal snapshot shell with name `Small Town`;
6. paint the three authored zone rectangles;
7. place the four buildings through `place_building_core(..., 0)` in the listed order;
8. return the completed snapshot plus the already-compiled topology.

Any impossible authored operation maps to the existing `TemplateInvariantViolation` for `SmallTown`. Do not introduce per-building/per-zone template error codes; these coordinates are developer-authored constants, not user input.

Do **not** copy `validate_crossroads_candidate` into a new production Small Town validator. Crossroads’ validator exists for its specialized 2×2 automatic-junction contract. Small Town needs only the existing factory failure mapping plus structural/routing tests for its simple two-way plus-shaped network.

## Determinism

Determinism comes from existing rules rather than new template machinery:

- fixed map coordinates;
- deterministic road/junction compilation;
- deterministic `next_entity_id` building IDs from fixed placement order;
- `placedAt = 0` from the initial snapshot time;
- deterministic resident IDs from existing move-in order;
- deterministic worker profile, shift, departure jitter, and workplace assignment;
- deterministic route/mode selection and car-flow ordering already owned by the simulation.

Repeated creation with identical requests must produce equal initial snapshots. Replaying the same resume/tick sequence must produce equal resident/trip IDs and commute state.

## UI and host boundary

No backend API changes are required beyond accepting/serializing the new template identifier through the existing sandbox creation request.

`NewCityScreen.svelte` adds:

```text
Small Town
```

alongside Blank Grid and Crossroads. The request still carries only city name, economy preset, and template ID.

The existing exhaustive `SANDBOX_TEMPLATE_LABELS: Record<SandboxTemplateId, string>` must also add `smallTown: "Small Town"`; this is existing presentation behavior used by the shell, not a new template registry.

WASM and Tauri continue to call the same Rust factory. No host-specific Small Town code is allowed.

## Testing strategy

Follow the active-development testing policy: prove the promised public behavior and reuse existing characterization seams; do not add a validation matrix for every authored tile.

### Rust factory tests

Extend `sandbox_factory.rs` to cover `smallTown` in the existing repeated-construction/settings loops and characterization fixture.

Add one focused Small Town structural test that proves:

- the two expected road strokes exist and topology compiles;
- the authored zones/building types/origins/rotation `0` match this design;
- representative `private_car_candidate` calls cover all four buildings and prove usable road access plus connected topology;
- exactly four buildings exist;
- sims, trips, transit, objectives, and growth waves start empty;
- Standard and Creative requests preserve their requested rules/budget.

### Rust behavior test

Use the real `GameEngine::from_sandbox_request` path:

1. create Small Town;
2. unpause through the normal intent;
3. advance through the existing tick pipeline to in-game clock minute **480 (08:00)**, deriving simulation seconds from `GAME_DAY_SECONDS` and `MINUTES_PER_DAY`;
4. assert eight residents exist;
5. assert every current worker has a workplace;
6. assert real outbound commute processing occurred through either an active trip or `outbound_resolved_today`;
7. repeat the same sequence in a second engine and compare the relevant snapshot/IDs.

Do not encode the morning target as magic `tick(400.0)`. Do not distort production mode-choice constants merely to make the template test demand a car.

### Frontend/E2E

Extend the existing TypeScript template union, reset-error whitelist, and `SANDBOX_TEMPLATE_LABELS`, then add the new option to existing New City unit coverage. Extend one Chromium New City flow to select **Small Town**, create it through the real WASM backend, and verify the game shell receives the authored city.

Do not add a second E2E suite for Standard versus Creative or duplicate the existing raw IndexedDB proof; Rust request/factory tests and the existing default-city browser test already own those contracts.

## Error handling

Small Town has no runtime-recoverable authoring errors. A failure to paint an authored zone, place an authored building, refresh the junction, or compile the authored road topology is a template invariant bug and returns the existing `TemplateInvariantViolation` with `templateId = smallTown`.

No retry, partial template construction, fallback to Crossroads, or repair behavior is added.

## Non-goals

- Seeded residents or direct `Sim` construction in the template.
- New population, demand, workplace, or commute rules.
- Prebuilt bus stops, bus routes, target headways, buses, metro, or tracks.
- Tutorial prompts, objectives, milestones, or campaign scripting.
- Growth waves or gradual authored expansion.
- Procedural city generation or random seeds.
- Generic template DSL/builder/registry beyond the existing enum + factory match.
- New building or zoning types.
- New road primitives, multilane redesign, or intersection framework.
- A copied production Small Town geometry validator.
- Template-specific economy rules.
- Snapshot migration, compatibility readers, or storage-version bump solely for `smallTown`.
- Phase 4 fleet top-up/withdrawal, layover, holding, bunching, service bands, or timetable work.

## Acceptance criteria

HPA-350 is complete when:

1. New City offers Blank Grid, Crossroads, and Small Town.
2. The City/shell template label renders Small Town through the existing exhaustive template-label map.
3. Small Town construction is fully Rust-owned and deterministic.
4. The initial paused Small Town contains exactly the authored roads/zones/four rotation-0 buildings and no residents/transit/scripted growth.
5. Every authored home/workplace has usable adjacent road access.
6. Resuming time uses existing move-in/workplace rules to populate the houses and produces real morning commute demand without debug actions.
7. Standard and Creative preserve the requested starting budget/rules while sharing identical template content.
8. Reset reconstructs the same Small Town template from persisted rules.
9. The real browser New City flow can create and render Small Town.

## Deliberate follow-up boundary

Use Small Town for playtesting before decomposing another HPA-334 service-operations child. If those playtests demonstrate a specific fleet-management, headway, holding, visibility, or congestion problem, scope the smallest follow-up around that observed problem rather than completing a service-management framework.

# Deterministic Small Town Sandbox Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `smallTown` as a deterministic Rust-owned starting template that opens as a compact four-building town and produces normal move-in/workplace/commute demand after Resume.

**Architecture:** Extend the existing sandbox enum/factory rather than introducing another template layer. Rust authors the fixed roads, areas, and buildings with existing core helpers; the existing simulation creates residents and trips after time resumes. TypeScript only accepts/presents the new identifier, and one real-WASM browser test proves the existing New City path reaches the authored snapshot.

**Tech Stack:** Rust (`caelum-core`, serde, Cargo tests), TypeScript/Svelte 5, Vitest + Testing Library, Playwright, existing WASM/Tauri backend contracts.

## Global Constraints

- `smallTown` is the third template beside `blankGrid` and `crossroads`; keep Crossroads as the existing default.
- Keep the existing 28×18 map; do not add map-size configuration.
- Main Street is a two-way stroke from `(3, 8)` through `(24, 8)`.
- Cross Street is a two-way stroke from `(14, 2)` through `(14, 15)`.
- Author exactly 2 Small Houses, 1 Supermarket, and 1 Factory at the approved coordinates; no other buildings.
- Start with zero sims, active trips, stops, stations, routes, metro lines, vehicles, objectives, and growth waves.
- Do not seed `Sim` values. Existing `apply_due_move_ins`, worker-profile/shift assignment, `assign_workplaces`, and commute scheduling remain authoritative.
- Authored roads/areas/buildings are template content and must not deduct from the requested starting budget.
- Standard and Creative use identical authored content and preserve the requested starting budget/rules.
- Do not add a template DSL/builder/registry, resident-seeding API, template-specific scheduler hook, new host API, dependency, save migration, compatibility reader, snapshot/storage version bump, or Phase 4 fleet/timetable machinery.
- Keep schema/storage at v7. Adding the additive `smallTown` enum value is not a version-bump reason.

---

## File Structure

### Rust authority

- Modify `crates/caelum-core/src/model.rs`
  - Add `SandboxTemplateId::SmallTown`; serde continues to own the `smallTown` wire value.
- Modify `crates/caelum-core/src/sandbox.rs`
  - Extend request parsing, persisted-rule reset mapping, invariant-error context mapping, and `create_sandbox_candidate`.
  - Keep Small Town authoring private here; one `create_small_town_candidate(...)` helper is sufficient.
- Modify `crates/caelum-core/tests/sandbox_factory.rs`
  - Extend the existing deterministic/settings/characterization loops and add one structural Small Town test.
- Modify `crates/caelum-core/tests/sandbox_engine.rs`
  - Prove reset and real Resume → move-in → workplace → commute behavior through `GameEngine`.
- Modify `crates/caelum-core/tests/fixtures/sandbox_templates.json`
  - Add the generated reviewed characterization for `smallTown`; do not hand-maintain IDs.

### TypeScript/UI boundary

- Modify `src/domain/types.ts`
  - Add `"smallTown"` to `SandboxTemplateId`.
- Modify `src/runtime/backend/types.ts`
  - Accept `"smallTown"` in `SandboxResetError.context.templateId`; keep `SandboxCreationRequest` stringly typed at the untrusted host boundary.
- Modify `src/runtime/backend/sandboxErrors.ts`
  - Accept `smallTown` as a known reset-error template ID.
- Modify `src/components/NewCityScreen.svelte`
  - Add the `Small Town` option without changing the default (`crossroads`) or form shape.
- Modify `tests/ui/appShell.test.ts`
  - Reuse the existing “submits only trimmed name, economy, and template” test and make it submit `smallTown`.
- Modify `tests/runtime/tauriBackend.test.ts`
  - Add one reset-error mapping regression for `{ templateId: "smallTown" }` so the shared reset guard is exercised.

### Browser integration

- Modify `tests/e2e/newCity.spec.ts`
  - Add one real-WASM Small Town creation proof using the existing `runtimeSnapshot(page)` seam; do not duplicate IndexedDB plumbing already covered by the existing default-city test.

---

### Task 1: Add the Rust-owned Small Town factory and behavioral proof

**Files:**
- Modify: `crates/caelum-core/src/model.rs` (`SandboxTemplateId`)
- Modify: `crates/caelum-core/src/sandbox.rs` (template parsing/construction/reset mappings)
- Modify: `crates/caelum-core/tests/sandbox_factory.rs`
- Modify: `crates/caelum-core/tests/sandbox_engine.rs`
- Modify: `crates/caelum-core/tests/fixtures/sandbox_templates.json`

**Interfaces:**
- Consumes:
  - `author_scenario_road_line(map: &mut GameMap, points: &[Point], preset: RoadPreset)`
  - `refresh_all_automatic_junctions(map: &mut GameMap) -> GameplayResult<()>`
  - `areas::paint_area_rectangle(state: &GameSnapshot, area: &str, start: &Point, end: &Point) -> GameplayResult<GameSnapshot>`
  - `buildings::place_building_core(state: &GameSnapshot, building_type: &str, origin: &Point, rotation: u16) -> GameplayResult<GameSnapshot>`
  - `RoadTopology::compile(&GameMap)`
  - existing `GameEngine::from_sandbox_request`, `GameEngine::dispatch`, `GameEngine::tick`, and `GameEngine::reset`
- Produces:
  - `SandboxTemplateId::SmallTown`, serialized by the existing camelCase serde rule as `smallTown`
  - existing `create_sandbox_snapshot(SandboxCreationRequest)` accepts `template_id: "smallTown"`
  - existing persisted-rule reset path reconstructs `SmallTown`
  - no new public Rust API

- [ ] **Step 1: Add failing factory coverage for the third template**

In `crates/caelum-core/tests/sandbox_factory.rs`, extend the two existing template loops and the template-ID match:

```rust
for template in ["blankGrid", "crossroads", "smallTown"] {
    // Keep the existing repeated-construction/settings assertions unchanged.
}
```

and:

```rust
match template {
    "blankGrid" => SandboxTemplateId::BlankGrid,
    "crossroads" => SandboxTemplateId::Crossroads,
    "smallTown" => SandboxTemplateId::SmallTown,
    _ => unreachable!(),
}
```

Extend the characterization object:

```rust
json!({
    "blankGrid": template_review("blankGrid"),
    "crossroads": template_review("crossroads"),
    "smallTown": template_review("smallTown"),
})
```

Do not update the fixture yet.

- [ ] **Step 2: Add a failing Small Town structural test**

Add one focused test in `sandbox_factory.rs`. Keep the assertions on promised public structure rather than every tile branch:

```rust
#[test]
fn small_town_has_the_authored_roads_zones_buildings_and_no_started_simulation() {
    let snapshot = create_sandbox_snapshot(request("smallTown")).unwrap();
    let topology = RoadTopology::compile(&snapshot.map).unwrap();

    assert_eq!((snapshot.map.width, snapshot.map.height), (28, 18));
    assert_eq!(snapshot.scenario.name, "Small Town");

    for x in 3..=24 {
        assert_eq!(snapshot.map.tile(Point { x, y: 8 }).unwrap().kind, "road");
    }
    for y in 2..=15 {
        assert_eq!(snapshot.map.tile(Point { x: 14, y }).unwrap().kind, "road");
    }

    assert_eq!(snapshot.map.tile(Point { x: 4, y: 6 }).unwrap().area.as_deref(), Some("residential"));
    assert_eq!(snapshot.map.tile(Point { x: 18, y: 6 }).unwrap().area.as_deref(), Some("commercial"));
    assert_eq!(snapshot.map.tile(Point { x: 15, y: 11 }).unwrap().area.as_deref(), Some("industrial"));

    let authored = snapshot
        .buildings
        .iter()
        .map(|building| (building.building_type.as_str(), building.origin))
        .collect::<Vec<_>>();
    assert_eq!(
        authored,
        vec![
            ("smallHouse", Point { x: 4, y: 7 }),
            ("smallHouse", Point { x: 8, y: 7 }),
            ("supermarket", Point { x: 18, y: 6 }),
            ("factory", Point { x: 15, y: 11 }),
        ]
    );

    assert!(snapshot.sims.is_empty());
    assert!(snapshot.active_trips.is_empty());
    assert!(snapshot.transit.stops.is_empty());
    assert!(snapshot.transit.stations.is_empty());
    assert!(snapshot.transit.routes.is_empty());
    assert!(snapshot.transit.metro_lines.is_empty());
    assert!(snapshot.transit.vehicles.is_empty());
    assert!(snapshot.scenario.objectives.is_none());
    assert!(snapshot.scenario.growth_waves.is_empty());

    // Successful compilation is the first routing invariant. Representative
    // building-to-building private-car paths are asserted after implementation.
    let _ = topology;
}
```

Do not add a test-only `RoadTopology` inspection API.

- [ ] **Step 3: Add failing reset and simulation-behavior coverage**

In `sandbox_engine.rs`, add Small Town reset coverage using the existing request helper:

```rust
#[test]
fn reset_replays_the_complete_original_small_town_request() {
    let request = request("smallTown", "creative", 42_000.0, 1.5);
    let expected = create_sandbox_snapshot(request.clone()).unwrap();
    let mut engine = GameEngine::from_sandbox_request(request).unwrap();

    let _ = engine.dispatch(GameIntent::SetPaused { paused: false });
    let _ = engine.tick(400.0);
    engine.set_budget_for_test(7);

    let reset = engine.reset().unwrap();

    assert_eq!(reset, expected);
    assert_eq!(engine.snapshot(), expected);
}
```

Add one real scheduler proof:

```rust
fn run_small_town_morning() -> caelum_core::model::GameSnapshot {
    let mut engine = GameEngine::from_sandbox_request(request(
        "smallTown",
        "standard",
        120_000.0,
        1.0,
    ))
    .unwrap();
    assert!(engine.dispatch(GameIntent::SetPaused { paused: false }).applied);
    assert!(engine.tick(400.0).applied);
    engine.snapshot()
}

#[test]
fn small_town_resume_uses_existing_move_in_workplace_and_commute_rules_deterministically() {
    let first = run_small_town_morning();
    let second = run_small_town_morning();

    assert_eq!(first, second);
    assert_eq!(first.sims.len(), 8);
    assert!(first.sims.iter().all(|sim| sim.workplace.is_some()));
    assert!(first.sims.iter().any(|sim| sim.outbound_resolved_today));
}
```

`400.0` seconds is deliberate: one game day is 1,200 seconds, both four-slot houses finish normal hourly move-in by 150 seconds, and the early/standard morning departure windows have begun by 400 seconds. Do not add a template-specific clock or trip trigger.

- [ ] **Step 4: Run the focused tests and verify the new identifier is currently rejected**

Run:

```bash
cargo test -p caelum-core --test sandbox_factory --test sandbox_engine
```

Expected: FAIL because `smallTown` is not yet parsed/constructed (and Step 1 references the not-yet-defined enum variant).

- [ ] **Step 5: Implement `SmallTown` with existing sandbox helpers only**

In `model.rs`, extend only the enum:

```rust
pub enum SandboxTemplateId {
    BlankGrid,
    Crossroads,
    SmallTown,
}
```

In `sandbox.rs`:

1. Import the existing `areas` and `buildings` modules/functions needed by the authored factory.
2. Add `smallTown` to `parse_template`.
3. Add `SmallTown => "smallTown"` to both persisted-rule and invariant-error string mappings.
4. Add one private constructor; do not extract a generic template builder.

Use this shape:

```rust
fn create_small_town_candidate(
    validated: ValidatedSandboxCreationRequest,
) -> Result<SandboxCandidate, SandboxCreationError> {
    let fail = || template_invariant_error(SandboxTemplateId::SmallTown);
    let mut map = blank_map();

    author_scenario_road_line(
        &mut map,
        &(3..=24).map(|x| Point { x, y: 8 }).collect::<Vec<_>>(),
        RoadPreset::TwoWay,
    );
    author_scenario_road_line(
        &mut map,
        &(2..=15).map(|y| Point { x: 14, y }).collect::<Vec<_>>(),
        RoadPreset::TwoWay,
    );
    refresh_all_automatic_junctions(&mut map).map_err(|_| fail())?;
    let road_topology = RoadTopology::compile(&map).map_err(|_| fail())?;

    let mut snapshot = snapshot_shell(validated, "Small Town", map);
    for (area, start, end) in [
        ("residential", Point { x: 4, y: 6 }, Point { x: 10, y: 7 }),
        ("commercial", Point { x: 18, y: 6 }, Point { x: 19, y: 7 }),
        ("industrial", Point { x: 15, y: 11 }, Point { x: 17, y: 12 }),
    ] {
        snapshot = areas::paint_area_rectangle(&snapshot, area, &start, &end)
            .map_err(|_| fail())?;
    }
    for (building_type, origin) in [
        ("smallHouse", Point { x: 4, y: 7 }),
        ("smallHouse", Point { x: 8, y: 7 }),
        ("supermarket", Point { x: 18, y: 6 }),
        ("factory", Point { x: 15, y: 11 }),
    ] {
        snapshot = buildings::place_building_core(&snapshot, building_type, &origin, 0)
            .map_err(|_| fail())?;
    }

    Ok(SandboxCandidate {
        snapshot,
        road_topology,
    })
}
```

Keep `create_sandbox_candidate` minimally changed:

```rust
let validated = validate_request(request)?;
if validated.template_id == SandboxTemplateId::SmallTown {
    return create_small_town_candidate(validated);
}
// Existing BlankGrid/Crossroads branch stays unchanged.
```

Do not charge `CostPolicy`, hand-author building IDs, directly push `PlacedBuilding`, directly push `Sim`, or create transit entities.

- [ ] **Step 6: Prove current private-car access through public routing behavior**

In the Small Town factory test, use the existing public traffic candidate seam rather than exposing `derive_stop_access_for_footprint` just for tests:

```rust
use caelum_core::traffic::{private_car_candidate, RoadFlow};

let flow = RoadFlow::new();
for (home, work) in [
    (Point { x: 4, y: 7 }, Point { x: 18, y: 6 }),
    (Point { x: 8, y: 7 }, Point { x: 15, y: 11 }),
] {
    assert!(private_car_candidate(&snapshot, &topology, &flow, home, work).is_some());
}
```

This simultaneously proves each representative home/workplace footprint can derive usable adjacent road access and that the authored road topology connects them. Do not make the private stop-access helper public.

- [ ] **Step 7: Generate and inspect the Small Town characterization fixture**

Run only the fixture writer:

```bash
UPDATE_SANDBOX_FIXTURE=1 cargo test -p caelum-core --test sandbox_factory sandbox_templates_match_the_reviewed_characterization_fixture -- --exact
```

Inspect `crates/caelum-core/tests/fixtures/sandbox_templates.json`. The diff must add the `smallTown` characterization while leaving `blankGrid` and `crossroads` unchanged. Confirm it records exactly four building IDs and zero sim/trip/transit IDs.

Then rerun without the update variable:

```bash
cargo test -p caelum-core --test sandbox_factory sandbox_templates_match_the_reviewed_characterization_fixture -- --exact
```

Expected: PASS.

- [ ] **Step 8: Run the complete Rust task gate**

Run:

```bash
cargo fmt --all --check
cargo test -p caelum-core --test sandbox_factory --test sandbox_engine
cargo test -p caelum-core
cargo clippy -p caelum-core --all-targets -- -D warnings
```

Expected: all PASS.

- [ ] **Step 9: Commit the Rust vertical slice**

```bash
git add \
  crates/caelum-core/src/model.rs \
  crates/caelum-core/src/sandbox.rs \
  crates/caelum-core/tests/sandbox_factory.rs \
  crates/caelum-core/tests/sandbox_engine.rs \
  crates/caelum-core/tests/fixtures/sandbox_templates.json
git commit -m "feat: add deterministic Small Town sandbox"
```

---

### Task 2: Extend the existing TypeScript/New City boundary

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/runtime/backend/types.ts`
- Modify: `src/runtime/backend/sandboxErrors.ts`
- Modify: `src/components/NewCityScreen.svelte`
- Modify: `tests/ui/appShell.test.ts`
- Modify: `tests/runtime/tauriBackend.test.ts`

**Interfaces:**
- Consumes: existing `NewCityRequest { name, economyPreset, templateId }` and existing `GameBackend.buildSandboxSnapshot(...)`
- Produces:
  - `SandboxTemplateId = "blankGrid" | "crossroads" | "smallTown"`
  - New City sends `{ templateId: "smallTown" }` through the unchanged persistence/runtime path
  - reset error guard recognizes `{ code: "templateInvariantViolation", context: { templateId: "smallTown" } }`
- No new runtime/backend method and no new Svelte component

- [ ] **Step 1: Make the existing New City form test request Small Town**

In `tests/ui/appShell.test.ts`, update only the existing `submits only trimmed name, economy, and template` case:

```ts
await fireEvent.change(screen.getByLabelText("Template"), {
  target: { value: "smallTown" },
});
await fireEvent.click(create);

expect(runtime.persistence.createCity).toHaveBeenCalledWith({
  name: "Maple Junction",
  economyPreset: "creative",
  templateId: "smallTown",
});
```

This test already owns form trimming and request shape, so do not add a second form-submit test.

- [ ] **Step 2: Add a failing reset-error guard regression**

In `tests/runtime/tauriBackend.test.ts`, add one case beside the existing invalid-restore mapping test:

```ts
it("preserves a Small Town template-invariant reset error", async () => {
  invokeMock.mockImplementation(async (command) => {
    if (command === "game_begin_runtime") {
      return { runtimeEpoch: 1, snapshot: createRustSnapshot() };
    }
    if (command === "game_reset") {
      throw {
        code: "templateInvariantViolation",
        context: { templateId: "smallTown" },
      };
    }
    return createRustSnapshot();
  });

  const backend = await createTauriBackend();
  await expect(backend.reset()).resolves.toEqual({
    ok: false,
    error: {
      code: "templateInvariantViolation",
      context: { templateId: "smallTown" },
    },
  });
});
```

This must resolve as the typed reset result shown above. A thrown value means `isSandboxResetError()` still rejects the new template ID.

- [ ] **Step 3: Run the focused frontend tests and verify they fail**

Run:

```bash
bun run test:unit -- tests/ui/appShell.test.ts tests/runtime/tauriBackend.test.ts
```

Expected: the form cannot select the unsupported `smallTown` option and/or the reset-error guard rejects `smallTown`.

- [ ] **Step 4: Extend the existing type/guard/UI seams only**

In `src/domain/types.ts`:

```ts
export type SandboxTemplateId = "blankGrid" | "crossroads" | "smallTown";
```

In `src/runtime/backend/types.ts`, extend the existing reset context literal union only:

```ts
templateId?: "blankGrid" | "crossroads" | "smallTown";
```

Keep `SandboxCreationRequest.templateId: string`; it is intentionally the raw host-boundary request contract.

In `src/runtime/backend/sandboxErrors.ts`:

```ts
return (
  !("templateId" in value.context) ||
  value.context.templateId === "blankGrid" ||
  value.context.templateId === "crossroads" ||
  value.context.templateId === "smallTown"
);
```

In `NewCityScreen.svelte`, leave the default state unchanged and add one option:

```svelte
<select bind:value={templateId}>
  <option value="crossroads">Crossroads</option>
  <option value="blankGrid">Blank Grid</option>
  <option value="smallTown">Small Town</option>
</select>
```

Do not add a template registry, label map, custom selector component, or template-specific request fields for three static options.

- [ ] **Step 5: Run the frontend task gate**

Run:

```bash
bun run test:unit -- tests/ui/appShell.test.ts tests/runtime/tauriBackend.test.ts
bun run check
bun run lint
bun run format:check
```

Expected: all PASS.

- [ ] **Step 6: Commit the TypeScript/UI boundary**

```bash
git add \
  src/domain/types.ts \
  src/runtime/backend/types.ts \
  src/runtime/backend/sandboxErrors.ts \
  src/components/NewCityScreen.svelte \
  tests/ui/appShell.test.ts \
  tests/runtime/tauriBackend.test.ts
git commit -m "feat: expose Small Town in New City"
```

---

### Task 3: Prove Small Town through the real browser/WASM New City flow

**Files:**
- Modify: `tests/e2e/newCity.spec.ts`

**Interfaces:**
- Consumes: existing `runtimeSnapshot(page): Promise<RuntimeSnapshot>` and the real browser `buildSandboxSnapshot → createCity → restoreSnapshot` flow
- Produces: one Chromium regression proving the UI sends `smallTown` and the shared Rust/WASM factory supplies the authored snapshot to the live game shell
- Does not add IndexedDB utilities; the existing default-city test remains the persistence-owner test

- [ ] **Step 1: Add the Small Town E2E test**

Append one test to `tests/e2e/newCity.spec.ts`:

```ts
test("creates Small Town through the real WASM New City flow", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("new-city-screen")).toBeVisible();

  await page.getByLabel("City name").fill("Small Town Smoke");
  await page.getByLabel("Template").selectOption("smallTown");
  await page.getByRole("button", { name: "Create City" }).click();
  await expect(page.getByTestId("game-canvas-host")).toBeVisible();

  const snapshot = await runtimeSnapshot(page);
  expect(snapshot.state.rules.sandbox.templateId).toBe("smallTown");
  expect(snapshot.state.scenario.name).toBe("Small Town");
  expect(snapshot.state.paused).toBe(true);
  expect(snapshot.state.sims).toEqual([]);
  expect(snapshot.state.activeTrips).toEqual([]);
  expect(snapshot.state.transit.routes).toEqual([]);
  expect(snapshot.state.transit.metroLines).toEqual([]);
  expect(snapshot.state.transit.vehicles).toEqual([]);
  expect(
    snapshot.state.buildings.map(({ buildingType, origin }) => ({
      buildingType,
      origin,
    })),
  ).toEqual([
    { buildingType: "smallHouse", origin: { x: 4, y: 7 } },
    { buildingType: "smallHouse", origin: { x: 8, y: 7 } },
    { buildingType: "supermarket", origin: { x: 18, y: 6 } },
    { buildingType: "factory", origin: { x: 15, y: 11 } },
  ]);
});
```

Keep this integration assertion intentionally narrower than the Rust structural test: it proves the new identifier crossed Svelte → runtime → real WASM → Rust and that the authored city reached the rendered game shell. Do not duplicate the full road/zone matrix or the IndexedDB transaction checks here.

- [ ] **Step 2: Run the focused browser proof**

Run:

```bash
bun run test:e2e -- tests/e2e/newCity.spec.ts
```

Expected: PASS for both the existing default-city/IndexedDB proof and the new Small Town proof.

- [ ] **Step 3: Run the final cross-stack verification gate**

Run from repository root:

```bash
cargo fmt --all --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
bun run test:unit
bun run check
bun run lint
bun run format:check
bun run test:e2e
bun run build
```

Expected: all PASS.

Do not add a packaged-Tauri manual gate for HPA-350. Tauri and WASM already share the same Rust factory, Task 2 covers native reset-error decoding, and HPA-349 already proved the host composition. A second packaged restart journey would not test a unique Small Town risk.

- [ ] **Step 4: Review the final diff against the scope boundary**

Run:

```bash
git diff main...HEAD --stat
git diff main...HEAD -- \
  crates/caelum-core/src/model.rs \
  crates/caelum-core/src/sandbox.rs \
  src/domain/types.ts \
  src/runtime/backend/types.ts \
  src/runtime/backend/sandboxErrors.ts \
  src/components/NewCityScreen.svelte \
  tests/e2e/newCity.spec.ts
```

Confirm there is no schema/storage version change, no new dependency, no direct `Sim` construction, no public-transit seed, no generic template abstraction, and no unrelated Phase 4 behavior.

- [ ] **Step 5: Commit the browser integration proof**

```bash
git add tests/e2e/newCity.spec.ts
git commit -m "test: cover Small Town browser creation"
```

---

## Planned Commit Sequence

1. `feat: add deterministic Small Town sandbox`
2. `feat: expose Small Town in New City`
3. `test: cover Small Town browser creation`

The first commit is the authoritative gameplay slice, the second is the thin frontend/host contract extension, and the third is the real browser composition proof. Do not split setup-only commits or create a second implementation branch just for the UI.

## Plan Self-Review

### Spec coverage

- Third template ID and reset reconstruction: Task 1.
- Exact 28×18 roads/zones/four buildings: Task 1 structural test + factory.
- Cost-free authored content and Standard/Creative parity: existing settings test extended to `smallTown` in Task 1.
- Zero initial residents/transit/scripted growth: Task 1 structural test and Task 3 browser proof.
- Existing move-in/workplace/commute behavior after Resume: Task 1 `GameEngine` behavior test.
- Usable private-car road access without new metadata: Task 1 public `private_car_candidate` checks.
- Deterministic initial and replay behavior: existing repeated-construction loop + Task 1 two-engine comparison.
- New City option/request: Task 2.
- Small Town reset-error decoding: Task 2.
- Real WASM/browser creation and live game-shell snapshot: Task 3.
- No compatibility/version/framework work: Global Constraints + final scope review.

### Placeholder scan

No `TBD`, `TODO`, “implement later”, generic “add validation”, test-only helper invention, or unspecified test task remains.

### Type consistency

- Rust uses existing `SandboxCreationRequest.template_id: String` and new `SandboxTemplateId::SmallTown`.
- Frontend player-facing type uses `SandboxTemplateId = "blankGrid" | "crossroads" | "smallTown"`.
- Raw backend creation request remains `templateId: string` by design.
- Reset error context is extended to the same three serialized template strings.
- Svelte submits the unchanged `NewCityRequest` shape; no extra field is introduced.

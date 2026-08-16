# Deterministic Small Town Sandbox Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `smallTown` as a deterministic Rust-owned starting template that opens as a compact four-building town and produces normal move-in/workplace/commute demand after Resume.

**Architecture:** Extend the existing sandbox enum/factory rather than introducing another template layer. Rust authors fixed roads, areas, and buildings with existing core helpers; the existing simulation creates residents and trips after time resumes. TypeScript only accepts/presents the new identifier, including the existing exhaustive template-label map, and one real-WASM browser test proves the existing New City path reaches the authored snapshot.

**Tech Stack:** Rust (`caelum-core`, serde, Cargo tests), TypeScript/Svelte 5, Vitest + Testing Library, Playwright, existing WASM/Tauri backend contracts.

## Global Constraints

- `smallTown` is the third template beside `blankGrid` and `crossroads`; keep Crossroads as the existing default.
- Keep the existing 28×18 map; do not add map-size configuration.
- Main Street is a two-way stroke from `(3, 8)` through `(24, 8)`.
- Cross Street is a two-way stroke from `(14, 2)` through `(14, 15)`.
- Paint authored areas only after the road topology is compiled and the normal snapshot shell exists; place buildings only after their required areas exist.
- Author exactly 2 Small Houses, 1 Supermarket, and 1 Factory at the approved coordinates, all with rotation `0`; no other buildings.
- Start with zero sims, active trips, stops, stations, routes, metro lines, vehicles, objectives, and growth waves.
- Do not seed `Sim` values. Existing `apply_due_move_ins`, worker-profile/shift assignment, `assign_workplaces`, and commute scheduling remain authoritative.
- Authored roads/areas/buildings are template content and must not deduct from the requested starting budget.
- Standard and Creative use identical authored content and preserve the requested starting budget/rules.
- Do not add a Small Town production validator mirroring `validate_crossroads_candidate`; factory-time failures already map to `TemplateInvariantViolation`, while structural tests own the detailed geometry proof.
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
  - Prove reset and real Resume → move-in → workplace → commute behavior through `GameEngine`, using an explicit clock-minute target derived from the public game-clock constants.
- Modify `crates/caelum-core/tests/fixtures/sandbox_templates.json`
  - Add the generated reviewed characterization for `smallTown`; do not hand-maintain IDs.

### TypeScript/UI boundary

- Modify `src/domain/types.ts`
  - Add `"smallTown"` to `SandboxTemplateId`.
- Modify `src/runtime/runtimeSelectors.ts`
  - Extend the existing exhaustive `SANDBOX_TEMPLATE_LABELS: Record<SandboxTemplateId, string>` with `smallTown: "Small Town"` so the City shell continues to render the template name and `bun run check` stays exhaustive.
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
  - `clock::{GAME_DAY_SECONDS, MINUTES_PER_DAY}` for test-only named clock targets
  - existing `GameEngine::from_sandbox_request`, `GameEngine::dispatch`, `GameEngine::tick`, and `GameEngine::reset`
- Produces:
  - `SandboxTemplateId::SmallTown`, serialized by the existing camelCase serde rule as `smallTown`
  - existing `create_sandbox_snapshot(SandboxCreationRequest)` accepts `template_id: "smallTown"`
  - existing persisted-rule reset path reconstructs `SmallTown`
  - no new public Rust API

- [ ] **Step 1: Add failing factory coverage for the third template**

In `crates/caelum-core/tests/sandbox_factory.rs`, extend the existing template loops and template-ID match:

```rust
for template in ["blankGrid", "crossroads", "smallTown"] {
    let first = create_sandbox_snapshot(request(template)).unwrap();
    let second = create_sandbox_snapshot(request(template)).unwrap();
    assert_eq!(first, second);
}
```

and in the settings test:

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

- [ ] **Step 2: Add a failing Small Town structural/access test**

Add one focused test in `sandbox_factory.rs`. Keep assertions on promised public structure rather than copying Crossroads’ production validator:

```rust
use caelum_core::traffic::{private_car_candidate, RoadFlow};

#[test]
fn small_town_has_authored_structure_and_connected_building_access() {
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

    assert_eq!(
        snapshot.map.tile(Point { x: 4, y: 6 }).unwrap().area.as_deref(),
        Some("residential")
    );
    assert_eq!(
        snapshot.map.tile(Point { x: 18, y: 6 }).unwrap().area.as_deref(),
        Some("commercial")
    );
    assert_eq!(
        snapshot.map.tile(Point { x: 15, y: 11 }).unwrap().area.as_deref(),
        Some("industrial")
    );

    let authored = snapshot
        .buildings
        .iter()
        .map(|building| (building.building_type.as_str(), building.origin, building.rotation))
        .collect::<Vec<_>>();
    assert_eq!(
        authored,
        vec![
            ("smallHouse", Point { x: 4, y: 7 }, 0),
            ("smallHouse", Point { x: 8, y: 7 }, 0),
            ("supermarket", Point { x: 18, y: 6 }, 0),
            ("factory", Point { x: 15, y: 11 }, 0),
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

    let flow = RoadFlow::new();
    for (home, work) in [
        (Point { x: 4, y: 7 }, Point { x: 18, y: 6 }),
        (Point { x: 8, y: 7 }, Point { x: 15, y: 11 }),
    ] {
        assert!(private_car_candidate(&snapshot, &topology, &flow, home, work).is_some());
    }
}
```

The two private-car candidates cover all four authored buildings and prove both footprint road access and connected road topology through an existing public integration seam. Do not expose `stop_access` or add a test-only topology API.

- [ ] **Step 3: Add failing reset and named-morning scheduler coverage**

In `sandbox_engine.rs`, import the public clock constants and `WorkerProfile`:

```rust
use caelum_core::clock::{GAME_DAY_SECONDS, MINUTES_PER_DAY};
use caelum_core::model::{GameMode, Point, WorkerProfile};

const MORNING_CLOCK_MINUTE: u16 = 480; // 08:00

fn seconds_at_clock_minute(minute: u16) -> f64 {
    GAME_DAY_SECONDS * f64::from(minute) / f64::from(MINUTES_PER_DAY)
}
```

Add Small Town reset coverage:

```rust
#[test]
fn reset_replays_the_complete_original_small_town_request() {
    let request = request("smallTown", "creative", 42_000.0, 1.5);
    let expected = create_sandbox_snapshot(request.clone()).unwrap();
    let mut engine = GameEngine::from_sandbox_request(request).unwrap();

    let _ = engine.dispatch(GameIntent::SetPaused { paused: false });
    let _ = engine.tick(seconds_at_clock_minute(MORNING_CLOCK_MINUTE));
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
    assert!(engine
        .tick(seconds_at_clock_minute(MORNING_CLOCK_MINUTE))
        .applied);
    engine.snapshot()
}

#[test]
fn small_town_resume_uses_existing_move_in_workplace_and_commute_rules_deterministically() {
    let first = run_small_town_morning();
    let second = run_small_town_morning();

    assert_eq!(first, second);
    assert_eq!(first.clock_minutes, MORNING_CLOCK_MINUTE);
    assert_eq!(first.sims.len(), 8);

    let workers = first
        .sims
        .iter()
        .filter(|sim| sim.worker_profile == WorkerProfile::Worker)
        .collect::<Vec<_>>();
    assert!(!workers.is_empty());
    assert!(workers.iter().all(|sim| sim.workplace.is_some()));

    assert!(
        !first.active_trips.is_empty()
            || first.sims.iter().any(|sim| sim.outbound_resolved_today)
    );
}
```

The test names the intended 08:00 clock invariant instead of embedding `400.0`. With the current 1,200-second game day this still advances 400 simulation seconds, but future clock/window changes will make the assumption visible at the test boundary. The two four-slot houses complete their existing 50-second occupancy cadence well before this target; do not add a template-specific clock or trip trigger.

- [ ] **Step 4: Run focused Rust tests and verify the new identifier is rejected**

Run:

```bash
cargo test -p caelum-core --test sandbox_factory --test sandbox_engine
```

Expected: FAIL because `smallTown` is not yet parsed/constructed and the tests reference the not-yet-defined enum variant.

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
3. Add `SmallTown => "smallTown"` to persisted-rule and invariant-error string mappings.
4. Add one private constructor; do not extract a generic template builder or Small Town validator.

Use this exact construction order:

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

Do not charge `CostPolicy`, hand-author building IDs, directly push `PlacedBuilding`, directly push `Sim`, create transit entities, or duplicate `validate_crossroads_candidate` for this simple plus-shaped topology.

- [ ] **Step 6: Generate and inspect the characterization fixture**

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

- [ ] **Step 7: Run the complete Rust task gate**

Run:

```bash
cargo fmt --all --check
cargo test -p caelum-core --test sandbox_factory --test sandbox_engine
cargo test -p caelum-core
cargo clippy -p caelum-core --all-targets -- -D warnings
```

Expected: all PASS.

- [ ] **Step 8: Commit the Rust vertical slice**

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
- Modify: `src/runtime/runtimeSelectors.ts`
- Modify: `src/runtime/backend/types.ts`
- Modify: `src/runtime/backend/sandboxErrors.ts`
- Modify: `src/components/NewCityScreen.svelte`
- Modify: `tests/ui/appShell.test.ts`
- Modify: `tests/runtime/tauriBackend.test.ts`

**Interfaces:**
- Consumes: existing `NewCityRequest { name, economyPreset, templateId }`, `SANDBOX_TEMPLATE_LABELS`, and existing `GameBackend.buildSandboxSnapshot(...)`
- Produces:
  - `SandboxTemplateId = "blankGrid" | "crossroads" | "smallTown"`
  - existing template label map contains `smallTown: "Small Town"`
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

A thrown value means `isSandboxResetError()` still rejects the new template ID.

- [ ] **Step 3: Run focused frontend tests and verify the new option/guard are red**

Run:

```bash
bun run test:unit -- tests/ui/appShell.test.ts tests/runtime/tauriBackend.test.ts
```

Expected: FAIL because the form does not contain the `smallTown` option and/or the reset-error guard rejects the new template ID.

- [ ] **Step 4: Expand the player-facing template union and let exhaustiveness reveal the existing label seam**

In `src/domain/types.ts`, make only this change first:

```ts
export type SandboxTemplateId = "blankGrid" | "crossroads" | "smallTown";
```

Then run:

```bash
bun run check
```

Expected: FAIL at the exhaustive `SANDBOX_TEMPLATE_LABELS: Record<SandboxTemplateId, string>` in `src/runtime/runtimeSelectors.ts` because `smallTown` is missing. This is an existing compile-time identity seam, not a reason to add a template registry.

- [ ] **Step 5: Extend the existing type/label/guard/UI seams only**

In `src/runtime/runtimeSelectors.ts`:

```ts
const SANDBOX_TEMPLATE_LABELS: Record<SandboxTemplateId, string> = {
  blankGrid: "Blank Grid",
  crossroads: "Crossroads",
  smallTown: "Small Town",
};
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

Do not add another label map or template registry; extend the existing selector and the existing exhaustive presentation map only.

- [ ] **Step 6: Run the frontend task gate**

Run:

```bash
bun run test:unit -- tests/ui/appShell.test.ts tests/runtime/tauriBackend.test.ts
bun run check
bun run lint
bun run format:check
```

Expected: all PASS.

- [ ] **Step 7: Commit the TypeScript/UI boundary**

```bash
git add \
  src/domain/types.ts \
  src/runtime/runtimeSelectors.ts \
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

Do not add a packaged-Tauri manual gate for HPA-350. Tauri and WASM already share the same Rust factory, Task 2 covers native reset-error decoding, and HPA-349 already owns packaged-host composition evidence. A second packaged restart journey would not test a unique Small Town risk.

- [ ] **Step 4: Review the final diff against the scope boundary**

Run:

```bash
git diff main...HEAD --stat
git diff main...HEAD -- \
  crates/caelum-core/src/model.rs \
  crates/caelum-core/src/sandbox.rs \
  src/domain/types.ts \
  src/runtime/runtimeSelectors.ts \
  src/runtime/backend/types.ts \
  src/runtime/backend/sandboxErrors.ts \
  src/components/NewCityScreen.svelte \
  tests/e2e/newCity.spec.ts
```

Confirm there is no schema/storage version change, no new dependency, no direct `Sim` construction, no public-transit seed, no generic template abstraction, no copied Small Town production validator, and no unrelated Phase 4 behavior.

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
- Exact 28×18 roads/zones/four rotation-0 buildings: Task 1 structural test + factory.
- Required paint-before-place construction order: Task 1 exact factory sequence.
- Cost-free authored content and Standard/Creative parity: existing settings test extended to `smallTown` in Task 1.
- Zero initial residents/transit/scripted growth: Task 1 structural test and Task 3 browser proof.
- Existing move-in/workplace/commute behavior after Resume: Task 1 named-08:00 `GameEngine` behavior test.
- Usable private-car road access without new metadata: Task 1 public `private_car_candidate` checks.
- Deterministic initial and replay behavior: existing repeated-construction loop + Task 1 two-engine comparison.
- New City option/request: Task 2.
- Existing exhaustive City/template label: Task 2 `SANDBOX_TEMPLATE_LABELS` extension, compile-enforced by `bun run check`.
- Small Town reset-error decoding: Task 2.
- Real WASM/browser creation and live game-shell snapshot: Task 3.
- No copied production Small Town validator: Global Constraints + Task 1 implementation/final diff review.
- No compatibility/version/framework work: Global Constraints + final scope review.

### Placeholder scan

No `TBD`, `TODO`, “implement later”, generic “add validation”, test-only helper invention, or unspecified test task remains.

### Type consistency

- Rust uses existing `SandboxCreationRequest.template_id: String` and new `SandboxTemplateId::SmallTown`.
- Frontend player-facing type uses `SandboxTemplateId = "blankGrid" | "crossroads" | "smallTown"`.
- Existing `SANDBOX_TEMPLATE_LABELS` remains exhaustive over the same three player-facing values.
- Raw backend creation request remains `templateId: string` by design.
- Reset error context is extended to the same three serialized template strings.
- Svelte submits the unchanged `NewCityRequest` shape; no extra field is introduced.

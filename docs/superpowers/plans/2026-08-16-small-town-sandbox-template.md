# Deterministic Small Town Sandbox Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `smallTown` as a deterministic Rust-owned starting template that opens as a compact four-building town and produces normal move-in/workplace/commute demand after Resume.

**Architecture:** Extend the existing sandbox enum/factory rather than introducing another template layer. Rust authors the fixed roads, areas, and buildings with existing core helpers; the existing simulation creates residents and trips after time resumes. TypeScript only accepts/presents the new identifier through existing exhaustive seams, and one real-WASM browser test proves the New City path reaches the authored snapshot.

**Tech Stack:** Rust (`caelum-core`, serde, Cargo tests), TypeScript/Svelte 5, Vitest + Testing Library, Playwright, existing WASM/Tauri backend contracts.

## Global Constraints

- `smallTown` is the third template beside `blankGrid` and `crossroads`; Crossroads remains the default.
- Keep the existing 28×18 map.
- Main Street is `RoadPreset::TwoWay` from `(3, 8)` through `(24, 8)`.
- Cross Street is `RoadPreset::TwoWay` from `(14, 2)` through `(14, 15)`.
- Author exactly 2 Small Houses, 1 Supermarket, and 1 Factory at the approved coordinates, all with rotation `0`.
- Construction order is roads → automatic-junction refresh → topology compile → `snapshot_shell("Small Town")` → area painting → uncosted building placement.
- Start with zero sims, active trips, stops, stations, routes, metro lines, vehicles, objectives, and growth waves.
- Do not seed `Sim` values. Existing move-in, worker profile/shift assignment, workplace assignment, and commute scheduling remain authoritative.
- Authored roads/areas/buildings are template content and must not deduct from the requested starting budget.
- Standard and Creative use identical authored content and preserve requested rules/budget.
- Do not copy `validate_crossroads_candidate`; Small Town uses existing invariant errors plus structural/access tests.
- Do not add a template DSL/builder/registry, resident-seeding API, template-specific scheduler hook, new host API, dependency, save migration, compatibility reader, schema/storage version bump, or additional Phase 4 fleet/timetable machinery.
- Keep schema/storage at v7.

---

## File Structure

### Rust authority

- Modify `crates/caelum-core/src/model.rs`
  - Add `SandboxTemplateId::SmallTown`.
- Modify `crates/caelum-core/src/sandbox.rs`
  - Extend the existing exhaustive factory/reset/parser/error matches.
  - Add one private `create_small_town_candidate(...)` helper.
- Modify `crates/caelum-core/tests/sandbox_factory.rs`
  - Extend deterministic/settings/fixture coverage and add one structural/access test.
- Modify `crates/caelum-core/tests/sandbox_engine.rs`
  - Add Small Town reset and real Resume → move-in → workplace → outbound commute coverage.
- Modify `crates/caelum-core/tests/sandbox_coverage.rs`
  - Extend the “all templates” reset coverage and refresh the file’s now-stale `sandbox.rs` line references after the new factory code lands.
- Modify `crates/caelum-core/tests/fixtures/sandbox_templates.json`
  - Add generated `smallTown` characterization.

### TypeScript/UI boundary

- Modify `src/domain/types.ts`
  - Add `"smallTown"` to `SandboxTemplateId`.
- Modify `src/runtime/runtimeSelectors.ts`
  - Extend exhaustive `SANDBOX_TEMPLATE_LABELS` with `smallTown: "Small Town"`.
- Modify `src/runtime/backend/types.ts`
  - Accept `"smallTown"` in `SandboxResetError.context.templateId`.
- Modify `src/runtime/backend/sandboxErrors.ts`
  - Accept `smallTown` in the existing reset-error guard.
- Modify `src/components/NewCityScreen.svelte`
  - Add the `Small Town` option while keeping `crossroads` as default.
- Modify `tests/ui/appShell.test.ts`
  - Assert all three template options remain present, then submit `smallTown` through the existing form-shape test.
- Modify `tests/runtime/tauriBackend.test.ts`
  - Add one Small Town reset-error decoding regression.

### Browser integration

- Modify `tests/e2e/newCity.spec.ts`
  - Add one real-WASM Small Town creation proof using `runtimeSnapshot(page)`.
  - Assert integration identity/state only; Rust owns exact authored coordinates.

---

### Task 1: Add the Rust-owned Small Town factory and behavioral proof

**Files:**
- Modify: `crates/caelum-core/src/model.rs`
- Modify: `crates/caelum-core/src/sandbox.rs`
- Modify: `crates/caelum-core/tests/sandbox_factory.rs`
- Modify: `crates/caelum-core/tests/sandbox_engine.rs`
- Modify: `crates/caelum-core/tests/sandbox_coverage.rs`
- Modify: `crates/caelum-core/tests/fixtures/sandbox_templates.json`

**Interfaces:**
- Consumes:
  - `author_scenario_road_line(map: &mut GameMap, points: &[Point], preset: RoadPreset)`
  - `refresh_all_automatic_junctions(map: &mut GameMap) -> GameplayResult<()>`
  - `areas::paint_area_rectangle(...) -> GameplayResult<GameSnapshot>`
  - `buildings::place_building_core(...) -> GameplayResult<GameSnapshot>`
  - `RoadTopology::compile(&GameMap)`
  - `traffic::private_car_candidate(...)`
  - `clock::{GAME_DAY_SECONDS, MINUTES_PER_DAY}`
  - existing `GameEngine::{from_sandbox_request, dispatch, tick, reset}`
- Produces:
  - `SandboxTemplateId::SmallTown`, serialized as `smallTown`
  - existing sandbox factory/reset paths support `smallTown`
  - no new public Rust API

- [ ] **Step 1: Add failing third-template factory and coverage-loop tests**

In `crates/caelum-core/tests/sandbox_factory.rs`, extend the existing template loops:

```rust
for template in ["blankGrid", "crossroads", "smallTown"] {
    let first = create_sandbox_snapshot(request(template)).unwrap();
    let second = create_sandbox_snapshot(request(template)).unwrap();
    assert_eq!(first, second);
}
```

Extend the settings test’s template match:

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

In `crates/caelum-core/tests/sandbox_coverage.rs`, rename the reset happy-path test and extend its loop:

```rust
#[test]
fn reset_replays_validated_rules_for_all_templates_without_entering_error_mapper() {
    for template in ["blankGrid", "crossroads", "smallTown"] {
        let req = request(template, 42_000.0);
        let expected = create_sandbox_snapshot(req.clone()).unwrap();
        let mut engine = GameEngine::from_sandbox_request(req).unwrap();

        engine.set_budget_for_test(7);
        let _ = engine.dispatch(GameIntent::LayRoad {
            point: Point { x: 3, y: 3 },
        });

        let reset = engine.reset().unwrap();
        assert_eq!(reset, expected);
        assert_eq!(engine.snapshot(), expected);
    }
}
```

Do not update the characterization fixture yet.

- [ ] **Step 2: Add a failing Small Town structural/access test**

In `sandbox_factory.rs`, add one focused public-behavior test:

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

The two candidates cover all four authored buildings and prove existing footprint-road-access plus connected topology without exposing `stop_access` or adding a test-only topology API.

- [ ] **Step 3: Add failing reset and named-morning scheduler coverage**

In `sandbox_engine.rs`, import the public clock constants plus the model enums used by the assertion:

```rust
use caelum_core::clock::{GAME_DAY_SECONDS, MINUTES_PER_DAY};
use caelum_core::model::{GameMode, Point, TripPurpose, WorkerProfile};

const MORNING_CLOCK_MINUTE: u16 = 480; // 08:00

fn seconds_at_clock_minute(minute: u16) -> f64 {
    GAME_DAY_SECONDS * f64::from(minute) / f64::from(MINUTES_PER_DAY)
}
```

Add reset coverage:

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

Add the real commute proof:

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
    assert_eq!(workers.len(), 8);
    assert!(workers.iter().all(|sim| sim.workplace.is_some()));

    assert!(first.active_trips.iter().any(|trip| {
        trip.purpose == TripPurpose::CommuteOutbound
    }));
}
```

This assertion is intentionally stronger than checking `outbound_resolved_today`: that flag is also used by skip/guard paths and therefore is not proof that a commute spawned. At 08:00, the existing move-in/departure substep boundaries have populated the two houses and started outbound trips without any Small Town-specific scheduler behavior.

- [ ] **Step 4: Run the focused Rust tests and verify the new identifier is red**

Run:

```bash
cargo test -p caelum-core \
  --test sandbox_factory \
  --test sandbox_engine \
  --test sandbox_coverage
```

Expected: FAIL because `smallTown` is not yet parsed/constructed and the tests reference the not-yet-defined enum variant.

- [ ] **Step 5: Implement `SmallTown` as a real exhaustive factory arm**

In `model.rs`:

```rust
pub enum SandboxTemplateId {
    BlankGrid,
    Crossroads,
    SmallTown,
}
```

In `sandbox.rs`, keep the existing exhaustive `match validated.template_id`. Add Small Town as a real arm; do **not** use an early `if` followed by a two-arm match, and do **not** add `_ => unreachable!()`:

```rust
let (name, map, road_topology) = match validated.template_id {
    SandboxTemplateId::BlankGrid => {
        // existing arm unchanged
    }
    SandboxTemplateId::Crossroads => {
        // existing arm unchanged
    }
    SandboxTemplateId::SmallTown => return create_small_town_candidate(validated),
};
```

Because `SandboxTemplateId` is `Copy`, matching `validated.template_id` does not consume the request; moving `validated` only in the divergent Small Town arm is valid while the existing arms still reach the shared `snapshot_shell(validated, ...)` tail.

Add the private helper with the approved construction order:

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

Extend every existing exhaustive template-string match rather than adding a catch-all. In particular:

```rust
match rules.sandbox.template_id {
    SandboxTemplateId::BlankGrid => "blankGrid",
    SandboxTemplateId::Crossroads => "crossroads",
    SandboxTemplateId::SmallTown => "smallTown",
}
```

and extend `parse_template` plus `template_invariant_error` with `SmallTown` / `"smallTown"`.

Do not charge `CostPolicy`, hand-author entity IDs, directly push `PlacedBuilding`/`Sim`, create transit entities, or add a Small Town production validator.

- [ ] **Step 6: Refresh `sandbox_coverage.rs` against the changed source layout**

The file intentionally documents llvm-cov gaps using `sandbox.rs` line numbers, so inserting the Small Town helper makes its existing numeric references stale.

Run:

```bash
nl -ba crates/caelum-core/src/sandbox.rs | sed -n '110,620p'
```

Update every `sandbox.rs` numeric reference in the module doc so it points to the same named code path after the insertion:

- `sandbox_reset_error_from_creation_error` block and its unreachable arms;
- `validate_crossroads_candidate` missing-tile branch;
- `template_invariant_error` arms;
- `parse_starting_capital` impossible constructor-error closure;
- the defensive `_ => unreachable!()` inside the in-crate test module.

Add the new `SmallTown` `template_invariant_error` arm to the unreachable-line analysis if llvm-cov reports it uncovered: it can execute only if fixed developer-authored road/area/building construction fails, which public valid input cannot induce without a code defect.

Do not add a second defensive wildcard match just to silence coverage.

- [ ] **Step 7: Generate and inspect the characterization fixture**

Run:

```bash
UPDATE_SANDBOX_FIXTURE=1 cargo test -p caelum-core \
  --test sandbox_factory \
  sandbox_templates_match_the_reviewed_characterization_fixture \
  -- --exact
```

Inspect `crates/caelum-core/tests/fixtures/sandbox_templates.json`. The diff must add only the `smallTown` characterization; `blankGrid` and `crossroads` remain unchanged. Confirm exactly four building IDs and zero sim/trip/transit IDs.

Then rerun without the update variable:

```bash
cargo test -p caelum-core \
  --test sandbox_factory \
  sandbox_templates_match_the_reviewed_characterization_fixture \
  -- --exact
```

Expected: PASS.

- [ ] **Step 8: Run the complete Rust task gate**

Run:

```bash
cargo fmt --all --check
cargo test -p caelum-core \
  --test sandbox_factory \
  --test sandbox_engine \
  --test sandbox_coverage
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
  crates/caelum-core/tests/sandbox_coverage.rs \
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
- Consumes: existing `NewCityRequest { name, economyPreset, templateId }`, exhaustive `SANDBOX_TEMPLATE_LABELS`, and existing `GameBackend.buildSandboxSnapshot(...)`
- Produces:
  - `SandboxTemplateId = "blankGrid" | "crossroads" | "smallTown"`
  - existing template label map contains `smallTown: "Small Town"`
  - New City sends `{ templateId: "smallTown" }` through the unchanged runtime path
  - reset error guard recognizes `{ code: "templateInvariantViolation", context: { templateId: "smallTown" } }`
- No new runtime/backend method and no new Svelte component

- [ ] **Step 1: Extend the existing New City form test without dropping Blank Grid coverage**

In `tests/ui/appShell.test.ts`, keep the existing `submits only trimmed name, economy, and template` test. Before changing the selection, assert the complete option set:

```ts
const templateSelect = screen.getByLabelText("Template");
expect(
  within(templateSelect)
    .getAllByRole("option")
    .map((option) => (option as HTMLOptionElement).value),
).toEqual(["crossroads", "blankGrid", "smallTown"]);

await fireEvent.input(screen.getByLabelText("City name"), {
  target: { value: "  Maple Junction  " },
});
await fireEvent.change(screen.getByLabelText("Economy"), {
  target: { value: "creative" },
});
await fireEvent.change(templateSelect, {
  target: { value: "smallTown" },
});
await fireEvent.click(create);

expect(runtime.persistence.createCity).toHaveBeenCalledWith({
  name: "Maple Junction",
  economyPreset: "creative",
  templateId: "smallTown",
});
```

This keeps one test responsible for the current static option inventory and request shape; do not add a separate template-selector test.

- [ ] **Step 2: Add a failing reset-error guard regression**

In `tests/runtime/tauriBackend.test.ts`:

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

- [ ] **Step 3: Run focused frontend tests and verify the new option/guard are red**

Run:

```bash
bun run test:unit -- tests/ui/appShell.test.ts tests/runtime/tauriBackend.test.ts
```

Expected: FAIL because the form lacks `smallTown` and/or the reset guard rejects it.

- [ ] **Step 4: Expand the player-facing union and let exhaustiveness expose the existing label seam**

In `src/domain/types.ts`:

```ts
export type SandboxTemplateId = "blankGrid" | "crossroads" | "smallTown";
```

Then run:

```bash
bun run check
```

Expected: FAIL at `SANDBOX_TEMPLATE_LABELS: Record<SandboxTemplateId, string>` in `src/runtime/runtimeSelectors.ts` because `smallTown` is missing. Do not replace that exhaustiveness with a registry or fallback.

- [ ] **Step 5: Extend the existing type/label/guard/UI seams only**

In `src/runtime/runtimeSelectors.ts`:

```ts
const SANDBOX_TEMPLATE_LABELS: Record<SandboxTemplateId, string> = {
  blankGrid: "Blank Grid",
  crossroads: "Crossroads",
  smallTown: "Small Town",
};
```

In `src/runtime/backend/types.ts`:

```ts
templateId?: "blankGrid" | "crossroads" | "smallTown";
```

Keep `SandboxCreationRequest.templateId: string`; it remains the raw host-boundary request contract.

In `src/runtime/backend/sandboxErrors.ts`:

```ts
return (
  !("templateId" in value.context) ||
  value.context.templateId === "blankGrid" ||
  value.context.templateId === "crossroads" ||
  value.context.templateId === "smallTown"
);
```

In `NewCityScreen.svelte`, leave the default state unchanged and extend the existing select:

```svelte
<option value="crossroads">Crossroads</option>
<option value="blankGrid">Blank Grid</option>
<option value="smallTown">Small Town</option>
```

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
- Consumes: existing `runtimeSnapshot(page): Promise<RuntimeSnapshot>` and the real browser New City → WASM sandbox build → persistence activation flow
- Produces: one Chromium regression proving `smallTown` crossed Svelte → runtime → WASM → Rust and reached the rendered game shell
- Exact authored coordinates remain Rust-test/fixture ownership

- [ ] **Step 1: Add the integration-only Small Town E2E**

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
  expect(snapshot.state.buildings).toHaveLength(4);
  expect(snapshot.state.sims).toEqual([]);
  expect(snapshot.state.activeTrips).toEqual([]);
  expect(snapshot.state.transit.stops).toEqual([]);
  expect(snapshot.state.transit.stations).toEqual([]);
  expect(snapshot.state.transit.routes).toEqual([]);
  expect(snapshot.state.transit.metroLines).toEqual([]);
  expect(snapshot.state.transit.vehicles).toEqual([]);
});
```

Do not repeat building origins, road coordinates, zone rectangles, or IndexedDB transaction assertions here. Rust structural/fixture coverage owns content identity; the existing default-city test owns raw IndexedDB persistence.

- [ ] **Step 2: Run the focused browser proof**

Run:

```bash
bun run test:e2e -- tests/e2e/newCity.spec.ts
```

Expected: PASS for the existing default-city persistence proof and the new Small Town composition proof.

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

Do not add a packaged-Tauri gate. WASM and Tauri already share the Rust sandbox factory; Task 2 covers the unique native reset-error decoder change.

- [ ] **Step 4: Review the final diff against the scope boundary**

Run:

```bash
git diff main...HEAD --stat
git diff main...HEAD -- \
  crates/caelum-core/src/model.rs \
  crates/caelum-core/src/sandbox.rs \
  crates/caelum-core/tests/sandbox_factory.rs \
  crates/caelum-core/tests/sandbox_engine.rs \
  crates/caelum-core/tests/sandbox_coverage.rs \
  src/domain/types.ts \
  src/runtime/runtimeSelectors.ts \
  src/runtime/backend/types.ts \
  src/runtime/backend/sandboxErrors.ts \
  src/components/NewCityScreen.svelte \
  tests/ui/appShell.test.ts \
  tests/runtime/tauriBackend.test.ts \
  tests/e2e/newCity.spec.ts
```

Confirm there is no schema/storage version change, dependency change, direct `Sim` construction, seeded public transit, generic template abstraction, copied Small Town validator, or unrelated Phase 4 behavior.

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

The first commit owns the authoritative gameplay slice, the second owns the thin frontend/host identity extension, and the third owns only the real browser composition proof.

## Review Decisions

- **Accepted:** Small Town must be an exhaustive `create_sandbox_candidate` match arm; no wildcard catch-all.
- **Accepted:** the morning acceptance test requires a real `TripPurpose::CommuteOutbound` active trip and exactly 8 current workers, not `outbound_resolved_today` as a proxy.
- **Accepted:** `sandbox_coverage.rs` is part of the Rust blast radius because its “both templates” loop and numeric `sandbox.rs` references become stale.
- **Accepted:** Playwright checks template identity + four-building count, not duplicated authored origins.
- **Accepted:** the existing form test asserts all three option values before submitting Small Town, preserving Blank Grid coverage.
- **Not adopted:** collapsing the design spec and implementation plan into one file. The project’s Superpowers workflow requires a reviewed spec under `docs/superpowers/specs/` and a separately saved execution plan under `docs/superpowers/plans/`. This plan has been tightened to minimize duplicated rationale while retaining the concrete code/test steps required for execution.

## Plan Self-Review

### Spec coverage

- Third template ID/factory/reset/parser/error mappings: Task 1.
- Exact roads/zones/four buildings and uncosted rotation-0 placement: Task 1 structural test + factory helper.
- Existing private-car access/topology: Task 1 `private_car_candidate` checks.
- Deterministic initial snapshot: existing factory loops extended in Task 1.
- Deterministic move-in/workplace/real outbound commute after Resume: Task 1 engine test.
- Coverage-maintenance blast radius: Task 1 `sandbox_coverage.rs` update.
- New City option, label map, request, reset-error decoding: Task 2.
- All three static New City options remain present: Task 2 form test.
- Real browser/WASM composition without duplicated content assertions: Task 3.
- No schema/version/framework/host-expansion work: Global Constraints + final diff review.

### Placeholder scan

No `TBD`, `TODO`, generic “add validation,” unspecified test step, or invented helper remains.

### Type consistency

- Rust uses `SandboxTemplateId::SmallTown` and serialized `smallTown`.
- Frontend uses `SandboxTemplateId = "blankGrid" | "crossroads" | "smallTown"`.
- `SANDBOX_TEMPLATE_LABELS` remains exhaustive.
- Raw backend creation request remains stringly typed intentionally.
- Reset error context/guard accepts the same three serialized IDs.
- The scheduler assertion uses the existing public `TripPurpose::CommuteOutbound` enum.

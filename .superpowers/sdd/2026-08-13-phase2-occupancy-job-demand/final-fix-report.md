# HPA-332 final fix report

Status: complete. All requested final-review findings were fixed in one final
wave. No push was performed.

## Changed files

- `src/persistence/indexedDbCitySaveStore.ts` — moved the production browser
  store to the fresh `caelum-city-saves-v5` database at IndexedDB version 5.
- `tests/runtime/persistence/indexedDbCitySaveStore.test.ts` — seeded a prior
  v1 database containing a schema-v4-shaped record and proved the default store
  lists no legacy records.
- `tests/e2e/newCity.spec.ts` — direct real-Chromium IndexedDB inspection now
  opens `caelum-city-saves-v5` at version 5.
- `src-tauri/src/city_store.rs` — moved native production files to the fresh
  `cities-v5` application-data directory; added fresh-path and legacy-directory
  isolation assertions.
- `crates/caelum-core/src/transit.rs` — destination-reference cleanup is
  invoked only for a non-empty job-capacity footprint; resident cleanup keeps
  its single final assignment pass.
- `crates/caelum-core/tests/population.rs` — added the focused over-capacity
  first-workplace/second-workplace/occupied-house demolition regression. It
  builds an expected snapshot by removing residents and calling exactly one
  `assign_workplaces` pass, then compares surviving assignments.
- `crates/caelum-core/src/trips.rs` — removed unreachable later
  `last_move_in_slots` cap widening while retaining the initial move-in bound
  and sim-count widening.
- `crates/caelum-core/src/engine.rs`, `crates/caelum-core/src/model.rs` —
  refreshed `from_snapshot` and schema-probe documentation to current v5
  wording.
- `docs/architecture.md` — documented v5 browser/native namespaces, stated
  that persisted snapshots are paused, and removed the obsolete paused
  move-in-setting wording.

## Finding resolution

1. Fresh v5 save namespaces: browser uses a new database name and version;
   native uses a new directory. Neither adapter reads, migrates, aliases, or
   falls back to the prior namespace. Direct unit/native assertions and the
   real-WASM IndexedDB E2E cover the contract.
2. Occupied-house double assignment: the destination cleanup call is gated by
   `!removed_destination_tiles.is_empty()`. Housing demolition therefore runs
   only resident removal's one refill pass, while workplace demolition keeps
   its existing cleanup ordering.
3. Focused regression: the new population integration test proves surviving
   assignments equal one post-removal assignment pass and do not get diverted
   into the second workplace.
4. Trip cap cleanup: removed only the unreachable later remaining-slot
   widening; initial `remaining_move_in_slots` and sim-count widening remain.
5. Stale wording: current v5/schema-paused language is used in engine/model/
   architecture docs; no current architecture/source inventory hit remains for
   schema-v3/v4 or `moveInRate` wording.

## TDD evidence

RED was captured before the final production fixes were retained:

```text
bunx vitest run --project runtime tests/runtime/persistence/indexedDbCitySaveStore.test.ts -t "fresh v5 namespace"
1 failed: expected [] but received the seeded city from `caelum-city-saves-v1`.

cargo test -p caelum --lib city_store::tests::from_app_uses_app_data_schema_v5_cities_child -- --nocapture
1 failed: left .../cities, right .../cities-v5.

cargo test -p caelum-core --test population demolishing_housing_runs_one_refill_pass_after_over_capacity_first_workplace -- --nocapture
1 failed against the ungated destination-cleanup path: survivors included second-workplace tiles instead of the expected one-pass first-workplace assignments.
```

Focused GREEN after the fixes:

```text
bunx vitest run --project runtime tests/runtime/persistence/indexedDbCitySaveStore.test.ts
17 passed.
cargo test -p caelum --lib city_store::tests -- --nocapture
20 passed.
cargo test -p caelum-core --test population --test areas_buildings --test trip_lifecycle --test golden_sequences --test router_planning
84 tests passed.
cargo test -p caelum-core growth::tests
9 passed.
bun run test:e2e -- tests/e2e/newCity.spec.ts
1 passed (real WASM + Chromium IndexedDB).
```

## Final gates

All commands completed successfully on the final tree:

- `bun run test:unit` — 53 files, 695 tests passed.
- `bun run check` — TypeScript and Svelte checks passed with 0 errors and 0
  warnings.
- `bun run test:e2e` — 21 Playwright tests passed.
- `bun run format:check` — Prettier and `cargo fmt --check` passed.
- `bun run lint` — ESLint, Stylelint, and workspace Clippy (`-D warnings`)
  passed.
- `cargo test --workspace` — all workspace unit, integration, and doc tests
  passed.

`git diff --check` also passed.

## Self-review

- Production browser and native paths have no compatibility read or migration
  branch; old records remain isolated in their old namespace.
- The destination cleanup helper has one caller and that caller now gates the
  non-empty footprint, making housing-only removal unable to trigger a first
  assignment pass.
- The regression compares against a separately constructed one-pass expected
  result and includes finite-capacity over-assignment plus a second workplace.
- The initial move-in cap remains in `max_tick_substeps`; only a monotonicity-
  impossible later widening was removed.
- No unrelated gameplay, UI, persistence contract, or historical plan files
  were changed.

## Concerns

- Historical design/plan documents still mention their original v1/v3/v4
  contracts as archival material; current production source, tests, E2E, and
  `docs/architecture.md` use the v5 contract.
- Existing user data in the old browser database/native directory is
  intentionally not migrated and will not appear in the v5 city library, per
  the breaking development-save rule.

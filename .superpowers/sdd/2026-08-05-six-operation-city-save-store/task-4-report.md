# Task 4 Report: CitySaveStore Runtime Cutover

## Changes

- Cut `createGameRuntime()` and persistence types over to `CitySaveStore` and
  `CitySaveRecord`.
- Made Save Now update-only, migrated Load/Rename/New City to the six-operation
  store boundary, and removed pending/finalize, envelope, generation,
  realm-admission, and recovery paths from runtime consumers.
- Simplified `dispose()` to drain and release with `Promise<void>`.
- Updated bootstrap/App and direct runtime tests; added focused CitySaveStore
  runtime coverage and a six-operation delayed store wrapper.
- Removed obsolete delayed-store and recovery-publication tests.

## Verification

- `bun run test:unit` — passed (994 passed, 1 skipped)
- `bun run check` — passed
- `bun run lint` — passed
- `bun run format:check` — passed
- `bun run build` — passed
- `bun run test:e2e` — passed (10 tests)

# Persistence fixtures

Regenerate the five snapshot fixtures from the authoritative Rust simulation
state with:

```sh
rtk cargo test -p caelum-core --test persistence_fixture_export \
  -- --ignored --nocapture
```

The exporter runs the repository-pinned Prettier binary after Rust serialization,
so run `rtk bun install --frozen-lockfile` first when dependencies are absent.
Regeneration is byte-stable and produces the same formatting enforced by the
repository-wide format check.

The generated snapshot fixtures are checked-in cross-host test evidence, not a
second source of sandbox truth. `persistence-errors.json` is maintained
manually so its closed persistence-error vocabulary stays deliberate and
reviewable.

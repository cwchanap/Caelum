# Service-driven city growth plan

Design: `docs/superpowers/specs/2026-10-17-service-driven-growth-design.md`.

1. **Delete growth waves.** Remove `ScenarioConfig.growth_waves`,
   `GrowthWave`, `GrowthAction`, their persistence validation and error
   fields, the seeded-wave scenario helper, the growth-wave boundary and
   substep-cap terms in `trips.rs`, and their tests. Bump the schema to 13
   and regenerate `tests/fixtures/sandbox_templates.json`.
2. **Growth pass.** New `growth.rs`: served nodes from the active services,
   catchments, demand balance, nearest valid footprint, free placement at the
   exact growth time, one ECS reconciliation.
3. **Tick wiring.** Growth times become tick boundaries; the substep that
   crosses one runs the pass; the substep cap counts them.
4. **Scene on growth.** `GameEngine::tick` carries the scene when buildings
   changed.
5. **Core tests.** Served zoned land grows and residents move in; unserved
   land and lines without vehicles do not; houses and workplaces alternate;
   a coarse tick grows like fine ticks; a growing tick carries the scene.
6. **Frontend.** Delete the TS growth-wave types and fixture field; add the
   Zones menu hint and its UI test.
7. **Docs.** Update `CLAUDE.md` and `docs/architecture.md`.

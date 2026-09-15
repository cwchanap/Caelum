# HPA-237 — Tower Maze cross-floor slice implementation plan

## Goal

Implement the first playable Tower Maze slice in one PR. The PR should replace obsolete city-sim runtime pieces as needed and leave Caelum with a small Vite + TypeScript + Phaser foundation that later Tower Maze tickets can extend directly.

## Delivery rule

One ticket = one PR. Do not split repository migration, gameplay foundation, combat, save handling, or the authored vertical slice into separate PRs.

## Task 1 — Cut Caelum over to the Tower Maze web runtime

- Keep Vite/Bun/TypeScript repo tooling that remains useful.
- Add Phaser.
- Replace the Svelte application entrypoint with a small TypeScript boot path that creates the Phaser game.
- Remove Svelte, Tauri, Rust/WASM, transport-sim scripts/config, and old runtime code once nothing in the new game references them.
- Update README commands and architecture notes to describe the Tower Maze runtime.
- Keep Vitest configured for pure TypeScript tests.

Validation:

- `bun install`
- `bun run check` or equivalent TypeScript check
- `bun run test`
- `bun run build`

Do not preserve the old application behind a feature flag or alternate route.

## Task 2 — Define minimal game state and authored content model

Create a small engine-agnostic domain boundary.

Implement:

- `GameState` with current location, player stats, discovered sections, opened rewards, defeated enemies, and opened shortcuts;
- stable IDs for maps/entities/assets;
- compact authored map/entity types;
- content lookups for the village, Floor 1 slice, and Floor 2 slice;
- default new-game state.

Author real content immediately rather than creating generic examples. The same definitions should survive into HPA-235/HPA-146.

Tests:

- content IDs are unique;
- portal destinations resolve;
- default state references valid authored content.

## Task 3 — Implement movement, collision, discovery, and map travel

Implement pure movement/travel helpers and connect them to one Phaser `WorldScene`.

Behavior:

- four-direction one-tile movement;
- blocked tiles do not move the player;
- entering a new authored section marks it discovered;
- stairs/portals move to an explicit map + spawn location;
- camera follows the player and does not reveal the full map at once.

Keep collision simple: authored grid cells plus entity occupancy are enough for this ticket.

Tests:

- allowed/blocked movement;
- portal destination correctness;
- discovery state commits once.

## Task 4 — Implement deterministic combat as a pure rule

Add one `previewCombat(player, enemy)` function and make resolution consume that result or call the same calculation.

Cover:

- player attacks first;
- zero/negative player damage rejects the fight;
- lethal predicted outcomes reject the fight;
- final enemy hit does not retaliate;
- exact HP loss is shown before confirmation;
- Fight / Cancel prompt blocks movement until resolved;
- defeated enemy is removed/disabled exactly once.

Presentation can be minimal: a compact prompt and a short hit/result flash on the map. No battle scene.

Tests should exhaust formula edge cases and explicitly assert preview/resolution agreement.

## Task 5 — Implement interactions, reward, shortcut, and village recovery

Add only the interactions needed for the authored loop:

- inspect one clue/landmark;
- collect one permanent stat upgrade;
- open one one-way latch/shortcut;
- heal at the village recovery point.

Rules:

- reward applies once, then remains visibly opened/collected;
- shortcut opening is permanent and traversal works afterward;
- recovery restores HP to max and leaves dungeon progression unchanged.

Tests:

- duplicate reward interaction is a no-op;
- shortcut persistence state controls collision/traversal;
- healing does not mutate defeated enemies, rewards, discovery, or shortcut state.

## Task 6 — Add autosave and reload

Use one LocalStorage snapshot.

Persist after completed durable actions such as:

- movement/map travel where location changes;
- discovery;
- reward collection;
- combat resolution;
- shortcut opening;
- village recovery.

Keep serialization direct and explicit. A missing or unusable snapshot can start a fresh game; no migrations are required.

Tests:

- save/load round-trip;
- reload after reward does not duplicate stats;
- reload after fight keeps enemy defeated and HP loss committed;
- reload after shortcut keeps it open;
- reload restores current map and tile.

## Task 7 — Author the complete HPA-237 player path

Build the map sections around the required payoff sequence:

1. Village lead points toward the tower.
2. Floor 1 immediately establishes a landmark and shows the unreachable upgrade.
3. A clue implies an alternate route without drawing an exact quest arrow.
4. Player descends to the Floor 2 connector section.
5. Floor 2 loops back to a rear Floor 1 entry.
6. Player collects the permanent upgrade.
7. The nearby enemy preview now costs visibly less HP than before the upgrade.
8. Player can fight or bypass as authored, then opens the one-way shortcut.
9. Shortcut returns the player toward Floor 1 entrance/village.
10. Village recovery heals; reload resumes correctly.

Tune enemy/reward numbers specifically so the stat upgrade changes the preview in an obvious way. Prefer a simple difference (for example, fewer enemy retaliations or lower per-hit loss) over subtle balance.

## Task 8 — Lock the asset replacement seams

Before final polish, make placeholder visuals use the same contracts later art will use:

- stable asset IDs;
- one tile size constant;
- one-tile logical footprint for player/enemies;
- bottom-center sprite anchor/alignment convention;
- entity interaction based on grid coordinates.

Do not spend time producing final assets in this PR; HPA-22 owns that work.

## Task 9 — Final validation

Run the whole slice from a fresh browser state and verify every acceptance criterion manually.

Automated gate:

- TypeScript check passes;
- unit tests pass;
- build passes;
- lint/format pass if retained by the simplified repo setup.

Manual gate:

- complete the village → F1 → F2 → rear F1 → upgrade → improved combat preview → shortcut → village loop;
- reload immediately after treasure, fight, and shortcut in separate checks;
- verify no duplicated reward or reverted world state;
- verify returning to the village heals without resetting dungeon progress;
- verify the route is understandable without an exact-route quest arrow.

## Files/structure target

Keep the implementation compact. A likely end state is:

```text
src/
  main.ts
  game/
    state.ts
    content.ts
    movement.ts
    combat.ts
    actions.ts
    save.ts
    content/
      village.ts
      floor1.ts
      floor2.ts
  phaser/
    createGame.ts
    WorldScene.ts
  ui/                # only if a tiny DOM overlay is materially simpler than Phaser text
```

This is a direction, not a mandate. Avoid creating folders/modules that do not earn their keep during implementation.

## Scope guardrails

Do not add:

- ECS;
- generic event/quest scripting;
- dependency injection framework;
- repository layer abstraction over LocalStorage;
- save migration framework;
- editor tooling;
- separate battle scene;
- inventory/equipment/shop systems;
- procedural generation;
- compatibility support for the previous city-sim runtime.

If implementation uncovers a choice between a reusable abstraction and a direct solution that cleanly supports the next three Tower Maze content tickets, choose the direct solution.

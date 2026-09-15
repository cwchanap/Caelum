# HPA-237 — Tower Maze cross-floor slice design

## Summary

HPA-237 is the first implementation slice for the Tower Maze MVP. It proves the one gameplay loop that the rest of the project depends on: the player sees an unreachable reward on Floor 1, follows a clue through Floor 2, re-enters Floor 1 from behind, gains a permanent upgrade, immediately sees combat become cheaper, opens a persistent shortcut, then returns to the village and can reload without losing committed progress.

This is a product pivot for Caelum. The existing city/transport simulation architecture is not a compatibility constraint. The implementation should keep only repo/tooling pieces that remain useful and replace obsolete runtime/game code rather than carrying two games or an adapter layer.

## Product decisions

- One authored village slice plus small real sections of Floor 1 and Floor 2. These sections become the seed for later content tickets rather than disposable prototypes.
- Four-direction tile movement on a fixed grid.
- One reusable Phaser world scene renders all authored maps.
- Exploration is the primary loop. Combat is a deterministic blocker and resource check, not a separate tactical mode.
- One plain TypeScript `GameState` is authoritative. Phaser reads state and dispatches actions; it does not own progression rules.
- Content is data, not floor-specific subclasses. Maps, portals, enemies, rewards, clues, and shortcuts are authored definitions keyed by stable IDs.
- LocalStorage is sufficient for the MVP snapshot. No migration framework, schema registry, cloud save, accounts, backend, or IndexedDB.
- Placeholder visuals are acceptable, but rendering contracts must already use stable asset IDs, a fixed tile size, gameplay footprints, and alignment conventions so HPA-22 can replace assets without changing map logic.
- No generic quest/event scripting engine. The slice needs only explicit interactions and state flags required by the authored sequence.

## Repository pivot

The current repository contains Svelte, Rust/WASM, Tauri, and transport-simulation-specific runtime code. HPA-237 should not preserve those systems for compatibility.

The implementation PR should simplify toward:

- Vite + TypeScript as the web app/tooling base.
- Phaser as the runtime renderer/input layer.
- Vitest for pure gameplay and persistence tests.
- A small browser shell (`index.html` + TypeScript entrypoint) around the Phaser canvas.

Remove obsolete city-sim runtime dependencies and scripts when they stop being referenced. Do not build a migration bridge from old saves, old Rust domain objects, Svelte stores, or Tauri APIs.

## Architecture

### 1. Pure game domain

Keep rules under a small `src/game/` boundary with no Phaser imports.

Suggested modules:

- `state.ts` — `GameState`, default state, position and player stats.
- `content.ts` — content types and lookups for authored maps/entities.
- `movement.ts` — collision and destination resolution.
- `combat.ts` — deterministic preview and resolution.
- `actions.ts` — small pure action functions for inspect, collect reward, fight, open shortcut, heal, and travel.
- `save.ts` — snapshot serialization/deserialization.

The important property is not the exact filenames; it is that the same pure functions power both UI preview and committed gameplay changes.

### 2. Authored content

Represent the playable slice using compact TypeScript definitions.

Each map definition should provide:

- stable map ID;
- dimensions/grid collision;
- spawn/entry points;
- discovery sections or rooms;
- interactive entities keyed by stable ID;
- explicit portal/stair destinations.

Entity definitions only need the variants used in this ticket, such as clue, reward, enemy, shortcut/latch, recovery point, and portal.

Do not introduce inheritance, ECS components, generic triggers, or a content DSL.

### 3. Phaser presentation

Use one reusable `WorldScene` that:

- renders the current authored map;
- follows the player with a scrolling camera;
- translates keyboard input into domain actions;
- updates visible entity state after committed actions;
- opens a minimal Fight / Cancel prompt when entering an enemy interaction;
- shows concise clue/interaction text;
- shows short on-map combat/reward feedback;
- swaps map content when a portal action changes location.

The scene should rebuild or patch its presentation from authoritative state rather than storing independent progression flags on Phaser objects.

### 4. Deterministic combat contract

Use one pure preview function for both the prompt and fight resolution.

Rules:

```text
playerDamage = player.attack - enemy.defense
hitsNeeded = ceil(enemy.hp / playerDamage)
enemyDamage = max(0, enemy.attack - player.defense)
totalHpLoss = (hitsNeeded - 1) * enemyDamage
```

A fight is invalid when `playerDamage <= 0` or when the predicted HP result is lethal. Player attacks first, so the final hit does not cause enemy retaliation.

The encounter should resolve atomically:

1. validate against current state;
2. compute the exact outcome;
3. mark the enemy defeated and apply HP loss once;
4. autosave committed state;
5. play cosmetic feedback.

This keeps animation timing from becoming game logic.

### 5. Persistence

Persist one snapshot after completed actions that mutate durable state.

Minimum durable fields:

- current map and tile position;
- player HP/max HP, attack, defense;
- opened reward IDs;
- defeated enemy IDs;
- discovered section IDs;
- opened shortcut IDs.

Village recovery heals current HP to max HP but does not reset dungeon progress.

For this hobby MVP, malformed/obsolete saves may fall back to a fresh game. Do not build version migration infrastructure in this ticket.

## Authored vertical slice

The content should make the required sequence obvious through level layout rather than navigation arrows.

### Village

- player spawn;
- one short NPC/sign interaction giving a lead toward the tower;
- recovery point that heals and autosaves;
- entry to Floor 1.

### Floor 1 — front route

- entrance section with a readable landmark;
- unreachable permanent-upgrade treasure visible through/behind a barrier;
- clue indicating the route continues below or around the blocked area;
- one nearby enemy whose preview will be meaningfully improved after the upgrade;
- a closed one-way shortcut/latch connecting the back route to the entrance side.

### Floor 2 — connector route

- compact path with at least one loop/turn so it feels like exploration rather than a corridor;
- authored stairs/portal that returns to Floor 1 behind the original barrier.

### Floor 1 — back route payoff

- collect the permanent upgrade exactly once;
- preview the nearby enemy again and make the reduced HP loss obvious;
- optionally fight it using the same preview calculation;
- open the shortcut/latch;
- use the shortcut to return toward the entrance and village.

## Asset contract for HPA-22

Lock only the seams needed by later generated art:

- one fixed tile size across maps;
- stable asset IDs separate from file paths;
- player/enemy gameplay footprint remains one logical tile for this MVP;
- bottom-center sprite anchoring for characters/entities;
- interaction/hitbox logic uses tile coordinates, not opaque sprite bounds.

Do not define a general asset pipeline beyond what the slice needs.

## Test strategy

Prioritize pure-rule tests over rendering tests.

Required unit coverage:

- combat preview formula, including zero-damage and lethal rejection;
- fight resolution equals preview and commits exactly once;
- reward cannot be collected twice;
- shortcut remains open after traversal/reload;
- village recovery heals without resetting progression;
- save round-trip preserves the durable state used by the slice;
- authored portal connections arrive at the expected destination.

Add one lightweight browser/E2E happy path only if the existing repo test setup can support it cheaply after the pivot. It should not block the core PR if recreating old transport-specific Playwright infrastructure becomes disproportionate.

## Non-goals

- complete Floor 1 or Floor 2;
- quest journal or generic quest framework;
- inventory/equipment/shop systems;
- random loot or random encounters;
- battle scene, initiative system, skills, status effects, or tactical turn UI;
- procedural generation;
- editor tooling;
- backend/cloud persistence;
- old city-sim save compatibility;
- preserving Svelte/Rust/Tauri architecture when it no longer serves the new game.

## Acceptance focus

The implementation is successful when a fresh player can complete the entire cross-floor loop, understand why the alternate route matters, see the permanent upgrade change a real deterministic combat preview, open a useful persistent shortcut, return to the village, reload, and resume with all committed progression intact.

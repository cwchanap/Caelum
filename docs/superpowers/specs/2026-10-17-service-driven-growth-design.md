# Service-driven city growth design

## Context

In a sandbox the player places both the demand (houses and workplaces) and
the supply (roads and transit). Once a town is served, nothing pushes back:
transit has no effect on how the city develops. The core also carried
scenario-authored growth waves that no shipped mode used.

Larger maps (PR #66) give the city room to grow. This slice makes the city
develop where the player's transit serves it.

## Goal

Zoned land near running transit develops buildings on its own. The player
zones and connects; the city builds. The scenario-authored growth-wave code
is deleted in the same change.

## Product rule

Sandbox only. Every six game hours (00:00, 06:00, 12:00 and 18:00) the city
grows:

- **Served nodes.** A bus stop, bus terminal or metro station is served when
  it is a present node on a line that is operational and has at least one
  vehicle. That is the same set of services passengers can plan on.
- **Catchment.** Each served node's catchment is the square the Coverage
  overlay draws: radius 2 for a bus stop, 4 for a bus terminal or metro
  station.
- **One building per node.** Served nodes take turns in build order (stops,
  then stations). Each develops at most one building whose footprint touches
  its catchment.
- **What grows.** A house grows when total job capacity is at least total
  housing capacity; otherwise a workplace grows. Totals count every building,
  including ones grown earlier in the same pass, so growth alternates between
  homes and jobs. If the land the node needs is not zoned there, the node
  grows nothing.

  | Zone        | Grows        |
  | ----------- | ------------ |
  | Residential | Small House  |
  | Commercial  | Supermarket  |
  | Office      | Office Tower |
  | Industrial  | Factory      |

  Civic and park land never grows; the player places schools, clinics and
  parks.
- **Where it grows.** Candidates are footprints at rotation 0 or 90 that the
  ordinary placement rules accept. The nearest to the node wins (Chebyshev
  distance to the footprint), then rotation 0 before 90, then top-to-bottom,
  left-to-right. A workplace takes the nearest candidate among commercial,
  office and industrial land.
- **Free.** Growth is the world building, not the player spending; it costs
  nothing. Residents move into grown houses hourly, exactly as into houses the
  player places.

A badly balanced or unserved district stalls: homes wait for jobs, jobs wait
for workers, and nothing grows beyond the reach of a running line.

## Rust core

- `growth.rs` is replaced. `grow_city(state, world)` runs the pass above,
  places through `place_building_core`, stamps each building with the exact
  growth time, and reconciles the ECS population once against the pre-growth
  snapshot.
- The tick breaks at every growth time (`next_boundary_after`) and the
  substep that crosses one runs the pass, so a coarse tick grows exactly like
  many fine ticks.
- A tick whose buildings changed carries the scene, so grown buildings appear
  without waiting for the next player action. Every other tick stays
  frame-only.
- `ScenarioConfig.growth_waves`, `GrowthWave`, `GrowthAction`, their
  persistence checks, the seeded-wave scenario helper, and their tests are
  deleted. `SNAPSHOT_SCHEMA_VERSION` becomes 13; older development saves are
  rejected.

Campaign objectives and `GameMode` stay; removing them is a separate
decision.

## Frontend

- The TypeScript growth-wave types and fixture field are deleted.
- The Zones build menu says that zoned land near a running line builds up on
  its own.

## Out of scope

- Service quality (waits, crowding) weighting growth.
- Buildings declining or residents moving out when service is poor.
- Growth notifications or a growth overlay.
- Upgrading houses to larger buildings, and civic or park growth.

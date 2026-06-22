import { describe, expect, it } from "vitest";
import type {
  Citizen,
  GameState,
  PlacedBuilding,
  RoutePlan,
  Vehicle,
} from "../../src/domain/types";
import { createInitialGameState } from "../../src/simulation/gameState";
import {
  destinationIsOnTile,
  destinationPoints,
  isHomeFallbackCitizen,
  retargetCitizens,
} from "../../src/simulation/buildingSelectors";

function citizen(
  overrides: Partial<Citizen> & Pick<Citizen, "id" | "home" | "destination">,
): Citizen {
  return {
    position: { ...overrides.home },
    status: "idle",
    patienceRemaining: 240,
    deadline: 900,
    routePlan: null,
    currentLegIndex: 0,
    ...overrides,
  };
}

function vehicle(overrides: Partial<Vehicle> & Pick<Vehicle, "id">): Vehicle {
  return {
    mode: "bus",
    lineId: "route-001",
    capacity: 50,
    passengerIds: [],
    segmentIndex: 0,
    progress: 0,
    ...overrides,
  };
}

function stateWith(overrides: Partial<GameState>): GameState {
  return { ...createInitialGameState(), ...overrides };
}

function supermarketAt(origin: { x: number; y: number }): PlacedBuilding {
  const occupiedTiles = [
    { x: origin.x, y: origin.y },
    { x: origin.x + 1, y: origin.y },
    { x: origin.x, y: origin.y + 1 },
    { x: origin.x + 1, y: origin.y + 1 },
  ];
  return {
    id: "building-001",
    type: "supermarket",
    origin: { ...origin },
    rotation: 0,
    occupiedTiles,
  };
}

const ridingPlan: RoutePlan = {
  estimatedSeconds: 120,
  legs: [
    {
      mode: "walk",
      from: { x: 1, y: 1 },
      to: { x: 5, y: 8 },
    },
    {
      mode: "bus",
      from: { x: 5, y: 8 },
      to: { x: 10, y: 8 },
      lineId: "route-001",
    },
    {
      mode: "walk",
      from: { x: 10, y: 8 },
      to: { x: 5, y: 1 },
    },
  ],
};

describe("destinationPoints", () => {
  it("flattens occupied tiles of destination-effect buildings only", () => {
    const state = stateWith({
      buildings: [
        supermarketAt({ x: 5, y: 1 }),
        {
          id: "building-002",
          type: "smallHouse",
          origin: { x: 0, y: 0 },
          rotation: 0,
          occupiedTiles: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
          ],
        },
      ],
    });

    expect(destinationPoints(state)).toEqual([
      { x: 5, y: 1 },
      { x: 6, y: 1 },
      { x: 5, y: 2 },
      { x: 6, y: 2 },
    ]);
  });

  it("returns an empty array when no destination buildings exist", () => {
    const state = stateWith({
      buildings: [
        {
          id: "building-002",
          type: "smallHouse",
          origin: { x: 0, y: 0 },
          rotation: 0,
          occupiedTiles: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
          ],
        },
      ],
    });

    expect(destinationPoints(state)).toEqual([]);
  });
});

describe("isHomeFallbackCitizen", () => {
  it("is true when destination equals home", () => {
    expect(
      isHomeFallbackCitizen(
        citizen({
          id: "c-1",
          home: { x: 1, y: 1 },
          destination: { x: 1, y: 1 },
        }),
      ),
    ).toBe(true);
  });

  it("is false when destination differs from home", () => {
    expect(
      isHomeFallbackCitizen(
        citizen({
          id: "c-1",
          home: { x: 1, y: 1 },
          destination: { x: 5, y: 1 },
        }),
      ),
    ).toBe(false);
  });
});

describe("destinationIsOnTile", () => {
  it("is true when the destination lies on one of the given tiles", () => {
    const c = citizen({
      id: "c-1",
      home: { x: 1, y: 1 },
      destination: { x: 6, y: 1 },
    });
    expect(
      destinationIsOnTile(c, [
        { x: 5, y: 1 },
        { x: 6, y: 1 },
      ]),
    ).toBe(true);
  });

  it("is false when the destination is not among the given tiles", () => {
    const c = citizen({
      id: "c-1",
      home: { x: 1, y: 1 },
      destination: { x: 7, y: 1 },
    });
    expect(
      destinationIsOnTile(c, [
        { x: 5, y: 1 },
        { x: 6, y: 1 },
      ]),
    ).toBe(false);
  });
});

describe("retargetCitizens", () => {
  it("returns the original vehicles array when no citizen is retargeted", () => {
    const v = vehicle({ id: "v-1" });
    const state = stateWith({
      transit: {
        ...createInitialGameState().transit,
        vehicles: [v],
      },
      citizens: [
        citizen({
          id: "c-1",
          home: { x: 1, y: 1 },
          destination: { x: 5, y: 1 },
        }),
      ],
    });

    const result = retargetCitizens(state, () => false);
    expect(result.vehicles).toBe(state.transit.vehicles);
  });

  it("re-resolves home-fallback citizens to current destination tiles", () => {
    const state = stateWith({
      buildings: [supermarketAt({ x: 5, y: 1 })],
      citizens: [
        citizen({
          id: "c-1",
          home: { x: 1, y: 1 },
          destination: { x: 1, y: 1 },
        }),
        citizen({
          id: "c-2",
          home: { x: 2, y: 1 },
          destination: { x: 2, y: 1 },
        }),
      ],
    });

    const result = retargetCitizens(state, isHomeFallbackCitizen);

    expect(result.citizens).toHaveLength(2);
    for (const c of result.citizens) {
      expect(c.destination).not.toEqual(c.home);
      expect(c.routePlan).toBeNull();
      expect(c.status).toBe("idle");
      expect(c.currentLegIndex).toBe(0);
    }
    // Round-robin distribution across the four supermarket tiles.
    expect(result.citizens.map((c) => ({ ...c.destination }))).toEqual([
      { x: 5, y: 1 },
      { x: 6, y: 1 },
    ]);
  });

  it("falls back to home when no destination buildings remain", () => {
    const state = stateWith({
      citizens: [
        citizen({
          id: "c-1",
          home: { x: 1, y: 1 },
          destination: { x: 5, y: 1 },
        }),
      ],
    });

    const result = retargetCitizens(state, (c) =>
      destinationIsOnTile(c, [{ x: 5, y: 1 }]),
    );

    expect(result.citizens[0].destination).toEqual({ x: 1, y: 1 });
    expect(result.citizens[0].status).toBe("idle");
    expect(result.citizens[0].routePlan).toBeNull();
  });

  it("skips terminal citizens (arrived / late / unserved)", () => {
    const state = stateWith({
      buildings: [supermarketAt({ x: 5, y: 1 })],
      citizens: [
        citizen({
          id: "c-1",
          home: { x: 1, y: 1 },
          destination: { x: 1, y: 1 },
          status: "arrived",
        }),
        citizen({
          id: "c-2",
          home: { x: 2, y: 1 },
          destination: { x: 2, y: 1 },
          status: "late",
        }),
        citizen({
          id: "c-3",
          home: { x: 3, y: 1 },
          destination: { x: 3, y: 1 },
          status: "unserved",
        }),
      ],
    });

    const result = retargetCitizens(state, isHomeFallbackCitizen);

    // None of the terminal citizens were retargeted.
    expect(result.citizens.map((c) => ({ ...c.destination }))).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
    ]);
    // No retargeting happened, so vehicles array is the original reference.
    expect(result.vehicles).toBe(state.transit.vehicles);
  });

  it("disembarks riding citizens: removes them from vehicle passengerIds, nulls routePlan, resets to idle", () => {
    // A riding citizen on a bus whose destination building is bulldozed.
    // Without forced disembarkation, the nulled routePlan would trap them:
    // `disembarkVehicle` only drops passengers whose current leg matches the
    // reached stop, and tickCitizen's "riding && !isOnVehicle" branch only
    // fires when the vehicle is gone — not when the plan is nulled while the
    // vehicle still runs. retargetCitizens must remove them from
    // passengerIds so the vehicle stops tracking them, and reset them to
    // idle at their current position so tickCitizen replans from there.
    const boardingStop = { x: 5, y: 8 };
    const rider = citizen({
      id: "c-1",
      home: { x: 1, y: 1 },
      destination: { x: 5, y: 1 },
      position: { ...boardingStop },
      status: "riding",
      routePlan: ridingPlan,
      currentLegIndex: 1,
    });
    const otherPassenger = citizen({
      id: "c-2",
      home: { x: 2, y: 1 },
      destination: { x: 6, y: 1 },
      position: { ...boardingStop },
      status: "riding",
      routePlan: ridingPlan,
      currentLegIndex: 1,
    });
    const v = vehicle({
      id: "v-1",
      passengerIds: ["c-1", "c-2"],
    });
    const state = stateWith({
      // A remaining destination so the rider is retargeted to a real tile
      // rather than falling back to home — exercises the distribution path.
      buildings: [supermarketAt({ x: 10, y: 1 })],
      citizens: [rider, otherPassenger],
      transit: {
        ...createInitialGameState().transit,
        vehicles: [v],
      },
    });

    // Retarget only c-1 (the one whose destination is on the bulldozed tiles).
    const result = retargetCitizens(state, (c) =>
      destinationIsOnTile(c, [{ x: 5, y: 1 }]),
    );

    // c-1 was retargeted: removed from vehicle, plan nulled, idle, new dest.
    expect(result.vehicles[0].passengerIds).toEqual(["c-2"]);
    const retargeted = result.citizens.find((c) => c.id === "c-1");
    expect(retargeted?.status).toBe("idle");
    expect(retargeted?.routePlan).toBeNull();
    expect(retargeted?.currentLegIndex).toBe(0);
    expect(retargeted?.destination).not.toEqual({ x: 5, y: 1 });
    // Position is preserved at the boarding stop (a valid tile for replan).
    expect(retargeted?.position).toEqual(boardingStop);

    // c-2 is untouched: still on the vehicle, plan intact.
    const untouched = result.citizens.find((c) => c.id === "c-2");
    expect(untouched?.status).toBe("riding");
    expect(untouched?.routePlan).toEqual(ridingPlan);
    expect(untouched?.currentLegIndex).toBe(1);
  });

  it("disembarks riders across multiple vehicles", () => {
    // Retargeting must scan every vehicle for retargeted passenger ids, not
    // just the first match — a citizen could be carried by any vehicle in
    // the network.
    const rider = citizen({
      id: "c-1",
      home: { x: 1, y: 1 },
      destination: { x: 5, y: 1 },
      position: { x: 5, y: 8 },
      status: "riding",
      routePlan: ridingPlan,
      currentLegIndex: 1,
    });
    const v1 = vehicle({ id: "v-1", passengerIds: ["c-1"] });
    const v2 = vehicle({
      id: "v-2",
      lineId: "route-002",
      passengerIds: ["c-1", "c-3"],
    });
    const state = stateWith({
      buildings: [supermarketAt({ x: 10, y: 1 })],
      citizens: [rider],
      transit: {
        ...createInitialGameState().transit,
        vehicles: [v1, v2],
      },
    });

    const result = retargetCitizens(state, (c) =>
      destinationIsOnTile(c, [{ x: 5, y: 1 }]),
    );

    expect(result.vehicles[0].passengerIds).toEqual([]);
    expect(result.vehicles[1].passengerIds).toEqual(["c-3"]);
  });

  it("retargets against the buildings supplied in state, not a stale snapshot", () => {
    // The caller (placeBuilding / removeAtTile) is responsible for passing a
    // state whose `buildings` array already reflects the change (the new
    // building added, or the removed building filtered out). This test
    // confirms retargetCitizens reads `state.buildings` at call time rather
    // than caching destinationPoints from somewhere else.
    const stateBefore = stateWith({
      citizens: [
        citizen({
          id: "c-1",
          home: { x: 1, y: 1 },
          destination: { x: 1, y: 1 },
        }),
      ],
    });
    // No destination buildings yet → retarget falls back to home.
    const before = retargetCitizens(stateBefore, isHomeFallbackCitizen);
    expect(before.citizens[0].destination).toEqual({ x: 1, y: 1 });

    // After a destination building is added to the state passed in, the
    // retarget resolves to its tiles.
    const stateAfter = {
      ...stateBefore,
      buildings: [supermarketAt({ x: 5, y: 1 })],
    };
    const after = retargetCitizens(stateAfter, isHomeFallbackCitizen);
    expect(after.citizens[0].destination).toEqual({ x: 5, y: 1 });
  });

  it("preserves the home point and id on retarget, refreshes trip timers", () => {
    // Retargeting starts a fresh trip: routePlan, currentLegIndex and status
    // are already reset, so deadline/patienceRemaining must be reset too.
    // Otherwise a home-fallback citizen held dormant long after its original
    // deadline would be marked unserved on the very next tick after being
    // assigned a real destination (see tickCitizen's deadline checks).
    const state = stateWith({
      time: 1200,
      buildings: [supermarketAt({ x: 5, y: 1 })],
      citizens: [
        citizen({
          id: "c-1",
          home: { x: 1, y: 1 },
          destination: { x: 1, y: 1 },
          patienceRemaining: 120,
          deadline: 900,
        }),
      ],
    });

    const result = retargetCitizens(state, isHomeFallbackCitizen);

    expect(result.citizens[0].home).toEqual({ x: 1, y: 1 });
    expect(result.citizens[0].id).toBe("c-1");
    // Timers refreshed relative to the current sim time, mirroring the
    // deadline = state.time + 900 / patienceRemaining = 240 used at citizen
    // creation (buildings.ts, map.ts).
    expect(result.citizens[0].deadline).toBe(1200 + 900);
    expect(result.citizens[0].patienceRemaining).toBe(240);
  });

  it("refreshes trip timers for non-home-fallback retargets too", () => {
    // A citizen whose destination was bulldozed mid-trip has already consumed
    // patience and possibly blown past its deadline while in transit.
    // Retargeting gives them a fresh trip window consistent with the full
    // plan/status reset already performed.
    const state = stateWith({
      time: 2000,
      buildings: [supermarketAt({ x: 10, y: 1 })],
      citizens: [
        citizen({
          id: "c-1",
          home: { x: 1, y: 1 },
          destination: { x: 5, y: 1 },
          position: { x: 3, y: 1 },
          status: "walking",
          patienceRemaining: 30,
          deadline: 900,
        }),
      ],
    });

    const result = retargetCitizens(state, (c) =>
      destinationIsOnTile(c, [{ x: 5, y: 1 }]),
    );

    expect(result.citizens[0].deadline).toBe(2000 + 900);
    expect(result.citizens[0].patienceRemaining).toBe(240);
  });

  it("returns original citizens array reference when no citizen matches the predicate", () => {
    const c = citizen({
      id: "c-1",
      home: { x: 1, y: 1 },
      destination: { x: 5, y: 1 },
    });
    const state = stateWith({ citizens: [c] });

    const result = retargetCitizens(state, () => false);
    expect(result.citizens).toBe(state.citizens);
  });

  it("does not assign a destination equal to a citizen's home when alternatives exist", () => {
    // Bulldoze+rezone flow: housing was built (citizens created with `home`
    // on its tiles, destination falling back to home since no destination
    // building existed yet), then bulldozed — housing bulldozes intentionally
    // keep citizens alive (see actions.ts removeAtTile) — then the same
    // footprint was rezoned and a destination built on it. The surviving
    // citizens still carry `home` on tiles that are now destination tiles.
    //
    // Assigning one of those tiles as `destination` would make
    // destination === home, indistinguishable from the home-fallback case
    // and trapping the citizen in tickCitizen's dormant branch forever
    // (see citizens.ts). retargetCitizens must steer them to a different
    // destination tile when one exists.
    const state = stateWith({
      // Supermarket footprint {1,1},{2,1},{1,2},{2,2} overlaps both homes.
      buildings: [supermarketAt({ x: 1, y: 1 })],
      citizens: [
        citizen({
          id: "c-1",
          home: { x: 1, y: 1 },
          destination: { x: 1, y: 1 },
        }),
        citizen({
          id: "c-2",
          home: { x: 2, y: 1 },
          destination: { x: 2, y: 1 },
        }),
      ],
    });

    const result = retargetCitizens(state, isHomeFallbackCitizen);

    for (const c of result.citizens) {
      expect(c.destination).not.toEqual(c.home);
      expect(c.routePlan).toBeNull();
      expect(c.status).toBe("idle");
    }
  });

  it("falls back to home when the only destination tile equals home", () => {
    // Degenerate case: the sole remaining destination sits exactly on the
    // citizen's home. There is genuinely nowhere else to send them, so
    // retarget falls through to home (the dormant branch keeps them
    // retargetable if a different destination is added later) rather than
    // leaving the destination field unset.
    const state = stateWith({
      buildings: [
        {
          id: "building-001",
          type: "parkPlaza",
          origin: { x: 1, y: 1 },
          rotation: 0,
          // Single-tile destination exactly on the citizen's home.
          occupiedTiles: [{ x: 1, y: 1 }],
        },
      ],
      citizens: [
        citizen({
          id: "c-1",
          home: { x: 1, y: 1 },
          destination: { x: 1, y: 1 },
        }),
      ],
    });

    const result = retargetCitizens(state, isHomeFallbackCitizen);

    expect(result.citizens[0].destination).toEqual({ x: 1, y: 1 });
    expect(result.citizens[0].status).toBe("idle");
    expect(result.citizens[0].routePlan).toBeNull();
  });
});

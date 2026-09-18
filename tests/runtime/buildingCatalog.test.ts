import { describe, expect, it } from "vitest";

import { BUILDING_CATALOG } from "../../src/domain/catalog/buildings";

describe("building capacity catalog", () => {
  it("pins resident and job capacities for every catalog entry", () => {
    const expected: Record<
      string,
      { residentCapacity: number; jobCapacity: number }
    > = {
      busStop: { residentCapacity: 0, jobCapacity: 0 },
      busTerminal: { residentCapacity: 0, jobCapacity: 0 },
      metroStation: { residentCapacity: 0, jobCapacity: 0 },
      smallHouse: { residentCapacity: 4, jobCapacity: 0 },
      largeHouse: { residentCapacity: 10, jobCapacity: 0 },
      supermarket: { residentCapacity: 0, jobCapacity: 4 },
      cinema: { residentCapacity: 0, jobCapacity: 6 },
      factory: { residentCapacity: 0, jobCapacity: 6 },
      warehouse: { residentCapacity: 0, jobCapacity: 6 },
      officeTower: { residentCapacity: 0, jobCapacity: 4 },
      businessPark: { residentCapacity: 0, jobCapacity: 6 },
      clinic: { residentCapacity: 0, jobCapacity: 4 },
      school: { residentCapacity: 0, jobCapacity: 6 },
      parkPlaza: { residentCapacity: 0, jobCapacity: 4 },
    };

    expect(Object.keys(BUILDING_CATALOG).sort()).toEqual(
      Object.keys(expected).sort(),
    );

    for (const [type, capacities] of Object.entries(expected)) {
      expect(
        BUILDING_CATALOG[type as keyof typeof BUILDING_CATALOG],
      ).toMatchObject(capacities);
    }
  });

  it("pins exact player-facing pattern copy for featured workplaces", () => {
    expect(BUILDING_CATALOG.officeTower.workPattern).toBe(
      "Standard · 07:00–09:00 starts, 17:00–19:00 returns",
    );
    expect(BUILDING_CATALOG.factory.workPattern).toBe(
      "Early / late · 05:30–07:00 or 10:00–11:30 starts; 15:00–16:30 or 19:30–21:00 returns",
    );
    expect(BUILDING_CATALOG.warehouse.workPattern).toBeUndefined();
  });
});

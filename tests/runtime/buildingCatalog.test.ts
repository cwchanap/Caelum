import { describe, expect, it } from "vitest";

import { BUILDING_CATALOG } from "../../src/domain/catalog/buildings";

describe("building capacity catalog", () => {
  it("pins representative resident and job capacities", () => {
    expect(BUILDING_CATALOG.smallHouse).toMatchObject({
      residentCapacity: 4,
      jobCapacity: 0,
    });
    expect(BUILDING_CATALOG.largeHouse).toMatchObject({
      residentCapacity: 10,
      jobCapacity: 0,
    });
    expect(BUILDING_CATALOG.supermarket).toMatchObject({
      residentCapacity: 0,
      jobCapacity: 4,
    });
    expect(BUILDING_CATALOG.factory).toMatchObject({
      residentCapacity: 0,
      jobCapacity: 6,
    });
  });
});

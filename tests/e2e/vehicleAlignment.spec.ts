import { expect, test } from "@playwright/test";
import type {
  AlignmentProbeRequest,
  AlignmentProbeResult,
} from "./vehicleAlignment";

const REQUESTS: AlignmentProbeRequest[] = [
  { renderer: "webgpu", motion: "paused" },
  { renderer: "webgpu", motion: "moving" },
  { renderer: "canvas2d", motion: "paused" },
  { renderer: "canvas2d", motion: "moving" },
];

test("paints vehicle centers on their presented samples and pick targets", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/tests/e2e/vehicleAlignment.html");
  await page.waitForFunction(() => "__caelumVehicleAlignment" in window);

  const results: AlignmentProbeResult[] = [];
  for (const request of REQUESTS) {
    results.push(
      await page.evaluate((probe) => {
        return window.__caelumVehicleAlignment.probe(probe);
      }, request),
    );
  }

  for (const result of results) {
    expect(
      result.vehicles.map((vehicle) => vehicle.id),
      `${result.renderer}/${result.motion} captures every fixture vehicle`,
    ).toEqual([
      "vehicle-shared-a",
      "vehicle-shared-b",
      "vehicle-dual-east",
      "vehicle-dual-west",
      "vehicle-turn",
    ]);
    for (const vehicle of result.vehicles) {
      expect(
        vehicle.measuredDevice,
        `${result.renderer}/${result.motion}/${vehicle.id} has a measurable rim`,
      ).not.toBeNull();
      expect(
        vehicle.deltaDevicePx,
        `${result.renderer}/${result.motion}/${vehicle.id} center delta`,
      ).not.toBeNull();
      expect(
        vehicle.deltaDevicePx!,
        `${result.renderer}/${result.motion}/${vehicle.id} painted center matches presented sample`,
      ).toBeLessThanOrEqual(1.75);
      expect(
        vehicle.pickedId,
        `${result.renderer}/${result.motion}/${vehicle.id} pick target`,
      ).toBe(vehicle.id);
    }

    const sharedA = result.vehicles[0]!;
    const sharedB = result.vehicles[1]!;
    // The two shared-corridor lanes are offset on opposite sides of the path:
    // their centers must not collapse onto the same lane.
    expect(
      Math.abs(sharedA.expectedWorld.y - sharedB.expectedWorld.y),
      `${result.renderer}/${result.motion} shared-corridor lane separation`,
    ).toBeGreaterThan(3.5);

    const dualEast = result.vehicles.find(
      (vehicle) => vehicle.id === "vehicle-dual-east",
    )!;
    const dualWest = result.vehicles.find(
      (vehicle) => vehicle.id === "vehicle-dual-west",
    )!;
    expect(
      dualEast.expectedWorld.y,
      `${result.renderer}/${result.motion} dual-carriageway east lane`,
    ).toBeLessThan(dualWest.expectedWorld.y);
    expect(
      Math.abs(dualEast.angle),
      `${result.renderer}/${result.motion} eastbound dual-lane angle`,
    ).toBeLessThan(0.001);
    expect(
      Math.abs(Math.abs(dualWest.angle) - Math.PI),
      `${result.renderer}/${result.motion} westbound dual-lane angle`,
    ).toBeLessThan(0.001);
    const turn = result.vehicles.find(
      (vehicle) => vehicle.id === "vehicle-turn",
    )!;
    expect(
      Math.abs(Math.sin(turn.angle)),
      `${result.renderer}/${result.motion} turn angle is neither straight east nor west`,
    ).toBeGreaterThan(0.1);
  }

  for (const renderer of ["webgpu", "canvas2d"] as const) {
    const paused = results.find(
      (result) => result.renderer === renderer && result.motion === "paused",
    )!;
    const moving = results.find(
      (result) => result.renderer === renderer && result.motion === "moving",
    )!;
    for (const pausedVehicle of paused.vehicles) {
      const movingVehicle = moving.vehicles.find(
        (vehicle) => vehicle.id === pausedVehicle.id,
      )!;
      const distance = Math.hypot(
        movingVehicle.expectedWorld.x - pausedVehicle.expectedWorld.x,
        movingVehicle.expectedWorld.y - pausedVehicle.expectedWorld.y,
      );
      expect(
        distance,
        `${renderer}/${pausedVehicle.id} moving frame interpolates instead of snapping to latest`,
      ).toBeGreaterThan(1);
    }
  }
});

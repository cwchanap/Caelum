import { expect, it } from "vitest";
import { SNAPSHOT_SCHEMA_VERSION } from "../../../src/domain/types";
import { buildSaveEnvelope } from "../../../src/persistence/envelope";
import { makeRustSnapshot } from "./fixtures";

it("builds schema-v1 metadata from a canonical Rust snapshot", () => {
  const snapshot = makeRustSnapshot({
    rules: {
      gameMode: "sandbox",
      economyPreset: "standard",
      sandbox: {
        templateId: "crossroads",
        startingCapital: 125_000,
        demandMultiplier: 1,
        moveInRate: "paused",
      },
    },
  });

  const envelope = buildSaveEnvelope({
    city: { id: "city-1", name: "North Loop" },
    cityCreatedAt: "2026-08-01T10:00:00.000Z",
    savedAt: "2026-08-01T10:05:00.000Z",
    appVersion: "0.1.0",
    snapshot,
  });

  expect(envelope).toMatchObject({
    format: "caelum-save",
    envelopeVersion: 1,
    snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
    summary: {
      gameMode: "sandbox",
      economyPreset: "standard",
      sandboxTemplateId: "crossroads",
    },
  });
  expect(envelope.snapshot).toBe(snapshot);
});

import { expect, it } from "vitest";
import {
  createMemorySaveStore,
  createMemorySaveStoreFailureControls,
} from "../../../src/persistence/memorySaveStore";
import type { WritableSaveEnvelope } from "../../../src/persistence/envelope";
import { makeEnvelope, makeRustSnapshot } from "./fixtures";
import { expectError, expectOk } from "./storeTestUtils";

function envelopeFor(
  cityId: string,
  name: string,
  overrides: Partial<WritableSaveEnvelope> = {},
): WritableSaveEnvelope {
  return makeEnvelope({
    city: { id: cityId, name },
    ...overrides,
  });
}

it("preserves the previous working save after an aborted replacement", async () => {
  const failures = createMemorySaveStoreFailureControls();
  const store = createMemorySaveStore({ failures });
  await expectOk(
    store.writeWorkingSave(
      makeEnvelope({ savedAt: "2026-08-01T10:00:00.000Z" }),
    ),
  );
  const failNext = failures.failNext;
  failNext("writeWorkingSave", "transactionAborted");
  await expectError(
    store.writeWorkingSave(
      makeEnvelope({ savedAt: "2026-08-01T11:00:00.000Z" }),
    ),
    "transactionAborted",
  );

  expect(await expectOk(store.readWorkingSave("city-1"))).toMatchObject({
    savedAt: "2026-08-01T10:00:00.000Z",
  });
});

it("stores and returns detached working-save values", async () => {
  const store = createMemorySaveStore();
  const candidate = makeEnvelope();
  await expectOk(store.writeWorkingSave(candidate));

  candidate.city.name = "mutated input";
  candidate.snapshot.budget = 1;
  const firstRead = (await expectOk(
    store.readWorkingSave("city-1"),
  )) as WritableSaveEnvelope;
  firstRead.city.name = "mutated result";
  firstRead.snapshot.budget = 2;

  expect(await expectOk(store.readWorkingSave("city-1"))).toMatchObject({
    city: { id: "city-1", name: "Test City" },
    snapshot: { budget: 120_000 },
  });

  const cities = await expectOk(store.listCities());
  cities[0]!.summary!.gameMode = "campaign";
  expect(await expectOk(store.listCities())).toMatchObject([
    {
      cityId: "city-1",
      name: "Test City",
      summary: { gameMode: "sandbox" },
    },
  ]);
});

it("maps a candidate clone failure to serializationFailed without replacing the working save", async () => {
  const store = createMemorySaveStore();
  const original = makeEnvelope({ savedAt: "2026-08-01T10:00:00.000Z" });
  await expectOk(store.writeWorkingSave(original));
  const uncloneable = makeEnvelope({
    savedAt: "2026-08-01T11:00:00.000Z",
    snapshot: {
      ...makeRustSnapshot(),
      uncloneable: () => undefined,
    } as never,
  });

  const error = await expectError(
    store.writeWorkingSave(uncloneable),
    "serializationFailed",
  );

  expect(error.operation).toBe("writeWorkingSave");
  expect(await expectOk(store.readWorkingSave("city-1"))).toEqual(original);
});

it.each([
  {
    label: "rename",
    run: (store: ReturnType<typeof createMemorySaveStore>) =>
      store.renameCity("city-1", "Renamed"),
  },
  {
    label: "duplicate",
    run: (store: ReturnType<typeof createMemorySaveStore>) =>
      store.duplicateCity("city-1", {
        cityId: "city-2",
        name: "Duplicate",
        cityCreatedAt: "2026-08-01T12:00:00.000Z",
        savedAt: "2026-08-01T12:05:00.000Z",
        appVersion: "0.2.0",
      }),
  },
])("classifies unsupported $label sources as incompatible", async ({ run }) => {
  const store = createMemorySaveStore();
  const unsupported = { ...makeEnvelope(), envelopeVersion: 99 };
  store.seedRawWorking("city-1", unsupported);

  await expectError(run(store), "incompatibleRecord");
  expect(await expectOk(store.readWorkingSave("city-1"))).toEqual(unsupported);
});

it.each([
  {
    label: "rename corrupt headers",
    raw: {},
    run: (store: ReturnType<typeof createMemorySaveStore>) =>
      store.renameCity("city-1", "Renamed"),
  },
  {
    label: "duplicate schema mismatches",
    raw: makeEnvelope({
      snapshot: { ...makeRustSnapshot(), schemaVersion: 3 } as never,
    }),
    run: (store: ReturnType<typeof createMemorySaveStore>) =>
      store.duplicateCity("city-1", {
        cityId: "city-2",
        name: "Duplicate",
        cityCreatedAt: "2026-08-01T12:00:00.000Z",
        savedAt: "2026-08-01T12:05:00.000Z",
        appVersion: "0.2.0",
      }),
  },
])("classifies $label as corrupt", async ({ raw, run }) => {
  const store = createMemorySaveStore();
  store.seedRawWorking("city-1", raw);

  await expectError(run(store), "corruptRecord");
  expect(await expectOk(store.readWorkingSave("city-1"))).toEqual(raw);
});

it("rejects a duplicate target conflict without changing either city", async () => {
  const store = createMemorySaveStore();
  const source = envelopeFor("city-source", "Source");
  const target = envelopeFor("city-target", "Existing Target", {
    savedAt: "2026-08-01T11:00:00.000Z",
  });
  await expectOk(store.writeWorkingSave(source));
  await expectOk(store.writeWorkingSave(target));

  await expectError(
    store.duplicateCity("city-source", {
      cityId: "city-target",
      name: "Replacement",
      cityCreatedAt: "2026-08-01T12:00:00.000Z",
      savedAt: "2026-08-01T12:05:00.000Z",
      appVersion: "0.2.0",
    }),
    "conflict",
  );

  expect(await expectOk(store.readWorkingSave("city-source"))).toEqual(source);
  expect(await expectOk(store.readWorkingSave("city-target"))).toEqual(target);
});

it("renames only the city name and preserves every other envelope field", async () => {
  const store = createMemorySaveStore();
  const original = makeEnvelope();
  await expectOk(store.writeWorkingSave(original));

  const summary = await expectOk(store.renameCity("city-1", "North Loop"));

  const renamed = await expectOk(store.readWorkingSave("city-1"));
  expect(renamed).toEqual({
    ...original,
    city: { id: "city-1", name: "North Loop" },
  });
  expect(summary).toMatchObject({
    cityId: "city-1",
    name: "North Loop",
    cityCreatedAt: original.cityCreatedAt,
    savedAt: original.savedAt,
    appVersion: original.appVersion,
    snapshotSchemaVersion: original.snapshotSchemaVersion,
    summary: original.summary,
    compatibility: { status: "candidate" },
  });
});

it("duplicates only the working save as an isolated target identity", async () => {
  const store = createMemorySaveStore();
  const source = envelopeFor("city-source", "Source");
  await expectOk(store.writeWorkingSave(source));

  await expectOk(
    store.duplicateCity("city-source", {
      cityId: "city-target",
      name: "Duplicate",
      cityCreatedAt: "2026-08-01T12:00:00.000Z",
      savedAt: "2026-08-01T12:05:00.000Z",
      appVersion: "0.2.0",
    }),
  );
  const duplicate = (await expectOk(
    store.readWorkingSave("city-target"),
  )) as WritableSaveEnvelope;
  duplicate.snapshot.budget = 1;
  await expectOk(store.renameCity("city-target", "Changed Duplicate"));

  expect(await expectOk(store.readWorkingSave("city-source"))).toEqual(source);
  expect(await expectOk(store.readWorkingSave("city-target"))).toEqual({
    ...source,
    city: { id: "city-target", name: "Changed Duplicate" },
    cityCreatedAt: "2026-08-01T12:00:00.000Z",
    savedAt: "2026-08-01T12:05:00.000Z",
    appVersion: "0.2.0",
  });
});

it("deletes a city by storage identity and leaves other cities intact", async () => {
  const store = createMemorySaveStore();
  const retained = envelopeFor("city-retained", "Retained");
  await expectOk(store.writeWorkingSave(retained));
  store.seedRawWorking("city-deleted", { corrupt: true });

  await expectOk(store.deleteCity("city-deleted"));

  await expectError(store.readWorkingSave("city-deleted"), "notFound");
  expect(await expectOk(store.listCheckpoints("city-deleted"))).toEqual([]);
  expect(await expectOk(store.listAutosaves("city-deleted"))).toEqual({
    items: [],
    generationHighWaterMark: null,
  });
  expect(await expectOk(store.readWorkingSave("city-retained"))).toEqual(
    retained,
  );
});

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

it("creates detached checkpoints with the envelope save time", async () => {
  const store = createMemorySaveStore();
  const envelope = makeEnvelope({ savedAt: "2026-08-01T12:34:56.000Z" });

  const summary = await expectOk(
    store.writeCheckpoint({
      checkpointId: "checkpoint-1",
      cityId: "city-1",
      name: "Before downtown",
      note: "Keep this layout",
      envelope,
    }),
  );
  envelope.city.name = "Mutated input";
  envelope.snapshot.budget = 1;
  summary.summary!.gameMode = "campaign";

  expect(await expectOk(store.listCheckpoints("city-1"))).toMatchObject([
    {
      checkpointId: "checkpoint-1",
      cityId: "city-1",
      name: "Before downtown",
      note: "Keep this layout",
      createdAt: "2026-08-01T12:34:56.000Z",
      summary: { gameMode: "sandbox" },
    },
  ]);
  expect(
    await expectOk(store.readCheckpoint("city-1", "checkpoint-1")),
  ).toMatchObject({
    city: { id: "city-1", name: "Test City" },
    savedAt: "2026-08-01T12:34:56.000Z",
    snapshot: { budget: 120_000 },
  });
});

it("keeps checkpoint writes create-only", async () => {
  const store = createMemorySaveStore();
  const original = makeEnvelope({ savedAt: "2026-08-01T10:00:00.000Z" });
  await expectOk(
    store.writeCheckpoint({
      checkpointId: "checkpoint-fixed",
      cityId: "city-1",
      name: "Original",
      note: null,
      envelope: original,
    }),
  );

  await expectError(
    store.writeCheckpoint({
      checkpointId: "checkpoint-fixed",
      cityId: "city-1",
      name: "Replacement",
      note: "must not replace",
      envelope: makeEnvelope({ savedAt: "2026-08-01T11:00:00.000Z" }),
    }),
    "conflict",
  );

  expect(
    await expectOk(store.readCheckpoint("city-1", "checkpoint-fixed")),
  ).toEqual(original);
  expect(await expectOk(store.listCheckpoints("city-1"))).toMatchObject([
    { name: "Original", note: null, createdAt: "2026-08-01T10:00:00.000Z" },
  ]);
});

it("renames only the checkpoint name and deletes only the selected checkpoint", async () => {
  const store = createMemorySaveStore();
  const firstEnvelope = makeEnvelope({ savedAt: "2026-08-01T10:00:00.000Z" });
  const secondEnvelope = makeEnvelope({ savedAt: "2026-08-01T11:00:00.000Z" });
  await expectOk(
    store.writeCheckpoint({
      checkpointId: "checkpoint-first",
      cityId: "city-1",
      name: "First",
      note: "preserve me",
      envelope: firstEnvelope,
    }),
  );
  await expectOk(
    store.writeCheckpoint({
      checkpointId: "checkpoint-second",
      cityId: "city-1",
      name: "Second",
      note: null,
      envelope: secondEnvelope,
    }),
  );

  const renamed = await expectOk(
    store.renameCheckpoint("city-1", "checkpoint-first", "Renamed"),
  );
  await expectOk(store.deleteCheckpoint("city-1", "checkpoint-second"));

  expect(renamed).toMatchObject({
    checkpointId: "checkpoint-first",
    cityId: "city-1",
    name: "Renamed",
    note: "preserve me",
    createdAt: "2026-08-01T10:00:00.000Z",
  });
  expect(
    await expectOk(store.readCheckpoint("city-1", "checkpoint-first")),
  ).toEqual(firstEnvelope);
  expect(await expectOk(store.listCheckpoints("city-1"))).toMatchObject([
    {
      checkpointId: "checkpoint-first",
      name: "Renamed",
      note: "preserve me",
      createdAt: "2026-08-01T10:00:00.000Z",
    },
  ]);
  await expectError(
    store.readCheckpoint("city-1", "checkpoint-second"),
    "notFound",
  );
});

it.each([
  {
    label: "checkpoint",
    run: (store: ReturnType<typeof createMemorySaveStore>) =>
      store.writeCheckpoint({
        checkpointId: "checkpoint-mismatch",
        cityId: "city-other",
        name: "Mismatch",
        note: null,
        envelope: makeEnvelope(),
      }),
    list: (store: ReturnType<typeof createMemorySaveStore>) =>
      store.listCheckpoints("city-other"),
    empty: [],
  },
  {
    label: "autosave",
    run: (store: ReturnType<typeof createMemorySaveStore>) =>
      store.writeAutosave({
        autosaveId: "autosave-mismatch",
        cityId: "city-other",
        generation: 1,
        envelope: makeEnvelope(),
      }),
    list: (store: ReturnType<typeof createMemorySaveStore>) =>
      store.listAutosaves("city-other"),
    empty: { items: [], generationHighWaterMark: null },
  },
])(
  "rejects a $label whose city key disagrees with its envelope",
  async ({ run, list, empty }) => {
    const store = createMemorySaveStore();

    await expectError(run(store), "corruptRecord");

    expect(await expectOk<unknown>(list(store))).toEqual(empty);
  },
);

it.each([
  { label: "negative", generation: -1 },
  { label: "fractional", generation: 1.5 },
  { label: "unsafe", generation: Number.MAX_SAFE_INTEGER + 1 },
  { label: "NaN", generation: Number.NaN },
  { label: "infinite", generation: Number.POSITIVE_INFINITY },
])(
  "rejects a $label autosave generation without advancing high-water",
  async ({ generation }) => {
    const store = createMemorySaveStore();

    await expectError(
      store.writeAutosave({
        autosaveId: "autosave-invalid",
        cityId: "city-1",
        generation,
        envelope: makeEnvelope(),
      }),
      "corruptRecord",
    );

    expect(await expectOk(store.listAutosaves("city-1"))).toEqual({
      items: [],
      generationHighWaterMark: null,
    });
  },
);

it("creates detached autosaves with the envelope save time", async () => {
  const store = createMemorySaveStore();
  const envelope = makeEnvelope({ savedAt: "2026-08-01T12:34:56.000Z" });

  const summary = await expectOk(
    store.writeAutosave({
      autosaveId: "autosave-1",
      cityId: "city-1",
      generation: 7,
      envelope,
    }),
  );
  envelope.city.name = "Mutated input";
  envelope.snapshot.budget = 1;
  summary.summary!.gameMode = "campaign";

  expect(await expectOk(store.listAutosaves("city-1"))).toMatchObject({
    items: [
      {
        autosaveId: "autosave-1",
        cityId: "city-1",
        generation: 7,
        createdAt: "2026-08-01T12:34:56.000Z",
        summary: { gameMode: "sandbox" },
      },
    ],
    generationHighWaterMark: 7,
  });
  expect(
    await expectOk(store.readAutosave("city-1", "autosave-1")),
  ).toMatchObject({
    city: { id: "city-1", name: "Test City" },
    savedAt: "2026-08-01T12:34:56.000Z",
    snapshot: { budget: 120_000 },
  });
});

it("keeps autosave IDs create-only without advancing high-water", async () => {
  const store = createMemorySaveStore();
  const original = makeEnvelope({ savedAt: "2026-08-01T10:00:00.000Z" });
  await expectOk(
    store.writeAutosave({
      autosaveId: "autosave-fixed",
      cityId: "city-1",
      generation: 1,
      envelope: original,
    }),
  );

  await expectError(
    store.writeAutosave({
      autosaveId: "autosave-fixed",
      cityId: "city-1",
      generation: 2,
      envelope: makeEnvelope({ savedAt: "2026-08-01T11:00:00.000Z" }),
    }),
    "conflict",
  );

  expect(
    await expectOk(store.readAutosave("city-1", "autosave-fixed")),
  ).toEqual(original);
  expect(await expectOk(store.listAutosaves("city-1"))).toMatchObject({
    items: [{ autosaveId: "autosave-fixed", generation: 1 }],
    generationHighWaterMark: 1,
  });
});

it("keeps high-water after pruning and rejects reuse", async () => {
  const store = createMemorySaveStore();
  await expectOk(store.writeWorkingSave(makeEnvelope()));
  await expectOk(
    store.writeAutosave({
      autosaveId: "auto-10",
      cityId: "city-1",
      generation: 10,
      envelope: makeEnvelope(),
    }),
  );
  await expectOk(store.deleteAutosave("city-1", "auto-10"));
  expect(await expectOk(store.listAutosaves("city-1"))).toEqual({
    items: [],
    generationHighWaterMark: 10,
  });
  await expectError(
    store.writeAutosave({
      autosaveId: "auto-reused",
      cityId: "city-1",
      generation: 10,
      envelope: makeEnvelope(),
    }),
    "conflict",
  );
});

it("does not advance autosave high-water when an injected write fails", async () => {
  const failures = createMemorySaveStoreFailureControls();
  const store = createMemorySaveStore({ failures });
  failures.failNext("writeAutosave", "transactionAborted");

  await expectError(
    store.writeAutosave({
      autosaveId: "autosave-aborted",
      cityId: "city-1",
      generation: 8,
      envelope: makeEnvelope(),
    }),
    "transactionAborted",
  );

  expect(await expectOk(store.listAutosaves("city-1"))).toEqual({
    items: [],
    generationHighWaterMark: null,
  });
  await expectOk(
    store.writeAutosave({
      autosaveId: "autosave-retry",
      cityId: "city-1",
      generation: 8,
      envelope: makeEnvelope(),
    }),
  );
});

it("does not advance autosave high-water when cloning fails", async () => {
  const store = createMemorySaveStore();
  const uncloneable = makeEnvelope({
    snapshot: {
      ...makeRustSnapshot(),
      uncloneable: () => undefined,
    } as never,
  });

  await expectError(
    store.writeAutosave({
      autosaveId: "autosave-uncloneable",
      cityId: "city-1",
      generation: 8,
      envelope: uncloneable,
    }),
    "serializationFailed",
  );

  expect(await expectOk(store.listAutosaves("city-1"))).toEqual({
    items: [],
    generationHighWaterMark: null,
  });
});

it("deletes checkpoint, autosave, and high-water state with the city", async () => {
  const store = createMemorySaveStore();
  await expectOk(store.writeWorkingSave(makeEnvelope()));
  await expectOk(
    store.writeCheckpoint({
      checkpointId: "checkpoint-1",
      cityId: "city-1",
      name: "Checkpoint",
      note: null,
      envelope: makeEnvelope(),
    }),
  );
  await expectOk(
    store.writeAutosave({
      autosaveId: "autosave-1",
      cityId: "city-1",
      generation: 3,
      envelope: makeEnvelope(),
    }),
  );

  await expectOk(store.deleteCity("city-1"));

  await expectError(store.readCheckpoint("city-1", "checkpoint-1"), "notFound");
  await expectError(store.readAutosave("city-1", "autosave-1"), "notFound");
  expect(await expectOk(store.listCheckpoints("city-1"))).toEqual([]);
  expect(await expectOk(store.listAutosaves("city-1"))).toEqual({
    items: [],
    generationHighWaterMark: null,
  });
});

it("duplicates a city without copying checkpoints, autosaves, or high-water", async () => {
  const store = createMemorySaveStore();
  await expectOk(store.writeWorkingSave(makeEnvelope()));
  await expectOk(
    store.writeCheckpoint({
      checkpointId: "checkpoint-1",
      cityId: "city-1",
      name: "Checkpoint",
      note: null,
      envelope: makeEnvelope(),
    }),
  );
  await expectOk(
    store.writeAutosave({
      autosaveId: "autosave-1",
      cityId: "city-1",
      generation: 3,
      envelope: makeEnvelope(),
    }),
  );

  await expectOk(
    store.duplicateCity("city-1", {
      cityId: "city-copy",
      name: "Copy",
      cityCreatedAt: "2026-08-01T12:00:00.000Z",
      savedAt: "2026-08-01T12:05:00.000Z",
      appVersion: "0.2.0",
    }),
  );

  expect(await expectOk(store.listCheckpoints("city-copy"))).toEqual([]);
  expect(await expectOk(store.listAutosaves("city-copy"))).toEqual({
    items: [],
    generationHighWaterMark: null,
  });
});

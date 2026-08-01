import { describe, expect, it } from "vitest";
import type { WritableSaveEnvelope } from "../../../src/persistence/envelope";
import type {
  SaveStore,
  SaveStoreErrorCode,
  SaveStoreOperation,
} from "../../../src/persistence/saveStore";
import { makeEnvelope, makeRustSnapshot } from "./fixtures";
import { expectError, expectOk } from "./storeTestUtils";

export interface SaveStoreContractHarness {
  store: SaveStore;
  reopen?: () => Promise<SaveStore>;
  failNext?: (operation: SaveStoreOperation, code: SaveStoreErrorCode) => void;
  seedRawWorking(cityId: string, value: unknown): void;
}

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

export function defineSaveStoreContract(
  name: string,
  createHarness: () => SaveStoreContractHarness,
): void {
  describe(`${name} SaveStore contract`, () => {
    describe("ordering", () => {
      it("lists cities by save time then ID and places corrupt records last", async () => {
        const { store, seedRawWorking } = createHarness();
        await expectOk(
          store.writeWorkingSave(
            envelopeFor("city-b", "B", {
              savedAt: "2026-08-01T10:00:00.000Z",
            }),
          ),
        );
        await expectOk(
          store.writeWorkingSave(
            envelopeFor("city-a", "A", {
              savedAt: "2026-08-01T10:00:00.000Z",
            }),
          ),
        );
        await expectOk(
          store.writeWorkingSave(
            envelopeFor("city-newest", "Newest", {
              savedAt: "2026-08-01T11:00:00.000Z",
            }),
          ),
        );
        seedRawWorking("city-corrupt", { format: "broken" });

        expect(
          (await expectOk(store.listCities())).map((item) => item.cityId),
        ).toEqual(["city-newest", "city-a", "city-b", "city-corrupt"]);
      });

      it("lists checkpoints by creation time then ID", async () => {
        const { store } = createHarness();
        for (const [checkpointId, savedAt] of [
          ["checkpoint-b", "2026-08-01T10:00:00.000Z"],
          ["checkpoint-a", "2026-08-01T10:00:00.000Z"],
          ["checkpoint-newest", "2026-08-01T11:00:00.000Z"],
        ] as const) {
          await expectOk(
            store.writeCheckpoint({
              checkpointId,
              cityId: "city-1",
              name: checkpointId,
              note: null,
              envelope: makeEnvelope({ savedAt }),
            }),
          );
        }

        expect(
          (await expectOk(store.listCheckpoints("city-1"))).map(
            (item) => item.checkpointId,
          ),
        ).toEqual(["checkpoint-newest", "checkpoint-a", "checkpoint-b"]);
      });

      it("lists autosaves by generation then ID", async () => {
        const { store } = createHarness();
        for (const [autosaveId, generation] of [
          ["autosave-z", 1],
          ["autosave-b", 2],
          ["autosave-a", 3],
        ] as const) {
          await expectOk(
            store.writeAutosave({
              autosaveId,
              cityId: "city-1",
              generation,
              envelope: makeEnvelope(),
            }),
          );
        }

        expect(
          (await expectOk(store.listAutosaves("city-1"))).items.map(
            (item) => item.autosaveId,
          ),
        ).toEqual(["autosave-a", "autosave-b", "autosave-z"]);
      });
    });

    describe("detachment", () => {
      it("stores and returns detached working-save values", async () => {
        const { store } = createHarness();
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

      it("stores and returns detached checkpoint values", async () => {
        const { store } = createHarness();
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
        const firstRead = (await expectOk(
          store.readCheckpoint("city-1", "checkpoint-1"),
        )) as WritableSaveEnvelope;
        firstRead.snapshot.budget = 2;

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

      it("stores and returns detached autosave values", async () => {
        const { store } = createHarness();
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
        const firstRead = (await expectOk(
          store.readAutosave("city-1", "autosave-1"),
        )) as WritableSaveEnvelope;
        firstRead.snapshot.budget = 2;

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
    });

    describe("replacement atomicity", () => {
      it("preserves the previous working save after an aborted replacement", async () => {
        const { store, failNext } = createHarness();
        if (failNext === undefined) return;
        await expectOk(
          store.writeWorkingSave(
            makeEnvelope({ savedAt: "2026-08-01T10:00:00.000Z" }),
          ),
        );
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

      it("maps clone failure to serializationFailed without replacing the working save", async () => {
        const { store } = createHarness();
        const original = makeEnvelope({
          savedAt: "2026-08-01T10:00:00.000Z",
        });
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
        expect(await expectOk(store.readWorkingSave("city-1"))).toEqual(
          original,
        );
      });
    });

    describe("source inspection", () => {
      it.each([
        {
          label: "rename",
          run: (store: SaveStore) => store.renameCity("city-1", "Renamed"),
        },
        {
          label: "duplicate",
          run: (store: SaveStore) =>
            store.duplicateCity("city-1", {
              cityId: "city-2",
              name: "Duplicate",
              cityCreatedAt: "2026-08-01T12:00:00.000Z",
              savedAt: "2026-08-01T12:05:00.000Z",
              appVersion: "0.2.0",
            }),
        },
      ])(
        "classifies unsupported $label sources as incompatible",
        async ({ run }) => {
          const { store, seedRawWorking } = createHarness();
          const unsupported = { ...makeEnvelope(), envelopeVersion: 99 };
          seedRawWorking("city-1", unsupported);

          await expectError(run(store), "incompatibleRecord");
          expect(await expectOk(store.readWorkingSave("city-1"))).toEqual(
            unsupported,
          );
        },
      );

      it.each([
        {
          label: "rename corrupt headers",
          raw: {},
          run: (store: SaveStore) => store.renameCity("city-1", "Renamed"),
        },
        {
          label: "duplicate schema mismatches",
          raw: makeEnvelope({
            snapshot: { ...makeRustSnapshot(), schemaVersion: 3 } as never,
          }),
          run: (store: SaveStore) =>
            store.duplicateCity("city-1", {
              cityId: "city-2",
              name: "Duplicate",
              cityCreatedAt: "2026-08-01T12:00:00.000Z",
              savedAt: "2026-08-01T12:05:00.000Z",
              appVersion: "0.2.0",
            }),
        },
      ])("classifies $label as corrupt", async ({ raw, run }) => {
        const { store, seedRawWorking } = createHarness();
        seedRawWorking("city-1", raw);

        await expectError(run(store), "corruptRecord");
        expect(await expectOk(store.readWorkingSave("city-1"))).toEqual(raw);
      });

      it("renames only the city name and preserves every other envelope field", async () => {
        const { store } = createHarness();
        const original = makeEnvelope();
        await expectOk(store.writeWorkingSave(original));

        const summary = await expectOk(
          store.renameCity("city-1", "North Loop"),
        );

        expect(await expectOk(store.readWorkingSave("city-1"))).toEqual({
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

      it("deletes unsupported and corrupt cities by storage identity", async () => {
        const { store, seedRawWorking } = createHarness();
        seedRawWorking("city-unsupported", {
          ...makeEnvelope(),
          envelopeVersion: 99,
        });
        seedRawWorking("city-corrupt", { format: "broken" });

        await expectOk(store.deleteCity("city-unsupported"));
        await expectOk(store.deleteCity("city-corrupt"));

        await expectError(
          store.readWorkingSave("city-unsupported"),
          "notFound",
        );
        await expectError(store.readWorkingSave("city-corrupt"), "notFound");
      });
    });

    describe("create-only conflicts", () => {
      it("rejects a duplicate target conflict without changing either city", async () => {
        const { store } = createHarness();
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

        expect(await expectOk(store.readWorkingSave("city-source"))).toEqual(
          source,
        );
        expect(await expectOk(store.readWorkingSave("city-target"))).toEqual(
          target,
        );
      });

      it("keeps checkpoint writes create-only", async () => {
        const { store } = createHarness();
        const original = makeEnvelope({
          savedAt: "2026-08-01T10:00:00.000Z",
        });
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
            envelope: makeEnvelope({
              savedAt: "2026-08-01T11:00:00.000Z",
            }),
          }),
          "conflict",
        );

        expect(
          await expectOk(store.readCheckpoint("city-1", "checkpoint-fixed")),
        ).toEqual(original);
        expect(await expectOk(store.listCheckpoints("city-1"))).toMatchObject([
          { name: "Original", note: null, createdAt: original.savedAt },
        ]);
      });

      it("keeps autosave IDs create-only without advancing high-water", async () => {
        const { store } = createHarness();
        const original = makeEnvelope({
          savedAt: "2026-08-01T10:00:00.000Z",
        });
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
            envelope: makeEnvelope({
              savedAt: "2026-08-01T11:00:00.000Z",
            }),
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
    });

    describe("key and timestamp corruption", () => {
      it.each([
        {
          label: "checkpoint",
          run: (store: SaveStore) =>
            store.writeCheckpoint({
              checkpointId: "checkpoint-mismatch",
              cityId: "city-other",
              name: "Mismatch",
              note: null,
              envelope: makeEnvelope(),
            }),
          list: (store: SaveStore) => store.listCheckpoints("city-other"),
          empty: [],
        },
        {
          label: "autosave",
          run: (store: SaveStore) =>
            store.writeAutosave({
              autosaveId: "autosave-mismatch",
              cityId: "city-other",
              generation: 1,
              envelope: makeEnvelope(),
            }),
          list: (store: SaveStore) => store.listAutosaves("city-other"),
          empty: { items: [], generationHighWaterMark: null },
        },
      ])(
        "rejects a $label whose city key disagrees with its envelope",
        async ({ run, list, empty }) => {
          const { store } = createHarness();

          await expectError(run(store), "corruptRecord");
          expect(await expectOk<unknown>(list(store))).toEqual(empty);
        },
      );

      it("derives checkpoint and autosave creation times from envelope savedAt", async () => {
        const { store } = createHarness();
        const checkpointEnvelope = makeEnvelope({
          savedAt: "2026-08-01T12:34:56.000Z",
        });
        const autosaveEnvelope = makeEnvelope({
          savedAt: "2026-08-01T12:35:56.000Z",
        });

        const checkpoint = await expectOk(
          store.writeCheckpoint({
            checkpointId: "checkpoint-1",
            cityId: "city-1",
            name: "Checkpoint",
            note: null,
            envelope: checkpointEnvelope,
          }),
        );
        const autosave = await expectOk(
          store.writeAutosave({
            autosaveId: "autosave-1",
            cityId: "city-1",
            generation: 1,
            envelope: autosaveEnvelope,
          }),
        );

        expect(checkpoint.createdAt).toBe(checkpointEnvelope.savedAt);
        expect(autosave.createdAt).toBe(autosaveEnvelope.savedAt);
      });
    });

    describe("checkpoint lifecycle", () => {
      it("renames only the checkpoint name and deletes only the selected checkpoint", async () => {
        const { store } = createHarness();
        const firstEnvelope = makeEnvelope({
          savedAt: "2026-08-01T10:00:00.000Z",
        });
        const secondEnvelope = makeEnvelope({
          savedAt: "2026-08-01T11:00:00.000Z",
        });
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
          createdAt: firstEnvelope.savedAt,
        });
        expect(
          await expectOk(store.readCheckpoint("city-1", "checkpoint-first")),
        ).toEqual(firstEnvelope);
        expect(await expectOk(store.listCheckpoints("city-1"))).toMatchObject([
          {
            checkpointId: "checkpoint-first",
            name: "Renamed",
            note: "preserve me",
            createdAt: firstEnvelope.savedAt,
          },
        ]);
        await expectError(
          store.readCheckpoint("city-1", "checkpoint-second"),
          "notFound",
        );
      });
    });

    describe("high-water behavior", () => {
      it.each([
        { label: "negative", generation: -1 },
        { label: "fractional", generation: 1.5 },
        { label: "unsafe", generation: Number.MAX_SAFE_INTEGER + 1 },
        { label: "NaN", generation: Number.NaN },
        { label: "infinite", generation: Number.POSITIVE_INFINITY },
      ])(
        "rejects a $label generation without advancing high-water",
        async ({ generation }) => {
          const { store } = createHarness();

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

      it("keeps high-water after pruning and rejects generation reuse", async () => {
        const harness = createHarness();
        await expectOk(
          harness.store.writeAutosave({
            autosaveId: "autosave-10",
            cityId: "city-1",
            generation: 10,
            envelope: makeEnvelope(),
          }),
        );
        await expectOk(harness.store.deleteAutosave("city-1", "autosave-10"));
        const store = harness.reopen ? await harness.reopen() : harness.store;

        expect(await expectOk(store.listAutosaves("city-1"))).toEqual({
          items: [],
          generationHighWaterMark: 10,
        });
        await expectError(
          store.writeAutosave({
            autosaveId: "autosave-reused",
            cityId: "city-1",
            generation: 10,
            envelope: makeEnvelope(),
          }),
          "conflict",
        );
      });

      it("does not advance high-water when an injected write fails", async () => {
        const { store, failNext } = createHarness();
        if (failNext === undefined) return;
        failNext("writeAutosave", "transactionAborted");

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

      it("does not advance high-water when cloning fails", async () => {
        const { store } = createHarness();
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
    });

    describe("cascade deletion", () => {
      it("deletes the working save, checkpoints, autosaves, and high-water with the city", async () => {
        const { store } = createHarness();
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

        await expectError(store.readWorkingSave("city-1"), "notFound");
        await expectError(
          store.readCheckpoint("city-1", "checkpoint-1"),
          "notFound",
        );
        await expectError(
          store.readAutosave("city-1", "autosave-1"),
          "notFound",
        );
        expect(await expectOk(store.listCheckpoints("city-1"))).toEqual([]);
        expect(await expectOk(store.listAutosaves("city-1"))).toEqual({
          items: [],
          generationHighWaterMark: null,
        });
      });

      it("deletes one city by storage identity and leaves other cities intact", async () => {
        const { store, seedRawWorking } = createHarness();
        const retained = envelopeFor("city-retained", "Retained");
        await expectOk(store.writeWorkingSave(retained));
        seedRawWorking("city-deleted", { corrupt: true });

        await expectOk(store.deleteCity("city-deleted"));

        expect(await expectOk(store.readWorkingSave("city-retained"))).toEqual(
          retained,
        );
      });
    });

    describe("duplicate isolation", () => {
      it("duplicates only the working save with an isolated target identity", async () => {
        const { store } = createHarness();
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

        expect(await expectOk(store.readWorkingSave("city-source"))).toEqual(
          source,
        );
        expect(await expectOk(store.readWorkingSave("city-target"))).toEqual({
          ...source,
          city: { id: "city-target", name: "Changed Duplicate" },
          cityCreatedAt: "2026-08-01T12:00:00.000Z",
          savedAt: "2026-08-01T12:05:00.000Z",
          appVersion: "0.2.0",
        });
      });

      it("does not copy checkpoints, autosaves, or high-water to a duplicate", async () => {
        const { store } = createHarness();
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

      it("keeps checkpoint creation independent from the working save", async () => {
        const { store } = createHarness();
        await expectOk(
          store.writeCheckpoint({
            checkpointId: "checkpoint-1",
            cityId: "city-1",
            name: "Checkpoint",
            note: null,
            envelope: makeEnvelope(),
          }),
        );

        await expectError(store.readWorkingSave("city-1"), "notFound");
        expect(
          await expectOk(store.readCheckpoint("city-1", "checkpoint-1")),
        ).toEqual(makeEnvelope());
      });
    });
  });
}

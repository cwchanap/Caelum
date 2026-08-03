import { describe, expect, it } from "vitest";
import type { WritableSaveEnvelope } from "../../../src/persistence/envelope";
import type {
  SaveStore,
  SaveStoreErrorCode,
  SaveStoreOperation,
  SaveStoreResult,
} from "../../../src/persistence/saveStore";
import { makeEnvelope, makeRustSnapshot } from "./fixtures";
import { expectError, expectOk } from "./storeTestUtils";

export interface SaveStoreContractHarness {
  store: SaveStore;
  reopen?: () => Promise<SaveStore>;
  failNext?: (operation: SaveStoreOperation, code: SaveStoreErrorCode) => void;
  seedRawWorking?: (cityId: string, value: unknown) => void;
  seedRawCheckpoint?: (seed: RawCheckpointSeed) => void;
  seedRawAutosave?: (seed: RawAutosaveSeed) => void;
}

export interface RawCheckpointSeed {
  storageCityId: string;
  storageCheckpointId: string;
  checkpointId: string;
  cityId: string;
  name: string;
  note: string | null;
  createdAt: string;
  envelope: unknown;
}

export interface RawAutosaveSeed {
  storageCityId: string;
  storageAutosaveId: string;
  autosaveId: string;
  cityId: string;
  generation: number;
  createdAt: string;
  envelope: unknown;
  generationHighWaterMark?: number;
}

export interface SaveStoreContractCapabilities {
  injectedStorageFailures: boolean;
  rawGenerationRecords: boolean;
  rawWorkingRecords: boolean;
  reopenPersistence: boolean;
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

function valueThatThrowsWhileCloning(): object {
  return Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      throw new Error("hostile clone getter");
    },
  });
}

export function defineSaveStoreContract(
  name: string,
  createHarness: () => SaveStoreContractHarness,
  capabilities: Readonly<SaveStoreContractCapabilities>,
): void {
  const injectedFailureIt = capabilities.injectedStorageFailures ? it : it.skip;
  const rawGenerationIt = capabilities.rawGenerationRecords ? it : it.skip;
  const rawWorkingIt = capabilities.rawWorkingRecords ? it : it.skip;
  const reopenIt = capabilities.reopenPersistence ? it : it.skip;

  function requireCapability<TValue>(
    value: TValue | undefined,
    capability: string,
  ): TValue {
    if (value === undefined) {
      throw new Error(`${name} declares ${capability} but does not provide it`);
    }
    return value;
  }

  describe(`${name} SaveStore contract`, () => {
    describe("ordering", () => {
      rawWorkingIt(
        "lists cities by save time then ID and places corrupt records last",
        async () => {
          const { store, seedRawWorking } = createHarness();
          const seedWorking = requireCapability(
            seedRawWorking,
            "rawWorkingRecords",
          );
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
          seedWorking("city-corrupt", { format: "broken" });

          expect(
            (await expectOk(store.listCities())).map((item) => item.cityId),
          ).toEqual(["city-newest", "city-a", "city-b", "city-corrupt"]);
        },
      );

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
      injectedFailureIt(
        "preserves the previous working save after an aborted replacement",
        async () => {
          const { store, failNext } = createHarness();
          const injectFailure = requireCapability(
            failNext,
            "injectedStorageFailures",
          );
          await expectOk(
            store.writeWorkingSave(
              makeEnvelope({ savedAt: "2026-08-01T10:00:00.000Z" }),
            ),
          );
          injectFailure("writeWorkingSave", "transactionAborted");

          await expectError(
            store.writeWorkingSave(
              makeEnvelope({ savedAt: "2026-08-01T11:00:00.000Z" }),
            ),
            "transactionAborted",
          );
          expect(await expectOk(store.readWorkingSave("city-1"))).toMatchObject(
            {
              savedAt: "2026-08-01T10:00:00.000Z",
            },
          );
        },
      );

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
      rawWorkingIt.each([
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
          const seedWorking = requireCapability(
            seedRawWorking,
            "rawWorkingRecords",
          );
          const unsupported = { ...makeEnvelope(), envelopeVersion: 99 };
          seedWorking("city-1", unsupported);

          await expectError(run(store), "incompatibleRecord");
          expect(await expectOk(store.readWorkingSave("city-1"))).toEqual(
            unsupported,
          );
        },
      );

      rawWorkingIt.each([
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
        const seedWorking = requireCapability(
          seedRawWorking,
          "rawWorkingRecords",
        );
        seedWorking("city-1", raw);

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

      rawWorkingIt(
        "deletes unsupported and corrupt cities by storage identity",
        async () => {
          const { store, seedRawWorking } = createHarness();
          const seedWorking = requireCapability(
            seedRawWorking,
            "rawWorkingRecords",
          );
          seedWorking("city-unsupported", {
            ...makeEnvelope(),
            envelopeVersion: 99,
          });
          seedWorking("city-corrupt", { format: "broken" });

          await expectOk(store.deleteCity("city-unsupported"));
          await expectOk(store.deleteCity("city-corrupt"));

          await expectError(
            store.readWorkingSave("city-unsupported"),
            "notFound",
          );
          await expectError(store.readWorkingSave("city-corrupt"), "notFound");
        },
      );

      rawWorkingIt(
        "lists an empty-key city as corrupt and refuses to rewrite it",
        async () => {
          const { store, seedRawWorking } = createHarness();
          const seedWorking = requireCapability(
            seedRawWorking,
            "rawWorkingRecords",
          );
          const emptyIdentity = makeEnvelope({
            city: { id: "", name: "Missing identity" },
          });
          seedWorking("", emptyIdentity);

          expect(await expectOk(store.listCities())).toEqual([
            {
              cityId: "",
              name: null,
              cityCreatedAt: null,
              savedAt: null,
              appVersion: null,
              snapshotSchemaVersion: null,
              summary: null,
              compatibility: { status: "corruptHeader" },
              pending: false,
            },
          ]);
          await expectError(store.renameCity("", "Renamed"), "corruptRecord");
          await expectError(
            store.duplicateCity("", {
              cityId: "city-copy",
              name: "Copy",
              cityCreatedAt: "2026-08-01T12:00:00.000Z",
              savedAt: "2026-08-01T12:05:00.000Z",
              appVersion: "0.2.0",
            }),
            "corruptRecord",
          );
          expect(await expectOk(store.readWorkingSave(""))).toEqual(
            emptyIdentity,
          );
        },
      );

      rawWorkingIt(
        "classifies a working record whose envelope city id disagrees with its storage key as corrupt",
        async () => {
          const { store, seedRawWorking } = createHarness();
          const seedWorking = requireCapability(
            seedRawWorking,
            "rawWorkingRecords",
          );
          const mismatched = envelopeFor("city-other", "Other");
          seedWorking("city-1", mismatched);

          expect(await expectOk(store.listCities())).toEqual([
            {
              cityId: "city-1",
              name: null,
              cityCreatedAt: null,
              savedAt: null,
              appVersion: null,
              snapshotSchemaVersion: null,
              summary: null,
              compatibility: { status: "corruptHeader" },
              pending: false,
            },
          ]);

          await expectError(
            store.renameCity("city-1", "Renamed"),
            "corruptRecord",
          );
          await expectError(
            store.duplicateCity("city-1", {
              cityId: "city-copy",
              name: "Copy",
              cityCreatedAt: "2026-08-01T12:00:00.000Z",
              savedAt: "2026-08-01T12:05:00.000Z",
              appVersion: "0.2.0",
            }),
            "corruptRecord",
          );
          expect(await expectOk(store.readWorkingSave("city-1"))).toEqual(
            mismatched,
          );
        },
      );
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

      it("rejects a checkpoint-only duplicate target without changing it", async () => {
        const { store } = createHarness();
        const source = envelopeFor("city-source", "Source");
        const targetCheckpoint = envelopeFor("city-target", "Target", {
          savedAt: "2026-08-01T11:00:00.000Z",
        });
        await expectOk(store.writeWorkingSave(source));
        await expectOk(
          store.writeCheckpoint({
            checkpointId: "checkpoint-target",
            cityId: "city-target",
            name: "Target checkpoint",
            note: "preserve",
            envelope: targetCheckpoint,
          }),
        );

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

        await expectError(store.readWorkingSave("city-target"), "notFound");
        expect(
          await expectOk(
            store.readCheckpoint("city-target", "checkpoint-target"),
          ),
        ).toEqual(targetCheckpoint);
        expect(
          await expectOk(store.listCheckpoints("city-target")),
        ).toMatchObject([
          {
            checkpointId: "checkpoint-target",
            name: "Target checkpoint",
            note: "preserve",
          },
        ]);
      });

      it("rejects an autosave-only duplicate target without changing it", async () => {
        const { store } = createHarness();
        const source = envelopeFor("city-source", "Source");
        const targetAutosave = envelopeFor("city-target", "Target", {
          savedAt: "2026-08-01T11:00:00.000Z",
        });
        await expectOk(store.writeWorkingSave(source));
        await expectOk(
          store.writeAutosave({
            autosaveId: "autosave-target",
            cityId: "city-target",
            generation: 9,
            envelope: targetAutosave,
          }),
        );

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

        await expectError(store.readWorkingSave("city-target"), "notFound");
        expect(
          await expectOk(store.readAutosave("city-target", "autosave-target")),
        ).toEqual(targetAutosave);
        expect(
          await expectOk(store.listAutosaves("city-target")),
        ).toMatchObject({
          items: [{ autosaveId: "autosave-target", generation: 9 }],
          generationHighWaterMark: 9,
        });
      });

      it("rejects a high-water-only duplicate target without changing it", async () => {
        const { store } = createHarness();
        await expectOk(
          store.writeWorkingSave(envelopeFor("city-source", "Source")),
        );
        await expectOk(
          store.writeAutosave({
            autosaveId: "autosave-pruned",
            cityId: "city-target",
            generation: 9,
            envelope: envelopeFor("city-target", "Target"),
          }),
        );
        await expectOk(store.deleteAutosave("city-target", "autosave-pruned"));

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

        await expectError(store.readWorkingSave("city-target"), "notFound");
        expect(await expectOk(store.listAutosaves("city-target"))).toEqual({
          items: [],
          generationHighWaterMark: 9,
        });
      });
    });

    describe("detached mutation inputs", () => {
      it("uses one detached working-envelope identity through commit", async () => {
        const { store } = createHarness();
        let cityIdReads = 0;
        const city = Object.defineProperty({ name: "Detached" }, "id", {
          enumerable: true,
          get() {
            cityIdReads += 1;
            return cityIdReads === 1 ? "city-detached" : "city-mutated";
          },
        });

        await expectOk(
          store.writeWorkingSave(makeEnvelope({ city: city as never })),
        );

        expect(
          await expectOk(store.readWorkingSave("city-detached")),
        ).toMatchObject({ city: { id: "city-detached", name: "Detached" } });
        await expectError(store.readWorkingSave("city-mutated"), "notFound");
      });

      it("uses the detached duplicate target ID through conflict checks and commit", async () => {
        const { store } = createHarness();
        const source = envelopeFor("city-source", "Source");
        const existing = envelopeFor("city-existing", "Existing");
        await expectOk(store.writeWorkingSave(source));
        await expectOk(store.writeWorkingSave(existing));
        let cityIdReads = 0;
        const identity = Object.defineProperty(
          {
            name: "Duplicate",
            cityCreatedAt: "2026-08-01T12:00:00.000Z",
            savedAt: "2026-08-01T12:05:00.000Z",
            appVersion: "0.2.0",
          },
          "cityId",
          {
            enumerable: true,
            get() {
              cityIdReads += 1;
              return cityIdReads === 1 ? "city-detached" : "city-existing";
            },
          },
        );

        await expectOk(store.duplicateCity("city-source", identity as never));

        expect(await expectOk(store.readWorkingSave("city-existing"))).toEqual(
          existing,
        );
        expect(await expectOk(store.readWorkingSave("city-detached"))).toEqual({
          ...source,
          city: { id: "city-detached", name: "Duplicate" },
          cityCreatedAt: "2026-08-01T12:00:00.000Z",
          savedAt: "2026-08-01T12:05:00.000Z",
          appVersion: "0.2.0",
        });
      });

      it.each(["name", "cityCreatedAt", "savedAt", "appVersion"] as const)(
        "rejects a detached non-string duplicate %s",
        async (field) => {
          const { store } = createHarness();
          const source = envelopeFor("city-source", "Source");
          await expectOk(store.writeWorkingSave(source));
          const hostileValue = Object.defineProperty({}, "value", {
            enumerable: true,
            get() {
              return "not a string field";
            },
          });
          const identity = {
            cityId: "city-target",
            name: "Duplicate",
            cityCreatedAt: "2026-08-01T12:00:00.000Z",
            savedAt: "2026-08-01T12:05:00.000Z",
            appVersion: "0.2.0",
            [field]: hostileValue,
          };

          await expectError(
            store.duplicateCity("city-source", identity as never),
            "corruptRecord",
          );
          await expectError(store.readWorkingSave("city-target"), "notFound");
          expect(await expectOk(store.readWorkingSave("city-source"))).toEqual(
            source,
          );
        },
      );

      it("rejects a detached non-string city rename without changing storage", async () => {
        const { store } = createHarness();
        const original = makeEnvelope();
        await expectOk(store.writeWorkingSave(original));
        const hostileName = Object.defineProperty({}, "value", {
          enumerable: true,
          get() {
            return "not a string name";
          },
        });

        await expectError(
          store.renameCity("city-1", hostileName as never),
          "corruptRecord",
        );
        expect(await expectOk(store.readWorkingSave("city-1"))).toEqual(
          original,
        );
      });

      it("uses detached checkpoint IDs and validates detached metadata", async () => {
        const { store } = createHarness();
        let checkpointIdReads = 0;
        const input = Object.defineProperties(
          {
            cityId: "city-1",
            name: "Checkpoint",
            note: null,
            envelope: makeEnvelope(),
          },
          {
            checkpointId: {
              enumerable: true,
              get() {
                checkpointIdReads += 1;
                return checkpointIdReads <= 2
                  ? "checkpoint-detached"
                  : "checkpoint-mutated";
              },
            },
          },
        );

        await expectOk(store.writeCheckpoint(input as never));

        expect(
          await expectOk(store.readCheckpoint("city-1", "checkpoint-detached")),
        ).toEqual(makeEnvelope());
        await expectError(
          store.readCheckpoint("city-1", "checkpoint-mutated"),
          "notFound",
        );

        const hostileName = Object.defineProperty({}, "value", {
          enumerable: true,
          get() {
            return "not a string name";
          },
        });
        await expectError(
          store.writeCheckpoint({
            checkpointId: "checkpoint-invalid",
            cityId: "city-1",
            name: hostileName as never,
            note: null,
            envelope: makeEnvelope(),
          }),
          "corruptRecord",
        );
      });

      it("uses detached autosave IDs and generations through commit", async () => {
        const { store } = createHarness();
        let autosaveIdReads = 0;
        let generationReads = 0;
        const input = Object.defineProperties(
          {
            cityId: "city-1",
            envelope: makeEnvelope(),
          },
          {
            autosaveId: {
              enumerable: true,
              get() {
                autosaveIdReads += 1;
                return autosaveIdReads <= 2
                  ? "autosave-detached"
                  : "autosave-mutated";
              },
            },
            generation: {
              enumerable: true,
              get() {
                generationReads += 1;
                return generationReads <= 2 ? 7 : Number.NaN;
              },
            },
          },
        );

        await expectOk(store.writeAutosave(input as never));

        expect(await expectOk(store.listAutosaves("city-1"))).toMatchObject({
          items: [{ autosaveId: "autosave-detached", generation: 7 }],
          generationHighWaterMark: 7,
        });
        await expectError(
          store.readAutosave("city-1", "autosave-mutated"),
          "notFound",
        );
      });

      it("validates a detached checkpoint rename without inspecting gameplay", async () => {
        const { store } = createHarness();
        const envelope = makeEnvelope();
        await expectOk(
          store.writeCheckpoint({
            checkpointId: "checkpoint-1",
            cityId: "city-1",
            name: "Original",
            note: "preserve",
            envelope,
          }),
        );
        const hostileName = Object.defineProperty({}, "value", {
          enumerable: true,
          get() {
            return "not a string name";
          },
        });

        await expectError(
          store.renameCheckpoint(
            "city-1",
            "checkpoint-1",
            hostileName as never,
          ),
          "corruptRecord",
        );
        expect(await expectOk(store.listCheckpoints("city-1"))).toMatchObject([
          {
            checkpointId: "checkpoint-1",
            name: "Original",
            note: "preserve",
          },
        ]);
        expect(
          await expectOk(store.readCheckpoint("city-1", "checkpoint-1")),
        ).toEqual(envelope);
      });

      it("maps duplicate identity clone failure without changing the source", async () => {
        const { store } = createHarness();
        const source = envelopeFor("city-source", "Source");
        await expectOk(store.writeWorkingSave(source));

        await expectError(
          store.duplicateCity("city-source", {
            cityId: "city-target",
            name: valueThatThrowsWhileCloning() as never,
            cityCreatedAt: "2026-08-01T12:00:00.000Z",
            savedAt: "2026-08-01T12:05:00.000Z",
            appVersion: "0.2.0",
          }),
          "serializationFailed",
        );
        expect(await expectOk(store.readWorkingSave("city-source"))).toEqual(
          source,
        );
        await expectError(store.readWorkingSave("city-target"), "notFound");
      });

      it("maps rename clone failure without changing the working save", async () => {
        const { store } = createHarness();
        const original = makeEnvelope();
        await expectOk(store.writeWorkingSave(original));

        await expectError(
          store.renameCity("city-1", valueThatThrowsWhileCloning() as never),
          "serializationFailed",
        );
        expect(await expectOk(store.readWorkingSave("city-1"))).toEqual(
          original,
        );
      });

      it("maps checkpoint input clone failure without creating a record", async () => {
        const { store } = createHarness();
        const input = Object.defineProperty(
          {
            cityId: "city-1",
            name: "Checkpoint",
            note: null,
            envelope: makeEnvelope(),
          },
          "checkpointId",
          {
            enumerable: true,
            get() {
              throw new Error("hostile checkpoint ID getter");
            },
          },
        );

        await expectError(
          store.writeCheckpoint(input as never),
          "serializationFailed",
        );
        expect(await expectOk(store.listCheckpoints("city-1"))).toEqual([]);
      });

      it("maps checkpoint rename clone failure without changing metadata", async () => {
        const { store } = createHarness();
        await expectOk(
          store.writeCheckpoint({
            checkpointId: "checkpoint-1",
            cityId: "city-1",
            name: "Original",
            note: null,
            envelope: makeEnvelope(),
          }),
        );

        await expectError(
          store.renameCheckpoint(
            "city-1",
            "checkpoint-1",
            valueThatThrowsWhileCloning() as never,
          ),
          "serializationFailed",
        );
        expect(await expectOk(store.listCheckpoints("city-1"))).toMatchObject([
          { checkpointId: "checkpoint-1", name: "Original" },
        ]);
      });

      it("maps autosave input clone failure without advancing high-water", async () => {
        const { store } = createHarness();
        const input = Object.defineProperty(
          {
            autosaveId: "autosave-1",
            cityId: "city-1",
            envelope: makeEnvelope(),
          },
          "generation",
          {
            enumerable: true,
            get() {
              throw new Error("hostile generation getter");
            },
          },
        );

        await expectError(
          store.writeAutosave(input as never),
          "serializationFailed",
        );
        expect(await expectOk(store.listAutosaves("city-1"))).toEqual({
          items: [],
          generationHighWaterMark: null,
        });
      });

      it.each([
        {
          label: "writeWorkingSave",
          passes: 1,
          run: (store: SaveStore, envelope: WritableSaveEnvelope) =>
            store.writeWorkingSave(envelope),
          verify: (store: SaveStore) => store.readWorkingSave("city-1"),
        },
        {
          label: "writeCheckpoint",
          passes: 1,
          run: (store: SaveStore, envelope: WritableSaveEnvelope) =>
            store.writeCheckpoint({
              checkpointId: "checkpoint-1",
              cityId: "city-1",
              name: "Checkpoint",
              note: null,
              envelope,
            }),
          verify: (store: SaveStore) =>
            store.readCheckpoint("city-1", "checkpoint-1"),
        },
        {
          label: "writeAutosave",
          passes: 1,
          run: (store: SaveStore, envelope: WritableSaveEnvelope) =>
            store.writeAutosave({
              autosaveId: "autosave-1",
              cityId: "city-1",
              generation: 1,
              envelope,
            }),
          verify: (store: SaveStore) =>
            store.readAutosave("city-1", "autosave-1"),
        },
      ] as const)(
        "rejects a stateful snapshot.schemaVersion accessor for $label",
        async ({ passes, run, verify }) => {
          const { store } = createHarness();
          const base = makeEnvelope();
          let reads = 0;
          const snapshot = Object.defineProperty(
            { ...base.snapshot },
            "schemaVersion",
            {
              enumerable: true,
              get() {
                reads += 1;
                return reads <= passes
                  ? base.snapshotSchemaVersion
                  : base.snapshotSchemaVersion - 1;
              },
            },
          );
          const envelope = { ...base, snapshot };

          await expectError(run(store, envelope as never), "corruptRecord");
          await expectError(verify(store), "notFound");
        },
      );

      const envelopeCaptureCases = [
        {
          label: "checkpoint",
          run: (store: SaveStore, input: never) => store.writeCheckpoint(input),
          verify: (store: SaveStore) =>
            store.readCheckpoint("city-1", "checkpoint-1"),
          makeInput: (envelopeGetter: () => unknown) =>
            Object.defineProperty(
              {
                cityId: "city-1",
                checkpointId: "checkpoint-1",
                name: "Checkpoint",
                note: null,
              },
              "envelope",
              { enumerable: true, get: envelopeGetter },
            ),
        },
        {
          label: "autosave",
          run: (store: SaveStore, input: never) => store.writeAutosave(input),
          verify: (store: SaveStore) =>
            store.readAutosave("city-1", "autosave-1"),
          makeInput: (envelopeGetter: () => unknown) =>
            Object.defineProperty(
              {
                cityId: "city-1",
                autosaveId: "autosave-1",
                generation: 1,
              },
              "envelope",
              { enumerable: true, get: envelopeGetter },
            ),
        },
      ] as const;

      it.each(envelopeCaptureCases)(
        "captures the $label envelope on the first read and ignores a later divergent envelope",
        async ({ run, verify, makeInput }) => {
          const { store } = createHarness();
          const envelopeA = makeEnvelope({
            savedAt: "2026-08-01T10:00:00.000Z",
          });
          const envelopeB = makeEnvelope({
            savedAt: "2026-08-01T11:00:00.000Z",
            city: { id: "city-1", name: "Changed" },
          });
          let envelopeReads = 0;
          const input = makeInput(() => {
            envelopeReads += 1;
            return envelopeReads === 1 ? envelopeA : envelopeB;
          });

          await expectOk(
            run(store, input as never) as Promise<SaveStoreResult<unknown>>,
          );

          expect(
            await expectOk(verify(store) as Promise<SaveStoreResult<unknown>>),
          ).toEqual(envelopeA);
        },
      );

      it.each(envelopeCaptureCases)(
        "captures the $label envelope once and tolerates a throwing second read",
        async ({ run, verify, makeInput }) => {
          const { store } = createHarness();
          const envelope = makeEnvelope({
            savedAt: "2026-08-01T10:00:00.000Z",
          });
          let envelopeReads = 0;
          const input = makeInput(() => {
            envelopeReads += 1;
            if (envelopeReads === 1) return envelope;
            throw new Error("hostile envelope getter");
          });

          await expectOk(
            run(store, input as never) as Promise<SaveStoreResult<unknown>>,
          );

          expect(
            await expectOk(verify(store) as Promise<SaveStoreResult<unknown>>),
          ).toEqual(envelope);
        },
      );
    });

    describe("injected storage error taxonomy", () => {
      injectedFailureIt.each([
        ["quotaExceeded", false],
        ["permissionDenied", false],
        ["unavailable", true],
        ["transactionAborted", true],
        ["ioFailure", true],
      ] as const)(
        "surfaces %s with its retryability and preserves the committed record",
        async (code, retryable) => {
          const { store, failNext } = createHarness();
          const injectFailure = requireCapability(
            failNext,
            "injectedStorageFailures",
          );
          const original = makeEnvelope({
            savedAt: "2026-08-01T10:00:00.000Z",
          });
          await expectOk(store.writeWorkingSave(original));
          injectFailure("writeWorkingSave", code);

          const error = await expectError(
            store.writeWorkingSave(
              makeEnvelope({ savedAt: "2026-08-01T11:00:00.000Z" }),
            ),
            code,
          );

          expect(error).toMatchObject({
            operation: "writeWorkingSave",
            code,
            retryable,
          });
          expect(await expectOk(store.readWorkingSave("city-1"))).toEqual(
            original,
          );
        },
      );
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

      rawGenerationIt(
        "lists persisted checkpoint key and timestamp corruption and deletes by storage identity",
        async () => {
          const { store, seedRawCheckpoint } = createHarness();
          const seedCheckpoint = requireCapability(
            seedRawCheckpoint,
            "rawGenerationRecords",
          );
          const keyEnvelope = makeEnvelope({
            savedAt: "2026-08-01T12:00:00.000Z",
          });
          const timestampEnvelope = makeEnvelope({
            savedAt: "2026-08-01T13:00:00.000Z",
          });
          seedCheckpoint({
            storageCityId: "city-1",
            storageCheckpointId: "checkpoint-storage-key",
            checkpointId: "checkpoint-record-key",
            cityId: "city-1",
            name: "Key mismatch",
            note: null,
            createdAt: keyEnvelope.savedAt,
            envelope: keyEnvelope,
          });
          seedCheckpoint({
            storageCityId: "city-1",
            storageCheckpointId: "checkpoint-time",
            checkpointId: "checkpoint-time",
            cityId: "city-1",
            name: "Timestamp mismatch",
            note: "preserve",
            createdAt: "2026-08-01T13:00:01.000Z",
            envelope: timestampEnvelope,
          });
          seedCheckpoint({
            storageCityId: "city-1",
            storageCheckpointId: "checkpoint-city-key",
            checkpointId: "checkpoint-city-key",
            cityId: "city-other",
            name: "City key mismatch",
            note: null,
            createdAt: keyEnvelope.savedAt,
            envelope: envelopeFor("city-other", "Other"),
          });

          const listed = await expectOk(store.listCheckpoints("city-1"));
          const byId = new Map(listed.map((item) => [item.checkpointId, item]));
          expect(byId.get("checkpoint-storage-key")).toEqual({
            checkpointId: "checkpoint-storage-key",
            cityId: "city-1",
            name: "Key mismatch",
            note: null,
            createdAt: keyEnvelope.savedAt,
            appVersion: null,
            snapshotSchemaVersion: null,
            summary: null,
            compatibility: { status: "corruptHeader" },
          });
          expect(byId.get("checkpoint-time")).toEqual({
            checkpointId: "checkpoint-time",
            cityId: "city-1",
            name: "Timestamp mismatch",
            note: "preserve",
            createdAt: "2026-08-01T13:00:01.000Z",
            appVersion: null,
            snapshotSchemaVersion: null,
            summary: null,
            compatibility: { status: "corruptHeader" },
          });
          expect(byId.get("checkpoint-city-key")).toMatchObject({
            checkpointId: "checkpoint-city-key",
            cityId: "city-1",
            name: "City key mismatch",
            appVersion: null,
            snapshotSchemaVersion: null,
            summary: null,
            compatibility: { status: "corruptHeader" },
          });

          await expectOk(
            store.deleteCheckpoint("city-1", "checkpoint-storage-key"),
          );
          await expectOk(store.deleteCheckpoint("city-1", "checkpoint-time"));
          await expectOk(
            store.deleteCheckpoint("city-1", "checkpoint-city-key"),
          );
          expect(await expectOk(store.listCheckpoints("city-1"))).toEqual([]);
        },
      );

      rawGenerationIt(
        "lists persisted autosave key and timestamp corruption and deletes by storage identity",
        async () => {
          const { store, seedRawAutosave } = createHarness();
          const seedAutosave = requireCapability(
            seedRawAutosave,
            "rawGenerationRecords",
          );
          const keyEnvelope = makeEnvelope({
            savedAt: "2026-08-01T12:00:00.000Z",
          });
          const timestampEnvelope = makeEnvelope({
            savedAt: "2026-08-01T13:00:00.000Z",
          });
          seedAutosave({
            storageCityId: "city-1",
            storageAutosaveId: "autosave-storage-key",
            autosaveId: "autosave-record-key",
            cityId: "city-1",
            generation: 7,
            createdAt: keyEnvelope.savedAt,
            envelope: keyEnvelope,
            generationHighWaterMark: 8,
          });
          seedAutosave({
            storageCityId: "city-1",
            storageAutosaveId: "autosave-city-key",
            autosaveId: "autosave-city-key",
            cityId: "city-other",
            generation: 6,
            createdAt: keyEnvelope.savedAt,
            envelope: envelopeFor("city-other", "Other"),
            generationHighWaterMark: 8,
          });
          seedAutosave({
            storageCityId: "city-1",
            storageAutosaveId: "autosave-time",
            autosaveId: "autosave-time",
            cityId: "city-1",
            generation: 8,
            createdAt: "2026-08-01T13:00:01.000Z",
            envelope: timestampEnvelope,
            generationHighWaterMark: 8,
          });

          const listing = await expectOk(store.listAutosaves("city-1"));
          const byId = new Map(
            listing.items.map((item) => [item.autosaveId, item]),
          );
          expect(listing.generationHighWaterMark).toBe(8);
          expect(byId.get("autosave-storage-key")).toEqual({
            autosaveId: "autosave-storage-key",
            cityId: "city-1",
            generation: 7,
            createdAt: keyEnvelope.savedAt,
            appVersion: null,
            snapshotSchemaVersion: null,
            summary: null,
            compatibility: { status: "corruptHeader" },
          });
          expect(byId.get("autosave-time")).toEqual({
            autosaveId: "autosave-time",
            cityId: "city-1",
            generation: 8,
            createdAt: "2026-08-01T13:00:01.000Z",
            appVersion: null,
            snapshotSchemaVersion: null,
            summary: null,
            compatibility: { status: "corruptHeader" },
          });
          expect(byId.get("autosave-city-key")).toMatchObject({
            autosaveId: "autosave-city-key",
            cityId: "city-1",
            generation: 6,
            appVersion: null,
            snapshotSchemaVersion: null,
            summary: null,
            compatibility: { status: "corruptHeader" },
          });

          await expectOk(
            store.deleteAutosave("city-1", "autosave-storage-key"),
          );
          await expectOk(store.deleteAutosave("city-1", "autosave-time"));
          await expectOk(store.deleteAutosave("city-1", "autosave-city-key"));
          expect(await expectOk(store.listAutosaves("city-1"))).toEqual({
            items: [],
            generationHighWaterMark: 8,
          });
        },
      );

      rawGenerationIt(
        "lists a persisted autosave with an unsupported envelope as incompatible",
        async () => {
          const { store, seedRawAutosave } = createHarness();
          const seedAutosave = requireCapability(
            seedRawAutosave,
            "rawGenerationRecords",
          );
          const unsupported = { ...makeEnvelope(), envelopeVersion: 99 };
          seedAutosave({
            storageCityId: "city-1",
            storageAutosaveId: "autosave-unsupported",
            autosaveId: "autosave-unsupported",
            cityId: "city-1",
            generation: 1,
            createdAt: makeEnvelope().savedAt,
            envelope: unsupported,
            generationHighWaterMark: 1,
          });

          const listing = await expectOk(store.listAutosaves("city-1"));

          expect(listing.generationHighWaterMark).toBe(1);
          expect(listing.items).toHaveLength(1);
          expect(listing.items[0]).toMatchObject({
            autosaveId: "autosave-unsupported",
            cityId: "city-1",
            appVersion: null,
            snapshotSchemaVersion: null,
            summary: null,
            compatibility: { status: "unsupportedEnvelope", version: 99 },
          });
        },
      );

      rawGenerationIt(
        "deletes a corrupt generation-only city by storage identity",
        async () => {
          const { store, seedRawCheckpoint, seedRawAutosave } = createHarness();
          const seedCheckpoint = requireCapability(
            seedRawCheckpoint,
            "rawGenerationRecords",
          );
          const seedAutosave = requireCapability(
            seedRawAutosave,
            "rawGenerationRecords",
          );
          const corruptEnvelope = { format: "broken" };
          seedCheckpoint({
            storageCityId: "city-generation-only",
            storageCheckpointId: "checkpoint-corrupt",
            checkpointId: "checkpoint-corrupt",
            cityId: "city-generation-only",
            name: "Corrupt",
            note: null,
            createdAt: "2026-08-01T12:00:00.000Z",
            envelope: corruptEnvelope,
          });
          seedAutosave({
            storageCityId: "city-generation-only",
            storageAutosaveId: "autosave-corrupt",
            autosaveId: "autosave-corrupt",
            cityId: "city-generation-only",
            generation: 3,
            createdAt: "2026-08-01T12:00:00.000Z",
            envelope: corruptEnvelope,
            generationHighWaterMark: 3,
          });

          await expectOk(store.deleteCity("city-generation-only"));

          expect(
            await expectOk(store.listCheckpoints("city-generation-only")),
          ).toEqual([]);
          expect(
            await expectOk(store.listAutosaves("city-generation-only")),
          ).toEqual({ items: [], generationHighWaterMark: null });
        },
      );
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

      rawGenerationIt(
        "keeps checkpoint rename metadata-only for a corrupt envelope",
        async () => {
          const { store, seedRawCheckpoint } = createHarness();
          const seedCheckpoint = requireCapability(
            seedRawCheckpoint,
            "rawGenerationRecords",
          );
          const corruptEnvelope = { format: "broken" };
          seedCheckpoint({
            storageCityId: "city-1",
            storageCheckpointId: "checkpoint-corrupt",
            checkpointId: "checkpoint-corrupt",
            cityId: "city-1",
            name: "Original",
            note: "preserve",
            createdAt: "2026-08-01T12:00:00.000Z",
            envelope: corruptEnvelope,
          });

          const renamed = await expectOk(
            store.renameCheckpoint("city-1", "checkpoint-corrupt", "Renamed"),
          );

          expect(renamed).toMatchObject({
            checkpointId: "checkpoint-corrupt",
            cityId: "city-1",
            name: "Renamed",
            note: "preserve",
            compatibility: { status: "corruptHeader" },
          });
          expect(
            await expectOk(
              store.readCheckpoint("city-1", "checkpoint-corrupt"),
            ),
          ).toEqual(corruptEnvelope);
        },
      );
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
        const { store } = createHarness();
        await expectOk(
          store.writeAutosave({
            autosaveId: "autosave-10",
            cityId: "city-1",
            generation: 10,
            envelope: makeEnvelope(),
          }),
        );
        await expectOk(store.deleteAutosave("city-1", "autosave-10"));

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

      reopenIt(
        "persists working, checkpoint, and high-water state across reopen",
        async () => {
          const harness = createHarness();
          const reopen = requireCapability(harness.reopen, "reopenPersistence");
          const envelope = makeEnvelope();
          await expectOk(harness.store.writeWorkingSave(envelope));
          await expectOk(
            harness.store.writeCheckpoint({
              checkpointId: "checkpoint-reopen",
              cityId: "city-1",
              name: "Reopen",
              note: null,
              envelope,
            }),
          );
          await expectOk(
            harness.store.writeAutosave({
              autosaveId: "autosave-reopen",
              cityId: "city-1",
              generation: 10,
              envelope,
            }),
          );
          await expectOk(
            harness.store.deleteAutosave("city-1", "autosave-reopen"),
          );

          const reopened = await reopen();

          expect(await expectOk(reopened.readWorkingSave("city-1"))).toEqual(
            envelope,
          );
          expect(
            await expectOk(
              reopened.readCheckpoint("city-1", "checkpoint-reopen"),
            ),
          ).toEqual(envelope);
          expect(await expectOk(reopened.listAutosaves("city-1"))).toEqual({
            items: [],
            generationHighWaterMark: 10,
          });
        },
      );

      rawGenerationIt(
        "lists an invalid persisted autosave generation as corrupt",
        async () => {
          const { store, seedRawAutosave } = createHarness();
          const seedAutosave = requireCapability(
            seedRawAutosave,
            "rawGenerationRecords",
          );
          const envelope = makeEnvelope();
          seedAutosave({
            storageCityId: "city-1",
            storageAutosaveId: "autosave-invalid-generation",
            autosaveId: "autosave-invalid-generation",
            cityId: "city-1",
            generation: Number.NaN,
            createdAt: envelope.savedAt,
            envelope,
            generationHighWaterMark: 5,
          });

          const listing = await expectOk(store.listAutosaves("city-1"));

          expect(listing.generationHighWaterMark).toBe(5);
          expect(listing.items).toHaveLength(1);
          expect(listing.items[0]).toMatchObject({
            autosaveId: "autosave-invalid-generation",
            cityId: "city-1",
            appVersion: null,
            snapshotSchemaVersion: null,
            summary: null,
            compatibility: { status: "corruptHeader" },
          });
          expect(listing.items[0]!.generation).toBeNaN();
          await expectOk(
            store.deleteAutosave("city-1", "autosave-invalid-generation"),
          );
        },
      );

      rawGenerationIt(
        "rejects corrupt persisted high-water without mutating or repairing it",
        async () => {
          const { store, seedRawAutosave } = createHarness();
          const seedAutosave = requireCapability(
            seedRawAutosave,
            "rawGenerationRecords",
          );
          const original = makeEnvelope();
          seedAutosave({
            storageCityId: "city-1",
            storageAutosaveId: "autosave-existing",
            autosaveId: "autosave-existing",
            cityId: "city-1",
            generation: 5,
            createdAt: original.savedAt,
            envelope: original,
            generationHighWaterMark: Number.NaN,
          });

          await expectError(store.listAutosaves("city-1"), "corruptRecord");
          await expectError(
            store.writeAutosave({
              autosaveId: "autosave-new",
              cityId: "city-1",
              generation: 6,
              envelope: makeEnvelope(),
            }),
            "corruptRecord",
          );
          expect(
            await expectOk(store.readAutosave("city-1", "autosave-existing")),
          ).toEqual(original);
          await expectError(
            store.readAutosave("city-1", "autosave-new"),
            "notFound",
          );
          await expectOk(store.deleteCity("city-1"));
          expect(await expectOk(store.listAutosaves("city-1"))).toEqual({
            items: [],
            generationHighWaterMark: null,
          });
        },
      );

      rawGenerationIt(
        "rejects a missing high-water mark when retained records exist",
        async () => {
          const { store, seedRawAutosave } = createHarness();
          const seedAutosave = requireCapability(
            seedRawAutosave,
            "rawGenerationRecords",
          );
          const envelope = makeEnvelope();
          seedAutosave({
            storageCityId: "city-1",
            storageAutosaveId: "autosave-existing",
            autosaveId: "autosave-existing",
            cityId: "city-1",
            generation: 5,
            createdAt: envelope.savedAt,
            envelope,
          });

          await expectError(store.listAutosaves("city-1"), "corruptRecord");
          await expectError(
            store.writeAutosave({
              autosaveId: "autosave-new",
              cityId: "city-1",
              generation: 6,
              envelope: makeEnvelope(),
            }),
            "corruptRecord",
          );

          expect(
            await expectOk(store.readAutosave("city-1", "autosave-existing")),
          ).toEqual(envelope);
          await expectError(
            store.readAutosave("city-1", "autosave-new"),
            "notFound",
          );
          await expectOk(store.deleteCity("city-1"));
          expect(await expectOk(store.listAutosaves("city-1"))).toEqual({
            items: [],
            generationHighWaterMark: null,
          });
        },
      );

      rawGenerationIt(
        "rejects a trailing high-water mark below a retained generation",
        async () => {
          const { store, seedRawAutosave } = createHarness();
          const seedAutosave = requireCapability(
            seedRawAutosave,
            "rawGenerationRecords",
          );
          const envelope = makeEnvelope();
          seedAutosave({
            storageCityId: "city-1",
            storageAutosaveId: "autosave-existing",
            autosaveId: "autosave-existing",
            cityId: "city-1",
            generation: 10,
            createdAt: envelope.savedAt,
            envelope,
            generationHighWaterMark: 5,
          });

          await expectError(store.listAutosaves("city-1"), "corruptRecord");
          await expectError(
            store.writeAutosave({
              autosaveId: "autosave-new",
              cityId: "city-1",
              generation: 6,
              envelope: makeEnvelope(),
            }),
            "corruptRecord",
          );

          expect(
            await expectOk(store.readAutosave("city-1", "autosave-existing")),
          ).toEqual(envelope);
          await expectError(
            store.readAutosave("city-1", "autosave-new"),
            "notFound",
          );
          await expectOk(store.deleteCity("city-1"));
          expect(await expectOk(store.listAutosaves("city-1"))).toEqual({
            items: [],
            generationHighWaterMark: null,
          });
        },
      );

      injectedFailureIt(
        "does not advance high-water when an injected write fails",
        async () => {
          const { store, failNext } = createHarness();
          const injectFailure = requireCapability(
            failNext,
            "injectedStorageFailures",
          );
          injectFailure("writeAutosave", "transactionAborted");

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
        },
      );

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

      rawWorkingIt(
        "deletes one city by storage identity and leaves other cities intact",
        async () => {
          const { store, seedRawWorking } = createHarness();
          const seedWorking = requireCapability(
            seedRawWorking,
            "rawWorkingRecords",
          );
          const retained = envelopeFor("city-retained", "Retained");
          await expectOk(store.writeWorkingSave(retained));
          seedWorking("city-deleted", { corrupt: true });

          await expectOk(store.deleteCity("city-deleted"));

          expect(
            await expectOk(store.readWorkingSave("city-retained")),
          ).toEqual(retained);
        },
      );
    });

    describe("pending-then-finalize lifecycle", () => {
      it("createWorkingSave stores a pending record", async () => {
        const { store } = createHarness();
        const created = await expectOk(
          store.createWorkingSave(envelopeFor("city-pending", "Pending")),
        );
        expect(created.pending).toBe(true);
        const cities = await expectOk(store.listCities());
        const found = cities.find((c) => c.cityId === "city-pending");
        expect(found?.pending).toBe(true);
      });

      it("finalizeWorkingSave flips pending to active", async () => {
        const { store } = createHarness();
        await expectOk(
          store.createWorkingSave(envelopeFor("city-pending", "Pending")),
        );
        const finalized = await expectOk(
          store.finalizeWorkingSave("city-pending"),
        );
        expect(finalized.pending).toBe(false);
        const cities = await expectOk(store.listCities());
        const found = cities.find((c) => c.cityId === "city-pending");
        expect(found?.pending).toBe(false);
      });

      it("finalizeWorkingSave is idempotent on an already-active record", async () => {
        const { store } = createHarness();
        await expectOk(
          store.createWorkingSave(envelopeFor("city-pending", "Pending")),
        );
        await expectOk(store.finalizeWorkingSave("city-pending"));
        const second = await expectOk(
          store.finalizeWorkingSave("city-pending"),
        );
        expect(second.pending).toBe(false);
      });

      it("finalizeWorkingSave returns notFound for a missing city", async () => {
        const { store } = createHarness();
        await expectError(
          store.finalizeWorkingSave("city-missing"),
          "notFound",
        );
      });

      it("createWorkingSave conflicts with a pending record from a prior unfinalized create", async () => {
        const { store } = createHarness();
        await expectOk(
          store.createWorkingSave(envelopeFor("city-pending", "Pending")),
        );
        await expectError(
          store.createWorkingSave(
            envelopeFor("city-pending", "Second Create", {
              savedAt: "2026-08-01T11:00:00.000Z",
            }),
          ),
          "conflict",
        );
      });

      it("deleteCity removes a pending record and allows re-creation", async () => {
        const { store } = createHarness();
        await expectOk(
          store.createWorkingSave(envelopeFor("city-pending", "Pending")),
        );
        await expectOk(store.deleteCity("city-pending"));
        await expectOk(
          store.createWorkingSave(
            envelopeFor("city-pending", "Recreated", {
              savedAt: "2026-08-01T11:00:00.000Z",
            }),
          ),
        );
      });

      injectedFailureIt(
        "surfaces injected finalizeWorkingSave failures",
        async () => {
          const { store, failNext } = createHarness();
          const fail = requireCapability(failNext, "injectedStorageFailures");
          await expectOk(
            store.createWorkingSave(envelopeFor("city-pending", "Pending")),
          );
          fail("finalizeWorkingSave", "ioFailure");
          await expectError(
            store.finalizeWorkingSave("city-pending"),
            "ioFailure",
          );
        },
      );
    });

    describe("missing record notFound", () => {
      it.each([
        {
          label: "renameCity",
          run: (store: SaveStore) =>
            store.renameCity("city-missing", "Renamed"),
        },
        {
          label: "duplicateCity",
          run: (store: SaveStore) =>
            store.duplicateCity("city-missing", {
              cityId: "city-copy",
              name: "Copy",
              cityCreatedAt: "2026-08-01T12:00:00.000Z",
              savedAt: "2026-08-01T12:05:00.000Z",
              appVersion: "0.2.0",
            }),
        },
        {
          label: "deleteCity",
          run: (store: SaveStore) => store.deleteCity("city-missing"),
        },
        {
          label: "renameCheckpoint",
          run: (store: SaveStore) =>
            store.renameCheckpoint("city-1", "checkpoint-missing", "Renamed"),
        },
        {
          label: "deleteCheckpoint",
          run: (store: SaveStore) =>
            store.deleteCheckpoint("city-1", "checkpoint-missing"),
        },
        {
          label: "deleteAutosave",
          run: (store: SaveStore) =>
            store.deleteAutosave("city-1", "autosave-missing"),
        },
      ])("returns notFound for a missing $label", async ({ run }) => {
        const { store } = createHarness();
        await expectError(run(store), "notFound");
      });
    });

    describe("incompatible envelope writes", () => {
      it.each([
        {
          label: "working save",
          run: (store: SaveStore) =>
            store.writeWorkingSave({
              ...makeEnvelope(),
              envelopeVersion: 99,
            } as never),
          list: (store: SaveStore) => store.listCities(),
          empty: [],
        },
        {
          label: "checkpoint",
          run: (store: SaveStore) =>
            store.writeCheckpoint({
              checkpointId: "checkpoint-unsupported",
              cityId: "city-1",
              name: "Unsupported",
              note: null,
              envelope: { ...makeEnvelope(), envelopeVersion: 99 } as never,
            }),
          list: (store: SaveStore) => store.listCheckpoints("city-1"),
          empty: [],
        },
        {
          label: "autosave",
          run: (store: SaveStore) =>
            store.writeAutosave({
              autosaveId: "autosave-unsupported",
              cityId: "city-1",
              generation: 1,
              envelope: { ...makeEnvelope(), envelopeVersion: 99 } as never,
            }),
          list: (store: SaveStore) => store.listAutosaves("city-1"),
          empty: { items: [], generationHighWaterMark: null },
        },
      ])(
        "rejects an unsupported $label envelope as incompatible without creating a record",
        async ({ run, list, empty }) => {
          const { store } = createHarness();

          await expectError(run(store), "incompatibleRecord");
          expect(await expectOk<unknown>(list(store))).toEqual(empty);
        },
      );
    });

    describe("write-path envelope shape", () => {
      const shapeViolations: ReadonlyArray<{
        label: string;
        corrupt: (envelope: WritableSaveEnvelope) => void;
      }> = [
        {
          label: "symbol key",
          corrupt: (envelope) => {
            Object.assign(envelope, { [Symbol("extra")]: true });
          },
        },
        {
          label: "non-enumerable own property",
          corrupt: (envelope) => {
            Object.defineProperty(envelope, "extra", { value: true });
          },
        },
        {
          label: "custom prototype",
          corrupt: (envelope) => {
            Object.setPrototypeOf(envelope, { custom: true });
          },
        },
      ];

      const writeOps: ReadonlyArray<{
        label: string;
        run: (
          store: SaveStore,
          envelope: WritableSaveEnvelope,
        ) => Promise<SaveStoreResult<unknown>>;
        verifyEmpty: (store: SaveStore) => Promise<void>;
      }> = [
        {
          label: "writeWorkingSave",
          run: (store, envelope) => store.writeWorkingSave(envelope as never),
          verifyEmpty: async (store) => {
            await expectError(store.readWorkingSave("city-1"), "notFound");
          },
        },
        {
          label: "writeCheckpoint",
          run: (store, envelope) =>
            store.writeCheckpoint({
              checkpointId: "checkpoint-1",
              cityId: "city-1",
              name: "Checkpoint",
              note: null,
              envelope: envelope as never,
            }),
          verifyEmpty: async (store) => {
            expect(await expectOk(store.listCheckpoints("city-1"))).toEqual([]);
          },
        },
        {
          label: "writeAutosave",
          run: (store, envelope) =>
            store.writeAutosave({
              autosaveId: "autosave-1",
              cityId: "city-1",
              generation: 1,
              envelope: envelope as never,
            }),
          verifyEmpty: async (store) => {
            expect(await expectOk(store.listAutosaves("city-1"))).toEqual({
              items: [],
              generationHighWaterMark: null,
            });
          },
        },
      ];

      const writeShapeCases = writeOps.flatMap((op) =>
        shapeViolations.map((violation) => ({
          label: `${op.label} / ${violation.label}`,
          run: op.run,
          corrupt: violation.corrupt,
          verifyEmpty: op.verifyEmpty,
        })),
      );

      it.each(writeShapeCases)(
        "rejects a $label envelope without committing",
        async ({ run, corrupt, verifyEmpty }) => {
          const { store } = createHarness();
          const envelope = makeEnvelope();
          corrupt(envelope);

          await expectError(run(store, envelope), "corruptRecord");
          await verifyEmpty(store);
        },
      );
    });

    describe("injected failure surfaces", () => {
      injectedFailureIt.each([
        {
          op: "listCities" as const,
          setup: async (_store: SaveStore) => {},
          call: (store: SaveStore) => store.listCities(),
          verify: async (_store: SaveStore) => {},
        },
        {
          op: "readWorkingSave" as const,
          setup: async (store: SaveStore) => {
            await expectOk(store.writeWorkingSave(makeEnvelope()));
          },
          call: (store: SaveStore) => store.readWorkingSave("city-1"),
          verify: async (store: SaveStore) => {
            await expectOk(store.readWorkingSave("city-1"));
          },
        },
        {
          op: "renameCity" as const,
          setup: async (store: SaveStore) => {
            await expectOk(store.writeWorkingSave(makeEnvelope()));
          },
          call: (store: SaveStore) => store.renameCity("city-1", "Renamed"),
          verify: async (store: SaveStore) => {
            expect(await expectOk(store.readWorkingSave("city-1"))).toEqual(
              makeEnvelope(),
            );
          },
        },
        {
          op: "duplicateCity" as const,
          setup: async (store: SaveStore) => {
            await expectOk(
              store.writeWorkingSave(envelopeFor("city-source", "Source")),
            );
          },
          call: (store: SaveStore) =>
            store.duplicateCity("city-source", {
              cityId: "city-target",
              name: "Copy",
              cityCreatedAt: "2026-08-01T12:00:00.000Z",
              savedAt: "2026-08-01T12:05:00.000Z",
              appVersion: "0.2.0",
            }),
          verify: async (store: SaveStore) => {
            await expectOk(store.readWorkingSave("city-source"));
            await expectError(store.readWorkingSave("city-target"), "notFound");
          },
        },
        {
          op: "deleteCity" as const,
          setup: async (store: SaveStore) => {
            await expectOk(store.writeWorkingSave(makeEnvelope()));
          },
          call: (store: SaveStore) => store.deleteCity("city-1"),
          verify: async (store: SaveStore) => {
            await expectOk(store.readWorkingSave("city-1"));
          },
        },
        {
          op: "listCheckpoints" as const,
          setup: async (store: SaveStore) => {
            await expectOk(
              store.writeCheckpoint({
                checkpointId: "checkpoint-1",
                cityId: "city-1",
                name: "Checkpoint",
                note: null,
                envelope: makeEnvelope(),
              }),
            );
          },
          call: (store: SaveStore) => store.listCheckpoints("city-1"),
          verify: async (store: SaveStore) => {
            await expectOk(store.readCheckpoint("city-1", "checkpoint-1"));
          },
        },
        {
          op: "readCheckpoint" as const,
          setup: async (store: SaveStore) => {
            await expectOk(
              store.writeCheckpoint({
                checkpointId: "checkpoint-1",
                cityId: "city-1",
                name: "Checkpoint",
                note: null,
                envelope: makeEnvelope(),
              }),
            );
          },
          call: (store: SaveStore) =>
            store.readCheckpoint("city-1", "checkpoint-1"),
          verify: async (store: SaveStore) => {
            await expectOk(store.readCheckpoint("city-1", "checkpoint-1"));
          },
        },
        {
          op: "writeCheckpoint" as const,
          setup: async (_store: SaveStore) => {},
          call: (store: SaveStore) =>
            store.writeCheckpoint({
              checkpointId: "checkpoint-1",
              cityId: "city-1",
              name: "Checkpoint",
              note: null,
              envelope: makeEnvelope(),
            }),
          verify: async (store: SaveStore) => {
            expect(await expectOk(store.listCheckpoints("city-1"))).toEqual([]);
          },
        },
        {
          op: "renameCheckpoint" as const,
          setup: async (store: SaveStore) => {
            await expectOk(
              store.writeCheckpoint({
                checkpointId: "checkpoint-1",
                cityId: "city-1",
                name: "Original",
                note: null,
                envelope: makeEnvelope(),
              }),
            );
          },
          call: (store: SaveStore) =>
            store.renameCheckpoint("city-1", "checkpoint-1", "Renamed"),
          verify: async (store: SaveStore) => {
            expect(
              await expectOk(store.listCheckpoints("city-1")),
            ).toMatchObject([
              { checkpointId: "checkpoint-1", name: "Original" },
            ]);
          },
        },
        {
          op: "deleteCheckpoint" as const,
          setup: async (store: SaveStore) => {
            await expectOk(
              store.writeCheckpoint({
                checkpointId: "checkpoint-1",
                cityId: "city-1",
                name: "Checkpoint",
                note: null,
                envelope: makeEnvelope(),
              }),
            );
          },
          call: (store: SaveStore) =>
            store.deleteCheckpoint("city-1", "checkpoint-1"),
          verify: async (store: SaveStore) => {
            await expectOk(store.readCheckpoint("city-1", "checkpoint-1"));
          },
        },
        {
          op: "listAutosaves" as const,
          setup: async (store: SaveStore) => {
            await expectOk(
              store.writeAutosave({
                autosaveId: "autosave-1",
                cityId: "city-1",
                generation: 1,
                envelope: makeEnvelope(),
              }),
            );
          },
          call: (store: SaveStore) => store.listAutosaves("city-1"),
          verify: async (store: SaveStore) => {
            await expectOk(store.readAutosave("city-1", "autosave-1"));
          },
        },
        {
          op: "readAutosave" as const,
          setup: async (store: SaveStore) => {
            await expectOk(
              store.writeAutosave({
                autosaveId: "autosave-1",
                cityId: "city-1",
                generation: 1,
                envelope: makeEnvelope(),
              }),
            );
          },
          call: (store: SaveStore) =>
            store.readAutosave("city-1", "autosave-1"),
          verify: async (store: SaveStore) => {
            await expectOk(store.readAutosave("city-1", "autosave-1"));
          },
        },
        {
          op: "deleteAutosave" as const,
          setup: async (store: SaveStore) => {
            await expectOk(
              store.writeAutosave({
                autosaveId: "autosave-1",
                cityId: "city-1",
                generation: 1,
                envelope: makeEnvelope(),
              }),
            );
          },
          call: (store: SaveStore) =>
            store.deleteAutosave("city-1", "autosave-1"),
          verify: async (store: SaveStore) => {
            await expectOk(store.readAutosave("city-1", "autosave-1"));
          },
        },
      ])(
        "surfaces an injected $op failure and preserves committed state",
        async ({ op, setup, call, verify }) => {
          const { store, failNext } = createHarness();
          const injectFailure = requireCapability(
            failNext,
            "injectedStorageFailures",
          );
          await setup(store);
          injectFailure(op, "unavailable");

          const error = await expectError(call(store), "unavailable");

          expect(error.operation).toBe(op);
          expect(error.retryable).toBe(true);
          await verify(store);
        },
      );
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

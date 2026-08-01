import type {
  EconomyPreset,
  GameMode,
  SandboxTemplateId,
} from "../domain/types";
import {
  CAELUM_SAVE_FORMAT,
  SAVE_ENVELOPE_VERSION,
  SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS,
  type InspectedSaveEnvelope,
} from "./envelope";

type PlainObject = Record<string, unknown>;

export type SaveEnvelopeError =
  | { code: "corruptHeader" }
  | { code: "unsupportedEnvelope"; version: number }
  | { code: "unsupportedSnapshot"; version: number }
  | {
      code: "snapshotVersionMismatch";
      declaredVersion: number;
      embeddedVersion: number | null;
    };

export type SaveCompatibility =
  | { status: "candidate" }
  | { status: "corruptHeader" }
  | { status: "unsupportedEnvelope"; version: number }
  | { status: "unsupportedSnapshot"; version: number }
  | {
      status: "snapshotVersionMismatch";
      declaredVersion: number;
      embeddedVersion: number | null;
    };

type IncompatibleSave = Exclude<SaveCompatibility, { status: "candidate" }>;

export type InspectSaveEnvelopeResult =
  | { ok: true; envelope: InspectedSaveEnvelope }
  | { ok: false; compatibility: IncompatibleSave };

const ENVELOPE_KEYS = [
  "format",
  "envelopeVersion",
  "city",
  "cityCreatedAt",
  "savedAt",
  "appVersion",
  "snapshotSchemaVersion",
  "summary",
  "snapshot",
] as const;

const GAME_MODES = new Set<GameMode>(["sandbox", "campaign"]);
const ECONOMY_PRESETS = new Set<EconomyPreset>(["standard", "creative"]);
const SANDBOX_TEMPLATE_IDS = new Set<SandboxTemplateId>([
  "blankGrid",
  "crossroads",
]);

function isPlainObject(value: unknown): value is PlainObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: PlainObject,
  required: readonly string[],
): boolean {
  const allowed = new Set(required);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Reflect.ownKeys(value).every(
      (key) => typeof key === "string" && allowed.has(key),
    )
  );
}

function isVersion(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value)
  );
}

function isGameMode(value: unknown): value is GameMode {
  return typeof value === "string" && GAME_MODES.has(value as GameMode);
}

function isEconomyPreset(value: unknown): value is EconomyPreset {
  return (
    typeof value === "string" && ECONOMY_PRESETS.has(value as EconomyPreset)
  );
}

function isSandboxTemplateId(value: unknown): value is SandboxTemplateId {
  return (
    typeof value === "string" &&
    SANDBOX_TEMPLATE_IDS.has(value as SandboxTemplateId)
  );
}

function inspectionFailure(
  compatibility: IncompatibleSave,
): InspectSaveEnvelopeResult {
  return { ok: false, compatibility };
}

export function inspectSaveEnvelope(value: unknown): InspectSaveEnvelopeResult {
  try {
    if (!isPlainObject(value)) {
      return inspectionFailure({ status: "corruptHeader" });
    }

    const format = value.format;
    if (format !== CAELUM_SAVE_FORMAT) {
      return inspectionFailure({ status: "corruptHeader" });
    }

    const envelopeVersion = value.envelopeVersion;
    if (!isVersion(envelopeVersion)) {
      return inspectionFailure({ status: "corruptHeader" });
    }
    if (envelopeVersion !== SAVE_ENVELOPE_VERSION) {
      return inspectionFailure({
        status: "unsupportedEnvelope",
        version: envelopeVersion,
      });
    }

    const snapshotSchemaVersion = value.snapshotSchemaVersion;
    if (!isVersion(snapshotSchemaVersion)) {
      return inspectionFailure({ status: "corruptHeader" });
    }
    if (!SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS.has(snapshotSchemaVersion)) {
      return inspectionFailure({
        status: "unsupportedSnapshot",
        version: snapshotSchemaVersion,
      });
    }

    if (!hasExactKeys(value, ENVELOPE_KEYS)) {
      return inspectionFailure({ status: "corruptHeader" });
    }

    const city = value.city;
    const cityCreatedAt = value.cityCreatedAt;
    const savedAt = value.savedAt;
    const appVersion = value.appVersion;
    const summary = value.summary;
    const snapshot = value.snapshot;

    if (
      !isPlainObject(city) ||
      !hasExactKeys(city, ["id", "name"]) ||
      typeof city.id !== "string" ||
      typeof city.name !== "string" ||
      typeof cityCreatedAt !== "string" ||
      typeof savedAt !== "string" ||
      typeof appVersion !== "string" ||
      !isPlainObject(summary) ||
      !hasExactKeys(summary, [
        "gameMode",
        "economyPreset",
        "sandboxTemplateId",
      ]) ||
      !isGameMode(summary.gameMode) ||
      !isEconomyPreset(summary.economyPreset) ||
      !isSandboxTemplateId(summary.sandboxTemplateId)
    ) {
      return inspectionFailure({ status: "corruptHeader" });
    }

    let embeddedVersion: number | null = null;
    if (
      isPlainObject(snapshot) &&
      Object.prototype.hasOwnProperty.call(snapshot, "schemaVersion")
    ) {
      const candidateVersion = snapshot.schemaVersion;
      if (isVersion(candidateVersion)) {
        embeddedVersion = candidateVersion;
      }
    }

    if (embeddedVersion !== snapshotSchemaVersion) {
      return inspectionFailure({
        status: "snapshotVersionMismatch",
        declaredVersion: snapshotSchemaVersion,
        embeddedVersion,
      });
    }

    return { ok: true, envelope: value as unknown as InspectedSaveEnvelope };
  } catch {
    return inspectionFailure({ status: "corruptHeader" });
  }
}

export function compatibilityToEnvelopeError(
  compatibility: IncompatibleSave,
): SaveEnvelopeError {
  switch (compatibility.status) {
    case "corruptHeader":
      return { code: "corruptHeader" };
    case "unsupportedEnvelope":
      return {
        code: "unsupportedEnvelope",
        version: compatibility.version,
      };
    case "unsupportedSnapshot":
      return {
        code: "unsupportedSnapshot",
        version: compatibility.version,
      };
    case "snapshotVersionMismatch":
      return {
        code: "snapshotVersionMismatch",
        declaredVersion: compatibility.declaredVersion,
        embeddedVersion: compatibility.embeddedVersion,
      };
  }
}

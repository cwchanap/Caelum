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
  "createdAt",
  "savedAt",
  "appVersion",
  "snapshotSchemaVersion",
  "summary",
  "snapshot",
] as const;

const GAME_MODES = {
  sandbox: true,
  campaign: true,
} as const satisfies Record<GameMode, true>;
const ECONOMY_PRESETS = {
  standard: true,
  creative: true,
} as const satisfies Record<EconomyPreset, true>;
const SANDBOX_TEMPLATE_IDS = {
  blankGrid: true,
  crossroads: true,
} as const satisfies Record<SandboxTemplateId, true>;

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

function isCatalogueMember<TValue extends string>(
  catalogue: Record<TValue, true>,
  value: unknown,
): value is TValue {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(catalogue, value)
  );
}

function isGameMode(value: unknown): value is GameMode {
  return isCatalogueMember(GAME_MODES, value);
}

function isEconomyPreset(value: unknown): value is EconomyPreset {
  return isCatalogueMember(ECONOMY_PRESETS, value);
}

function isSandboxTemplateId(value: unknown): value is SandboxTemplateId {
  return isCatalogueMember(SANDBOX_TEMPLATE_IDS, value);
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
    const createdAt = value.createdAt;
    const savedAt = value.savedAt;
    const appVersion = value.appVersion;
    const summary = value.summary;
    const snapshot = value.snapshot;

    if (
      !isPlainObject(city) ||
      !hasExactKeys(city, ["id", "name"]) ||
      typeof createdAt !== "string" ||
      typeof savedAt !== "string" ||
      typeof appVersion !== "string" ||
      !isPlainObject(summary) ||
      !hasExactKeys(summary, ["gameMode", "economyPreset", "sandboxTemplateId"])
    ) {
      return inspectionFailure({ status: "corruptHeader" });
    }

    const cityId = city.id;
    const cityName = city.name;
    const gameMode = summary.gameMode;
    const economyPreset = summary.economyPreset;
    const sandboxTemplateId = summary.sandboxTemplateId;
    if (
      typeof cityId !== "string" ||
      cityId.length === 0 ||
      typeof cityName !== "string" ||
      !isGameMode(gameMode) ||
      !isEconomyPreset(economyPreset) ||
      !isSandboxTemplateId(sandboxTemplateId)
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

    const envelope: InspectedSaveEnvelope = {
      format,
      envelopeVersion,
      city: { id: cityId, name: cityName },
      createdAt,
      savedAt,
      appVersion,
      snapshotSchemaVersion,
      summary: { gameMode, economyPreset, sandboxTemplateId },
      snapshot,
    };
    return { ok: true, envelope };
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

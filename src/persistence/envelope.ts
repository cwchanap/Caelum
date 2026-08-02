import {
  SNAPSHOT_SCHEMA_VERSION,
  type EconomyPreset,
  type GameMode,
  type SandboxTemplateId,
} from "../domain/types";
import type { RustGameSnapshot } from "../runtime/backend/types";

export const CAELUM_SAVE_FORMAT = "caelum-save" as const;
export const SAVE_ENVELOPE_VERSION = 1 as const;
export const SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS: ReadonlySet<number> =
  new Set<number>([SNAPSHOT_SCHEMA_VERSION]);

export interface SaveEnvelopeSummary {
  gameMode: GameMode;
  economyPreset: EconomyPreset;
  sandboxTemplateId: SandboxTemplateId;
}

export interface SaveEnvelope<TSnapshot = unknown> {
  format: typeof CAELUM_SAVE_FORMAT;
  envelopeVersion: typeof SAVE_ENVELOPE_VERSION;
  city: { id: string; name: string };
  cityCreatedAt: string;
  savedAt: string;
  appVersion: string;
  snapshotSchemaVersion: number;
  summary: SaveEnvelopeSummary;
  snapshot: TSnapshot;
}

export type WritableSaveEnvelope = SaveEnvelope<RustGameSnapshot>;
export type InspectedSaveEnvelope = SaveEnvelope<unknown>;
export type UntrustedSaveValue = unknown;

export function buildSaveEnvelope({
  city,
  cityCreatedAt,
  savedAt,
  appVersion,
  snapshot,
}: Omit<
  WritableSaveEnvelope,
  "format" | "envelopeVersion" | "snapshotSchemaVersion" | "summary"
>): WritableSaveEnvelope {
  return {
    format: CAELUM_SAVE_FORMAT,
    envelopeVersion: SAVE_ENVELOPE_VERSION,
    city,
    cityCreatedAt,
    savedAt,
    appVersion,
    snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
    summary: {
      gameMode: snapshot.rules.gameMode,
      economyPreset: snapshot.rules.economyPreset,
      sandboxTemplateId: snapshot.rules.sandbox.templateId,
    },
    snapshot,
  };
}

import type {
  SandboxCreationError,
  SandboxCreationErrorCode,
  SandboxResetError,
  SandboxResetErrorCode,
} from "./types";

const SANDBOX_CREATION_ERROR_CODES = new Set<SandboxCreationErrorCode>([
  "unknownTemplateId",
  "unknownEconomyPreset",
  "invalidStartingCapital",
  "invalidDemandMultiplier",
  "templateInvariantViolation",
]);

const SANDBOX_RESET_ERROR_CODES = new Set<SandboxResetErrorCode>([
  "unsupportedGameMode",
  "templateInvariantViolation",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOptionalString(
  context: Record<string, unknown>,
  field: string,
): boolean {
  return !(field in context) || typeof context[field] === "string";
}

export function isSandboxCreationError(
  value: unknown,
): value is SandboxCreationError {
  if (
    !isPlainObject(value) ||
    typeof value.code !== "string" ||
    !SANDBOX_CREATION_ERROR_CODES.has(value.code as SandboxCreationErrorCode) ||
    !isPlainObject(value.context)
  ) {
    return false;
  }

  return (
    hasOptionalString(value.context, "field") &&
    hasOptionalString(value.context, "attemptedValue") &&
    hasOptionalString(value.context, "templateId")
  );
}

export function isSandboxResetError(
  value: unknown,
): value is SandboxResetError {
  if (
    !isPlainObject(value) ||
    typeof value.code !== "string" ||
    !SANDBOX_RESET_ERROR_CODES.has(value.code as SandboxResetErrorCode) ||
    !isPlainObject(value.context)
  ) {
    return false;
  }

  if (
    "gameMode" in value.context &&
    value.context.gameMode !== "sandbox" &&
    value.context.gameMode !== "campaign"
  ) {
    return false;
  }

  return (
    !("templateId" in value.context) ||
    value.context.templateId === "blankGrid" ||
    value.context.templateId === "crossroads" ||
    value.context.templateId === "smallTown"
  );
}

export function describeHostRejection(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (error === undefined) return undefined;

  if (typeof error === "object" && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error);
}

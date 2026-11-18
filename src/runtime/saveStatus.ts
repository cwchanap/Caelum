import type { RuntimePersistenceView } from "./workingSaveRuntime";

export function saveStatus(
  view: RuntimePersistenceView,
  nowMs: number,
): { label: string; canRetry: boolean } {
  if (view.save === "saving") return { label: "Saving…", canRetry: false };
  if (view.activeCity === null) {
    return { label: view.busy ? "Working…" : "Not saved", canRetry: false };
  }
  if (view.save === "failed") return { label: "Couldn't save", canRetry: true };
  if (view.busy) return { label: "Working…", canRetry: false };
  const savedAtMs = Date.parse(view.activeCity.savedAt);
  if (!Number.isFinite(savedAtMs)) {
    return { label: "Not saved", canRetry: false };
  }
  const seconds = Math.max(0, Math.floor((nowMs - savedAtMs) / 1000));
  const age =
    seconds < 60
      ? `${seconds} s`
      : seconds < 3600
        ? `${Math.floor(seconds / 60)} min`
        : seconds < 86400
          ? `${Math.floor(seconds / 3600)} h`
          : `${Math.floor(seconds / 86400)} d`;
  return { label: `Saved ${age} ago`, canRetry: false };
}

import type { RuntimePersistenceView } from "./workingSaveRuntime";

export function saveStatus(
  view: RuntimePersistenceView,
  nowMs: number,
): { label: string; canRetry: boolean } {
  if (view.save === "saving") return { label: "Saving…", canRetry: false };
  if (view.save === "failed") return { label: "Couldn't save", canRetry: true };
  const seconds =
    Math.max(
      0,
      Math.floor((nowMs - Date.parse(view.activeCity?.savedAt ?? "")) / 1000),
    ) || 0;
  const age = seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min`;
  return { label: `Saved ${age} ago`, canRetry: false };
}

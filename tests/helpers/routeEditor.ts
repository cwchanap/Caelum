import type { RouteEditorView } from "../../src/runtime/types";

/**
 * Shared `RouteEditorView` fixture for route-editor/lines-panel UI tests.
 * Defaults to a connected two-waypoint bus draft in "create" mode; pass
 * `overrides` to mutate individual fields. Extracted here so
 * `routeEditor.test.ts` and `linesPanel.test.ts` share one source of truth.
 */
export function createDraftView(
  overrides: Partial<RouteEditorView> = {},
): RouteEditorView {
  return {
    source: "create",
    title: "New Bus Route",
    mode: "bus",
    pattern: "loop",
    waypoints: [
      {
        id: "stop-001",
        index: 0,
        label: "Stop A",
        status: "present",
        selected: true,
      },
      {
        id: "stop-002",
        index: 1,
        label: "Stop B",
        status: "present",
        selected: false,
      },
    ],
    selectedIndex: 0,
    interaction: "replace",
    previewPending: false,
    previewStatus: "connected",
    previewMessage: "Connected",
    previewWarnings: [],
    canSave: true,
    canReload: false,
    canUndo: false,
    canRedo: false,
    notice: null,
    failures: [],
    ...overrides,
  };
}

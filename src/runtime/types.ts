import type {
  AreaKind,
  BuildingType,
  GameState,
  GameplayRejection,
  LegFailureReason,
  Overlay,
  Point,
  RoadPreset,
  RoadStructure,
  RoundaboutSize,
  RouteLegKind,
  ServicePattern,
  Tool,
  TransitMode,
} from "../domain/types";
import type { BuildCategoryId } from "../domain/catalog/buildMenu";
import type { HudCategory, RouteDraftNotice, UiState } from "../ui/uiState";
import type { RouteDraft } from "../ui/routeDraft";
import type {
  AuthoredRoadTilePreview,
  RoadMutation,
  SandboxResetError,
} from "./backend/types";
import type {
  RuntimePersistenceController,
  RuntimePersistenceView,
} from "./workingSaveRuntime";

export type {
  RouteDraft,
  RouteDraftError,
  RouteDraftInteractionError,
} from "../ui/routeDraft";
export type {
  RouteDraftCheckpoint,
  RouteDraftHistory,
  RouteDraftNotice,
} from "../ui/uiState";
export type { ServicePattern, TransitMode } from "../domain/types";

export interface ShellTopbarState {
  budget: string;
  signalState: string;
  time: string;
  population: string;
  late: string;
  unserved: string;
  avgWait: string;
}

export interface ShellBriefState {
  title: string;
  context: string;
  status: string;
  objective: string;
  lossNote: string;
  nextGrowth: string;
  selectedId: string;
  activeTool: string;
}

export interface ShellHudBadges {
  routeDraftActive: boolean;
  routeCount: number;
  activeOverlayLabel: string | null;
  inspectActive: boolean;
}

export interface ShellHudState {
  activeCategory: HudCategory | null;
  activeToolChip: string;
  canCancel: boolean;
  buildCategory: BuildCategoryId | null;
  inspectToolActive: boolean;
  removeToolActive: boolean;
  badges: ShellHudBadges;
}

export interface ShellPlatformMoveTarget {
  platformId: string;
  label: string;
}

export interface ShellPlatformRoute {
  id: string;
  name: string;
  color: string;
  moveTargets: ShellPlatformMoveTarget[];
}

export interface ShellPlatform {
  id: string;
  label: string;
  occupancy: number;
  capacity: number;
  routes: ShellPlatformRoute[];
}

export interface ShellInspectorState {
  nodeId: string;
  nodeLabel: string;
  canReassign: boolean;
  platforms: ShellPlatform[];
}

export interface RouteEditorWaypointView {
  id: string;
  index: number;
  label: string;
  status: "present" | "missing";
  selected: boolean;
}

export interface RouteEditorView {
  source: "create" | "edit";
  title: string;
  mode: TransitMode;
  pattern: ServicePattern;
  waypoints: RouteEditorWaypointView[];
  selectedIndex: number | null;
  interaction: RouteDraft["interaction"];
  previewPending: boolean;
  previewStatus: "empty" | "connected" | "broken" | "rejected";
  previewMessage: string | null;
  previewWarnings: string[];
  failures: RouteFailureRow[];
  canSave: boolean;
  canReload: boolean;
  canUndo: boolean;
  canRedo: boolean;
  notice: RouteDraftNotice | null;
}

export interface RouteServiceStatus {
  primary: "running" | "paused" | "broken";
  pausedAfterRepair: boolean;
}

export interface RouteFailureRow {
  legIndex: number;
  fromWaypointId: string;
  toWaypointId: string;
  fromLabel: string;
  toLabel: string;
  reason: "missingNode" | LegFailureReason;
  legKind: RouteLegKind;
  isLoopClosing: boolean;
  guidance: string;
  /** Present only when reason is "missingNode": the kind of the missing
   * waypoint(s) — "station" if either endpoint is a missing station, otherwise
   * "stop". */
  missingNodeKind?: "stop" | "station";
}

export interface RoadMutationPreviewView {
  generation: number;
  changedTiles: Point[];
  skippedTiles: Point[];
  authoredTiles: AuthoredRoadTilePreview[];
  generatedStructures: RoadStructure[];
  cost: number;
  costLabel: string;
  routeImpacts: Array<{
    routeId: string;
    routeName: string;
    kind: "rerouted" | "broken";
  }>;
  rejection: GameplayRejection | null;
}

export interface ShellRouteListItem {
  id: string;
  name: string;
  color: string;
  mode: "bus" | "metro";
  stopCount: number;
  active: boolean;
  selected: boolean;
  status: RouteServiceStatus;
  failures: RouteFailureRow[];
}

export type ShellRouteListState = ShellRouteListItem[];

export interface ShellState {
  topbar: ShellTopbarState;
  brief: ShellBriefState;
  hud: ShellHudState;
  inspector: ShellInspectorState | null;
  routeDraft: RouteEditorView | null;
  routes: ShellRouteListState;
  roadMutationPreview: RoadMutationPreviewView | null;
}

export interface RuntimeSnapshot {
  state: GameState;
  ui: UiState;
  shell: ShellState;
  persistence: RuntimePersistenceView;
  backendError: string | null;
  // Recoverable gameplay rejection (e.g. unaffordable placement, rejected
  // vehicle assignment). Distinct from `backendError` (fatal host failure):
  // a rejection does not stop the runtime and is dismissible by the player.
  // Auto-clears on the next successful dispatch.
  rejection: GameplayRejection | null;
  sandboxResetError: SandboxResetError | null;
}

export type RuntimeCommandResult = RuntimeSnapshot | Promise<RuntimeSnapshot>;

export type RuntimeListener = (snapshot: RuntimeSnapshot) => void;

export interface RuntimeController {
  persistence: RuntimePersistenceController;
  getSnapshot: () => RuntimeSnapshot;
  subscribe: (listener: RuntimeListener) => () => void;
  start: () => void;
  stop: () => void;
  /** Terminally stop the runtime and suppress late work. */
  dispose: () => void;
  isRunning: () => boolean;
  tick: (deltaSeconds: number) => RuntimeCommandResult;
  reset: () => RuntimeCommandResult;
  resetUi: () => RuntimeSnapshot;
  setTool: (tool: Tool) => RuntimeSnapshot;
  setBuilding: (building: BuildingType) => RuntimeSnapshot;
  setArea: (area: AreaKind) => RuntimeSnapshot;
  setRoadPreset: (preset: RoadPreset) => RuntimeSnapshot;
  setBuildCategory: (category: BuildCategoryId | null) => RuntimeSnapshot;
  armRoad: (preset: RoadPreset) => RuntimeSnapshot;
  armRoundabout: (size: RoundaboutSize) => RuntimeSnapshot;
  startDrag: (point: Point) => RuntimeSnapshot;
  setDragCurrent: (point: Point | null) => RuntimeSnapshot;
  commitDrag: () => RuntimeCommandResult;
  cancelDrag: () => RuntimeSnapshot;
  rotateBuilding: () => RuntimeSnapshot;
  setOverlay: (overlay: Overlay | null) => RuntimeSnapshot;
  togglePause: () => RuntimeCommandResult;
  setSpeed: (speed: GameState["speed"]) => RuntimeCommandResult;
  setHudCategory: (category: HudCategory | null) => RuntimeSnapshot;
  handleTileClick: (point: Point) => RuntimeCommandResult;
  assignRouteToPlatform: (
    nodeId: string,
    routeId: string,
    platformId: string,
  ) => RuntimeCommandResult;
  startRouteEdit: (routeId: string) => RuntimeSnapshot;
  selectRouteWaypoint: (
    index: number | null,
    interaction: RouteDraft["interaction"],
  ) => RuntimeSnapshot;
  removeRouteWaypoint: () => RuntimeSnapshot;
  moveRouteWaypoint: (delta: -1 | 1) => RuntimeSnapshot;
  reverseRouteDraft: () => RuntimeSnapshot;
  setRoutePattern: (pattern: ServicePattern) => RuntimeSnapshot;
  undoRouteDraft: () => RuntimeSnapshot;
  redoRouteDraft: () => RuntimeSnapshot;
  saveRouteDraft: () => Promise<RuntimeSnapshot>;
  cancelRouteDraft: () => RuntimeSnapshot;
  reloadRouteDraft: () => RuntimeSnapshot;
  handleEscape: () => RuntimeSnapshot;
  renameRoute: (routeId: string, name: string) => RuntimeCommandResult;
  recolorRoute: (routeId: string, color: string) => RuntimeCommandResult;
  toggleRouteActive: (routeId: string) => RuntimeCommandResult;
  deleteRoute: (routeId: string) => RuntimeCommandResult;
  selectRoute: (routeId: string | null) => RuntimeSnapshot;
  focusRouteFailure: (routeId: string, legIndex: number) => RuntimeSnapshot;
  setHoverTile: (point: Point | null) => RuntimeSnapshot;
  previewRoadMutation: (mutation: RoadMutation) => RuntimeSnapshot;
  dismissRejection: () => RuntimeSnapshot;
  mountCanvas: (host: HTMLElement) => () => void;
}

/**
 * Test-only debug seams that {@link createGameRuntime} implements but that
 * are intentionally excluded from the public {@link RuntimeController}
 * interface so production consumers cannot accidentally depend on them.
 *
 * Harnesses and tests intersect this with `RuntimeController` when they need
 * debug access:
 * ```ts
 * const runtime = await createGameRuntime(options) as RuntimeController &
 *   RuntimeTestSeam;
 * ```
 *
 * `createGameRuntime` returns `Promise<RuntimeController & RuntimeTestSeam>`
 * so tests get the full type automatically; production code narrows to
 * `RuntimeController` via a type annotation.
 */
export interface RuntimeTestSeam {
  debugSetBudget: (budget: number) => RuntimeCommandResult;
}

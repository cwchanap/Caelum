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
} from "./persistenceCoordinator";

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
  // Terminal persistence-recovery state. When `state === "recoveryRequired"`,
  // the runtime is dead: the lease is permanently pinned and no further
  // gameplay, saves, or controller calls reach the backend or store. The
  // application MUST render a recovery/error screen and NOT attempt to start
  // a replacement `createGameRuntime` against the same storage identity
  // (it would hang indefinitely because the lease is never released). The
  // user must reconcile the durable storage out of band (e.g. by reloading
  // the page/process) before retrying.
  //
  // Present in the initial snapshot so App can detect a bootstrap-born
  // terminal runtime before calling `start()`. Also set when a live
  // runtime's late-success cleanup or ambiguous-failure reconciliation
  // enters the terminal persistence-recovery state.
  recovery: RuntimeRecoveryState;
}

export type RuntimeCommandResult = RuntimeSnapshot | Promise<RuntimeSnapshot>;

export type RuntimeListener = (snapshot: RuntimeSnapshot) => void;

/**
 * Terminal persistence-recovery state surfaced through {@link RuntimeSnapshot.recovery}
 * and {@link RuntimeDisposeResult}. When `state === "recoveryRequired"`, the
 * runtime is dead and the lease is permanently pinned.
 */
export type RuntimeRecoveryState =
  | { state: "ok" }
  | {
      state: "recoveryRequired";
      reason: "lateSuccessCleanupFailed";
      cityId: string;
    }
  | {
      state: "recoveryRequired";
      reason: "bootstrapReconciliationFailed";
      cityId: string | null;
    };

/**
 * Typed error thrown by {@link createGameRuntime} when bootstrap reconciliation
 * fails (a leftover pending city record could not be deleted, or `listCities`
 * itself failed). The runtime is NOT created — the application should render
 * a recovery/error screen and NOT attempt to create a replacement runtime
 * against the same storage identity (the lease is permanently pinned).
 */
export interface BootstrapRecoveryError {
  reason: "bootstrapReconciliationFailed";
  cityId: string | null;
}

/**
 * The outcome of {@link RuntimeController.dispose}. Distinguishes a normal
 * release (the lease was released and a replacement runtime can acquire it)
 * from a fatal persistence-recovery state (the lease is permanently pinned
 * and a replacement runtime against the same storage identity cannot
 * acquire it).
 *
 * Application code that does `await oldRuntime.dispose()` followed by
 * `await createGameRuntime(options)` MUST check the outcome: if
 * `status === "recoveryRequired"`, the second call hangs indefinitely
 * because the lease is never released. The application must reconcile the
 * orphan storage out of band (e.g. by reloading the page/process, or by
 * manually repairing the durable storage for `cityId`) before retrying.
 */
export type RuntimeDisposeResult =
  | { status: "released" }
  | {
      status: "recoveryRequired";
      reason: "lateSuccessCleanupFailed";
      cityId: string;
    }
  | {
      status: "recoveryRequired";
      reason: "bootstrapReconciliationFailed";
      cityId: string | null;
    };

export interface RuntimeController {
  persistence: RuntimePersistenceController;
  getSnapshot: () => RuntimeSnapshot;
  subscribe: (listener: RuntimeListener) => () => void;
  start: () => void;
  stop: () => void;
  /**
   * Gracefully shut down the runtime: reject new persistence operations,
   * stop animation/preview, drain all pending city persistence FIFOs, and
   * release the shared coordinator lease so a replacement runtime against
   * the same durable storage can acquire it.
   *
   * The returned promise resolves after all pending storage mutations have
   * settled. The {@link RuntimeDisposeResult} outcome reports whether the
   * lease was released:
   *
   * - `{ status: "released" }` — the lease was released. A replacement
   *   `createGameRuntime` against the same `SaveStore` (or a different
   *   adapter object with the same `storageIdentity`) that was started
   *   before this `dispose` resolves will have been waiting for the lease;
   *   it acquires the lease and proceeds only after this runtime's writes
   *   have drained.
   *
   * - `{ status: "recoveryRequired", reason: "lateSuccessCleanupFailed",
   *   cityId }` — late-success cleanup of a New City write could not undo
   *   the orphan storage mutation (the store returned a typed error or threw
   *   an adapter exception). The lease is permanently pinned so a
   *   replacement runtime against the same storage identity cannot acquire
   *   it. The application MUST reconcile the orphan storage for `cityId` out
   *   of band (e.g. by reloading the page/process) before retrying
   *   `createGameRuntime`. Calling `createGameRuntime` against the same
   *   storage identity after this outcome hangs indefinitely.
   *
   * - `{ status: "recoveryRequired", reason: "bootstrapReconciliationFailed",
   *   cityId }` — bootstrap reconciliation could not delete a leftover
   *   pending city record (from a prior crashed New City transaction) or
   *   could not list cities to find pending orphans. `cityId` is the pending
   *   record's ID when known, or `null` when `listCities` itself failed. The
   *   lease is permanently pinned; the application MUST reconcile the
   *   durable storage out of band before retrying `createGameRuntime`.
   *
   * If an uncancellable store operation never settles, this promise never
   * resolves — safe rebootstrap cannot proceed until pending storage I/O
   * settles.
   *
   * Idempotent: calling `dispose` after a fatal backend failure awaits the
   * drain-and-release that `failBackend` started.
   */
  dispose: () => Promise<RuntimeDisposeResult>;
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
  debugSetBudget: (budget: number) => RuntimeCommandResult;
  // Test-only seam onto this runtime's per-city persistence FIFO. Production
  // code never calls this; it exists so a harness can inject an "older write"
  // that the runtime's own candidate write must serialize behind.
  debugEnqueueCityPersistence: <T>(
    cityId: string,
    work: () => Promise<T>,
  ) => Promise<T>;
  mountCanvas: (host: HTMLElement) => () => void;
}

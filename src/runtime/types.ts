import type {
  AreaKind,
  BuildingType,
  GameState,
  GameplayRejection,
  Overlay,
  Point,
  RoadPreset,
  Tool,
} from "../domain/types";
import type { BuildCategoryId } from "../domain/catalog/buildMenu";
import type { HudCategory, UiState } from "../ui/uiState";

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

export interface ShellRouteDraftStop {
  index: number;
  label: string;
  coord: string;
}

export interface ShellRouteDraftState {
  mode: "bus" | "metro";
  stops: ShellRouteDraftStop[];
  distinctCount: number;
  vehicleCost: number;
  canFinish: boolean;
  finishHint: string;
}

export interface ShellRouteListItem {
  id: string;
  name: string;
  color: string;
  mode: "bus" | "metro";
  stopCount: number;
  active: boolean;
  selected: boolean;
}

export type ShellRouteListState = ShellRouteListItem[];

export interface ShellState {
  topbar: ShellTopbarState;
  brief: ShellBriefState;
  hud: ShellHudState;
  inspector: ShellInspectorState | null;
  routeDraft: ShellRouteDraftState | null;
  routes: ShellRouteListState;
}

export interface RuntimeSnapshot {
  state: GameState;
  ui: UiState;
  shell: ShellState;
  backendError: string | null;
  // Recoverable gameplay rejection (e.g. unaffordable placement, rejected
  // vehicle assignment). Distinct from `backendError` (fatal host failure):
  // a rejection does not stop the runtime and is dismissible by the player.
  // Auto-clears on the next successful dispatch.
  rejection: GameplayRejection | null;
}

export type RuntimeCommandResult = RuntimeSnapshot | Promise<RuntimeSnapshot>;

export type RuntimeListener = (snapshot: RuntimeSnapshot) => void;

export interface RuntimeController {
  getSnapshot: () => RuntimeSnapshot;
  subscribe: (listener: RuntimeListener) => () => void;
  start: () => void;
  stop: () => void;
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
  removeDraftStop: (index: number) => RuntimeSnapshot;
  finishRoute: () => RuntimeCommandResult;
  cancelRoute: () => RuntimeSnapshot;
  renameRoute: (routeId: string, name: string) => RuntimeCommandResult;
  recolorRoute: (routeId: string, color: string) => RuntimeCommandResult;
  toggleRouteActive: (routeId: string) => RuntimeCommandResult;
  deleteRoute: (routeId: string) => RuntimeCommandResult;
  selectRoute: (routeId: string | null) => RuntimeSnapshot;
  setHoverTile: (point: Point | null) => RuntimeSnapshot;
  dismissRejection: () => RuntimeSnapshot;
  mountCanvas: (host: HTMLElement) => () => void;
}

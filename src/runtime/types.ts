import type {
  AreaKind,
  BuildingType,
  GameState,
  Overlay,
  Point,
  RoadPreset,
  Tool,
} from "../domain/types";
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
}

export type RuntimeListener = (snapshot: RuntimeSnapshot) => void;

export interface RuntimeController {
  getSnapshot: () => RuntimeSnapshot;
  subscribe: (listener: RuntimeListener) => () => void;
  start: () => void;
  stop: () => void;
  isRunning: () => boolean;
  tick: (deltaSeconds: number) => RuntimeSnapshot;
  reset: () => RuntimeSnapshot;
  resetUi: () => RuntimeSnapshot;
  setTool: (tool: Tool) => RuntimeSnapshot;
  setBuilding: (building: BuildingType) => RuntimeSnapshot;
  setArea: (area: AreaKind) => RuntimeSnapshot;
  setRoadPreset: (preset: RoadPreset) => RuntimeSnapshot;
  startDrag: (point: Point) => RuntimeSnapshot;
  setDragCurrent: (point: Point | null) => RuntimeSnapshot;
  commitDrag: () => RuntimeSnapshot;
  cancelDrag: () => RuntimeSnapshot;
  rotateBuilding: () => RuntimeSnapshot;
  setOverlay: (overlay: Overlay | null) => RuntimeSnapshot;
  togglePause: () => RuntimeSnapshot;
  setSpeed: (speed: GameState["speed"]) => RuntimeSnapshot;
  setHudCategory: (category: HudCategory | null) => RuntimeSnapshot;
  handleTileClick: (point: Point) => RuntimeSnapshot;
  assignRouteToPlatform: (
    nodeId: string,
    routeId: string,
    platformId: string,
  ) => RuntimeSnapshot;
  removeDraftStop: (index: number) => RuntimeSnapshot;
  finishRoute: () => RuntimeSnapshot;
  cancelRoute: () => RuntimeSnapshot;
  renameRoute: (routeId: string, name: string) => RuntimeSnapshot;
  recolorRoute: (routeId: string, color: string) => RuntimeSnapshot;
  toggleRouteActive: (routeId: string) => RuntimeSnapshot;
  deleteRoute: (routeId: string) => RuntimeSnapshot;
  selectRoute: (routeId: string | null) => RuntimeSnapshot;
  setHoverTile: (point: Point | null) => RuntimeSnapshot;
  mountCanvas: (host: HTMLElement) => () => void;
}

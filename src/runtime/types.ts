import type {
  BuildingType,
  GameState,
  Overlay,
  Point,
  Tool,
} from "../domain/types";
import type { UiState } from "../ui/uiState";

export interface ShellTopbarState {
  budget: string;
  signalState: string;
  time: string;
  population: string;
  late: string;
  unserved: string;
  avgWait: string;
}

export interface ShellControlTowerState {
  title: string;
  status: string;
  objective: string;
  lossNote: string;
  nextGrowth: string;
  selectedId: string;
  activeTool: string;
  controlTowerOpen: boolean;
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

export interface ShellState {
  topbar: ShellTopbarState;
  controlTower: ShellControlTowerState;
  inspector: ShellInspectorState | null;
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
  rotateBuilding: () => RuntimeSnapshot;
  setOverlay: (overlay: Overlay | null) => RuntimeSnapshot;
  togglePause: () => RuntimeSnapshot;
  setSpeed: (speed: GameState["speed"]) => RuntimeSnapshot;
  toggleControlTower: () => RuntimeSnapshot;
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

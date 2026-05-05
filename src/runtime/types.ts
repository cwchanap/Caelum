import type { GameState, Overlay, Point, Tool } from "../domain/types";
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

export interface ShellState {
  topbar: ShellTopbarState;
  controlTower: ShellControlTowerState;
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
  setOverlay: (overlay: Overlay | null) => RuntimeSnapshot;
  togglePause: () => RuntimeSnapshot;
  setSpeed: (speed: GameState["speed"]) => RuntimeSnapshot;
  toggleControlTower: () => RuntimeSnapshot;
  handleTileClick: (point: Point) => RuntimeSnapshot;
  setHoverTile: (point: Point | null) => RuntimeSnapshot;
  mountCanvas: (host: HTMLElement) => () => void;
}

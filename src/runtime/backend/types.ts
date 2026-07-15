import type {
  ActiveTrip,
  AreaKind,
  BuildingRotation,
  BuildingType,
  GameMap,
  GrowthWave,
  GameplayRejection,
  Heading,
  PlacedBuilding,
  Point,
  RoundaboutSize,
  RoadStructure,
  RouteLegPath,
  ServicePattern,
  Sim,
  TransitMode,
  TripOutcomeKind,
  TransitNetwork,
} from "../../domain/types";

export type RoadPresetIntent = "twoWay" | "oneWay" | "dualBidirectional";

export interface RustTripOutcome {
  outcome: TripOutcomeKind;
  waitSeconds: number;
  time: number;
}

export interface RustMetrics {
  lateTrips: number;
  completedTrips: number;
  unservedTrips: number;
  totalWaitSeconds: number;
  waitingTripCount: number;
  averageWaitSeconds: number;
  tripOutcomes: RustTripOutcome[];
  state: "running" | "won" | "lost";
  lossReason: string | null;
}

export interface RustObjectiveThresholds {
  maxLateRatio: number;
  maxUnservedRatio: number;
  maxAverageWait: number;
  rollingWindowSeconds: number;
  survivalTime: number;
}

/// Static scenario identity + objective thresholds shipped on every Rust
/// snapshot. The thresholds are the authoritative values the core's
/// `evaluate_objectives` enforces; the shell must read them from here rather
/// than hard-coding a local copy (which drifted: `rollingWindowSeconds` was 600
/// in the TS shim while the core evaluates at 300). Growth waves ship here
/// too (empty for Growing Suburb); the shell reads them read-only.
export interface RustScenarioConfig {
  name: string;
  objectives: RustObjectiveThresholds;
  growthWaves: GrowthWave[];
}

export interface RustGameSnapshot {
  schemaVersion: 2;
  time: number;
  day: number;
  clockMinutes: number;
  speed: 0 | 1 | 2 | 4;
  paused: boolean;
  budget: number;
  map: GameMap;
  buildings: PlacedBuilding[];
  transit: TransitNetwork;
  sims: Sim[];
  activeTrips: ActiveTrip[];
  tripSequenceDay: number;
  nextTripSequence: number;
  metrics: RustMetrics;
  scenario: RustScenarioConfig;
}

export type GameIntent =
  | { type: "setPaused"; paused: boolean }
  | { type: "setSpeed"; speed: 0 | 1 | 2 | 4 }
  | { type: "assignVehicle"; mode: "bus" | "metro"; lineId: string }
  | { type: "layRoad"; point: Point }
  | { type: "layRoadLine"; points: Point[]; preset: RoadPresetIntent }
  | { type: "cycleRoadDirection"; point: Point }
  | { type: "placeRoundabout"; origin: Point; size: RoundaboutSize }
  | { type: "layTrack"; point: Point }
  | { type: "layTrackLine"; points: Point[] }
  | { type: "removeAtTile"; point: Point }
  | { type: "removeAtTiles"; points: Point[] }
  | { type: "addBusStop"; point: Point }
  | { type: "addMetroStation"; point: Point }
  | {
      type: "createRoute";
      mode: "bus" | "metro";
      pattern: ServicePattern;
      waypointIds: string[];
    }
  | {
      type: "updateRoute";
      routeId: string;
      expectedRevision: number;
      pattern: ServicePattern;
      waypointIds: string[];
    }
  | { type: "setRouteActive"; routeId: string; active: boolean }
  | { type: "renameRoute"; routeId: string; name: string }
  | { type: "recolorRoute"; routeId: string; color: string }
  | { type: "deleteRoute"; routeId: string }
  | {
      type: "assignRouteToPlatform";
      nodeId: string;
      routeId: string;
      platformId: string;
    }
  | {
      type: "paintAreaRectangle";
      area: AreaKind;
      start: Point;
      end: Point;
    }
  | {
      type: "placeBuilding";
      buildingType: BuildingType;
      origin: Point;
      rotation: BuildingRotation;
    }
  | { type: "setBudget"; budget: number };

export interface DispatchContext {
  changedTiles: Point[];
  skippedTiles: Point[];
  affectedRouteIds: string[];
  cost: number;
}

export interface DispatchResult {
  snapshot: RustGameSnapshot;
  applied: boolean;
  rejection: GameplayRejection | null;
  context: DispatchContext;
}

export type RoadMutation =
  | { type: "layRoad"; point: Point }
  | { type: "layRoadLine"; points: Point[]; preset: RoadPresetIntent }
  | { type: "cycleRoadDirection"; point: Point }
  | { type: "placeRoundabout"; origin: Point; size: RoundaboutSize }
  | { type: "removeAtTile"; point: Point }
  | { type: "removeAtTiles"; points: Point[] };

export interface RoutePreviewRequest {
  mode: TransitMode;
  pattern: ServicePattern;
  waypointIds: string[];
  routeId: string | null;
  expectedRevision: number | null;
  generation: number;
}

export interface TurnSummary {
  straight: number;
  rightTurn: number;
  leftTurn: number;
  uTurn: number;
  roundaboutEntry: number;
}

export type WarningCode =
  | "skippedTiles"
  | "existingBrokenLeg"
  | "routeWillReroute"
  | "routeWillBreak";

export interface GameplayWarning {
  code: WarningCode;
  context: GameplayRejection["context"];
}

export interface RoutePreviewResponse {
  generation: number;
  legs: RouteLegPath[];
  totalTravelSeconds: number;
  initialVehicleCost: number;
  affordable: boolean;
  turnSummary: TurnSummary;
  missingWaypointIds: string[];
  warnings: GameplayWarning[];
  rejection: GameplayRejection | null;
}

export interface RoadMutationPreviewRequest {
  mutation: RoadMutation;
  generation: number;
}

export type RouteImpactKind = "rerouted" | "broken";

export interface RouteImpact {
  routeId: string;
  kind: RouteImpactKind;
}

export interface AuthoredRoadTilePreview {
  point: Point;
  /** serde_wasm_bindgen may omit Rust Option::None; Tauri JSON emits null. */
  oneWay?: Heading | null;
  roadConnections: Heading[];
  /** serde_wasm_bindgen may omit Rust Option::None; Tauri JSON emits null. */
  roadStructureId?: string | null;
}

export interface RoadMutationPreviewResponse {
  generation: number;
  changedTiles: Point[];
  authoredTiles: AuthoredRoadTilePreview[];
  generatedStructures: RoadStructure[];
  cost: number;
  skippedTiles: Point[];
  routeImpacts: RouteImpact[];
  warnings: GameplayWarning[];
  rejection: GameplayRejection | null;
}

export interface GameBackend {
  snapshot(): Promise<RustGameSnapshot>;
  dispatch(intent: GameIntent): Promise<DispatchResult>;
  tick(deltaSeconds: number): Promise<DispatchResult>;
  reset(): Promise<RustGameSnapshot>;
  previewRoute(request: RoutePreviewRequest): Promise<RoutePreviewResponse>;
  previewRoadMutation(
    request: RoadMutationPreviewRequest,
  ): Promise<RoadMutationPreviewResponse>;
}

import type {
  ActiveTrip,
  AreaKind,
  BuildingRotation,
  BuildingType,
  GameMap,
  GameRules,
  GrowthWave,
  GameplayRejection,
  Heading,
  LegFailureReason,
  MetroLine,
  PlacedBuilding,
  Point,
  RoundaboutSize,
  Route,
  RouteLeg,
  SNAPSHOT_SCHEMA_VERSION,
  RoutePlan,
  ServiceDirection,
  RoadStructure,
  RouteLegPath,
  ServicePattern,
  Sim,
  TransitPath,
  TransitMode,
  TripOutcomeKind,
  TripPosition,
  TransitNetwork,
  Vehicle,
} from "../../domain/types";
import type { SnapshotResult } from "./persistenceContract";
export type RoadPresetIntent = "twoWay" | "oneWay" | "dualBidirectional";

export interface RustTripOutcome {
  outcome: TripOutcomeKind;
  waitSeconds: number;
  time: number;
}

export interface RustRouteLegPath extends Omit<
  RouteLegPath,
  "currentPath" | "lastValidPath" | "estimatedSeconds" | "failureReason"
> {
  currentPath: TransitPath | null | undefined;
  lastValidPath: TransitPath | null | undefined;
  estimatedSeconds: number | null | undefined;
  failureReason?: LegFailureReason;
}

export interface RustRoute extends Omit<Route, "legs"> {
  legs: RustRouteLegPath[];
}

export interface RustMetroLine extends Omit<MetroLine, "legs"> {
  legs: RustRouteLegPath[];
}

export interface RustVehicle extends Omit<Vehicle, "parkedPosition"> {
  parkedPosition: TripPosition | null | undefined;
}

export interface RustSim extends Omit<Sim, "shiftTemplate" | "workplace"> {
  shiftTemplate?: "standard" | "early" | "late" | "offPeak";
  workplace?: Point;
}

export interface RustTransitNetwork extends Omit<
  TransitNetwork,
  "routes" | "metroLines" | "vehicles"
> {
  routes: RustRoute[];
  metroLines: RustMetroLine[];
  vehicles: RustVehicle[];
}

export interface RustRoutePlanLeg extends Omit<
  RouteLeg,
  "serviceDirection" | "boardItineraryIndex" | "alightItineraryIndex"
> {
  serviceDirection: ServiceDirection | null | undefined;
  boardItineraryIndex: number | null | undefined;
  alightItineraryIndex: number | null | undefined;
}

export interface RustRoutePlan extends Omit<RoutePlan, "legs"> {
  legs: RustRoutePlanLeg[];
}

export interface RustActiveTrip extends Omit<ActiveTrip, "routePlan"> {
  routePlan: RustRoutePlan | null | undefined;
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
  lossReason: string | null | undefined;
}

export interface RustObjectiveThresholds {
  maxLateRatio: number;
  maxUnservedRatio: number;
  maxAverageWait: number;
  rollingWindowSeconds: number;
  survivalTime: number;
}

/// Schema-v4 raw snapshots always include scenario identity, growth waves, and
/// an `objectives` key. Its value is objective thresholds, JSON/Tauri `null`,
/// or present WASM `undefined`; both host encodings of Rust `None` normalize
/// to canonical `null`. Non-null thresholds remain authoritative core data.
export interface RustScenarioConfig {
  name: string;
  objectives: RustObjectiveThresholds | null | undefined;
  growthWaves: GrowthWave[];
}

export interface RustGameSnapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  rules: GameRules;
  time: number;
  day: number;
  clockMinutes: number;
  speed: 0 | 1 | 2 | 4;
  paused: boolean;
  budget: number;
  map: GameMap;
  buildings: PlacedBuilding[];
  transit: RustTransitNetwork;
  sims: RustSim[];
  activeTrips: RustActiveTrip[];
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

export interface DispatchResult {
  snapshot: RustGameSnapshot;
  applied: boolean;
  rejection: GameplayRejection | null;
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
  | "routeWillBreak"
  | "insufficientBudget";

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

export interface SandboxCreationRequest {
  templateId: string;
  economyPreset: string;
  startingCapital: number;
  demandMultiplier: number;
  moveInRate: string;
}

export type SandboxCreationErrorCode =
  | "unknownTemplateId"
  | "unknownEconomyPreset"
  | "invalidStartingCapital"
  | "invalidDemandMultiplier"
  | "unknownMoveInRate"
  | "templateInvariantViolation";

export interface SandboxCreationError {
  code: SandboxCreationErrorCode;
  context: {
    field?: string;
    attemptedValue?: string;
    templateId?: string;
    [key: string]: unknown;
  };
}

export type SandboxResetErrorCode =
  | "unsupportedGameMode"
  | "templateInvariantViolation";

export interface SandboxResetError {
  code: SandboxResetErrorCode;
  context: {
    gameMode?: "sandbox" | "campaign";
    templateId?: "blankGrid" | "crossroads";
    [key: string]: unknown;
  };
}

export type SandboxCreationResult =
  | { ok: true; snapshot: RustGameSnapshot }
  | { ok: false; error: SandboxCreationError };

export type SandboxResetResult =
  | { ok: true; snapshot: RustGameSnapshot }
  | { ok: false; error: SandboxResetError };

export interface GameBackend {
  snapshot(): Promise<RustGameSnapshot>;
  snapshotForSave(): Promise<SnapshotResult>;
  buildSandboxSnapshot(
    request: SandboxCreationRequest,
  ): Promise<SandboxCreationResult>;
  restoreSnapshot(snapshot: unknown): Promise<SnapshotResult>;
  dispatch(intent: GameIntent): Promise<DispatchResult>;
  tick(deltaSeconds: number): Promise<DispatchResult>;
  reset(): Promise<SandboxResetResult>;
  previewRoute(request: RoutePreviewRequest): Promise<RoutePreviewResponse>;
  previewRoadMutation(
    request: RoadMutationPreviewRequest,
  ): Promise<RoadMutationPreviewResponse>;
}

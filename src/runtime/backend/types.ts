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
import type {
  PersistenceSnapshotRequest,
  PersistenceSnapshotResultOf,
  PersistenceValidationResult,
} from "./persistenceContract";

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

/**
 * Per-dispatch impact metadata from Rust. Reserved for future UI (e.g. post-
 * apply feedback); production TypeScript currently reads impact only from
 * route/road *preview* responses, not from `DispatchResult.context`.
 */
export interface DispatchContext {
  changedTiles: Point[];
  skippedTiles: Point[];
  affectedRouteIds?: string[];
  cost: number;
}

export interface DispatchResult {
  snapshot: RustGameSnapshot;
  applied: boolean;
  rejection: GameplayRejection | null;
  /** Wire-complete impact context; reserved — not consumed by the runtime yet. */
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

export type PersistenceSnapshotResult =
  PersistenceSnapshotResultOf<RustGameSnapshot>;

/**
 * Stable identity for the mutable backend engine a `GameBackend` addresses.
 *
 * The Tauri backend is process-global: every `createTauriBackend()` facade
 * invokes commands against one `Mutex<GameEngine>` in the Rust host. Two
 * separate facade objects therefore share one mutable engine, and a
 * replacement runtime that reads `backend.snapshot()` before the old
 * runtime's backend operations have settled can observe a stale or
 * mid-mutation snapshot.
 *
 * `runtimeIdentity` lets a shared backend ownership coordinator serialize
 * runtime lifetimes by engine identity rather than by facade object
 * identity. When present, all facades addressing the same engine MUST
 * expose the same identity so the coordinator gives them one exclusive
 * lease. When absent, the coordinator falls back to object identity —
 * safe for single-facade usage (e.g. a WASM backend whose engine is
 * instance-local) but without cross-facade protection.
 */
export type RuntimeIdentity = string;

/**
 * The result of beginning a runtime session: the authoritative runtime epoch
 * plus the initial snapshot from the same critical section.
 *
 * The Tauri backend's `beginRuntime()` calls `game_begin_runtime` which
 * atomically increments the process-global epoch and returns the snapshot
 * from the same mutex hold. The epoch is then carried on every subsequent
 * mutating command (`dispatch`, `tick`, `restoreSnapshot`, `createSandbox`,
 * `reset`, `snapshotForSave`) so the Rust host can reject stale commands from
 * a previous webview realm after a soft reload.
 *
 * The WASM backend's `beginRuntime()` returns `runtimeEpoch: 0` — the WASM
 * engine is instance-local with no cross-realm authority, so no epoch
 * verification is needed.
 */
export interface RuntimeSession {
  runtimeEpoch: number;
  snapshot: RustGameSnapshot;
}

export interface GameBackend {
  /**
   * Stable identity for the mutable backend engine this facade addresses.
   * See {@link RuntimeIdentity}. When omitted, backend ownership
   * coordination falls back to object identity.
   */
  readonly runtimeIdentity?: RuntimeIdentity;
  /**
   * Begin a runtime session: atomically acquire the authoritative runtime
   * epoch and the initial snapshot. The Tauri backend stores the epoch
   * internally and passes it on all subsequent mutating commands. The WASM
   * backend returns epoch 0 (instance-local, no cross-realm authority).
   *
   * When omitted (e.g. test mocks), the runtime falls back to `snapshot()`
   * with epoch 0 — no epoch verification occurs.
   */
  beginRuntime?(): Promise<RuntimeSession>;
  snapshot(): Promise<RustGameSnapshot>;
  snapshotForSave(): Promise<PersistenceSnapshotResult>;
  validateSnapshot(
    request: PersistenceSnapshotRequest,
  ): Promise<PersistenceValidationResult>;
  restoreSnapshot(
    request: PersistenceSnapshotRequest,
  ): Promise<PersistenceSnapshotResult>;
  createSandbox(
    request: SandboxCreationRequest,
  ): Promise<SandboxCreationResult>;
  dispatch(intent: GameIntent): Promise<DispatchResult>;
  tick(deltaSeconds: number): Promise<DispatchResult>;
  reset(): Promise<SandboxResetResult>;
  previewRoute(request: RoutePreviewRequest): Promise<RoutePreviewResponse>;
  previewRoadMutation(
    request: RoadMutationPreviewRequest,
  ): Promise<RoadMutationPreviewResponse>;
}

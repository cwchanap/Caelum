export type TileKind = "empty" | "road";
export const SNAPSHOT_SCHEMA_VERSION = 7 as const;
export type GameMode = "sandbox" | "campaign";
export type EconomyPreset = "standard" | "creative";
export type SandboxTemplateId = "blankGrid" | "crossroads";

export interface GameRules {
  gameMode: GameMode;
  economyPreset: EconomyPreset;
  sandbox: {
    templateId: SandboxTemplateId;
    startingCapital: number;
    demandMultiplier: number;
  };
}

export interface ObjectiveThresholds {
  maxLateRatio: number;
  maxUnservedRatio: number;
  maxAverageWait: number;
  rollingWindowSeconds: number;
  survivalTime: number;
}
export type AreaKind =
  | "residential"
  | "commercial"
  | "industrial"
  | "office"
  | "civic"
  | "park";
export type Heading = "north" | "east" | "south" | "west";
export type RoadDirection = Heading;
export type TransitMode = "walk" | "bus" | "metro";
export type ServicePattern = "loop" | "shuttle";
export type ServiceDirection = "loop" | "outbound" | "return";
export type RouteLegKind = "service" | "terminalReversal";
export type RouteLegStatus =
  | "connected"
  | "networkDisconnected"
  | "missingNode";
export type LegFailureReason =
  | "noRoadAccess"
  | "networkDisconnected"
  | "noLegalEntryHeading"
  | "noLegalExitHeading"
  | "noLegalTurnaround";
export type BuildingType =
  | "busStop"
  | "busTerminal"
  | "metroStation"
  | "smallHouse"
  | "largeHouse"
  | "supermarket"
  | "cinema"
  | "factory"
  | "warehouse"
  | "officeTower"
  | "businessPark"
  | "clinic"
  | "school"
  | "parkPlaza";
export type BuildingRotation = 0 | 90 | 180 | 270;
export type StopKind = "busStop" | "busTerminal";
export type TransitNodeStatus = "present" | "missing";
export type CitizenStatus =
  | "idle"
  | "walking"
  | "waiting"
  | "riding"
  | "driving"
  | "arrived"
  | "late"
  | "unserved";
export type Tool =
  | "inspect"
  | "busStop"
  | "busRoute"
  | "metroStation"
  | "metroLine"
  | "area"
  | "road"
  | "roundabout"
  | "track"
  | "remove";
export type RoadPreset = "twoWay" | "oneWay" | "dualBidirectional";
export type Overlay =
  | "coverage"
  | "crowding"
  | "demand"
  | "lateness"
  | "traffic"
  | "growth";

export interface Point {
  x: number;
  y: number;
}

/** Structural equality for two (possibly null) points. */
export function samePoint(left: Point | null, right: Point | null): boolean {
  return left?.x === right?.x && left?.y === right?.y;
}

export type RoundaboutSize = "compact2x2" | "standard3x3";

export type PortDirection = "twoWay" | "inbound" | "outbound";

export interface RoadPort {
  id: string;
  point: Point;
  edge: Heading;
  direction?: PortDirection;
}

export type RoadStructure =
  | {
      kind: "automaticJunction";
      id: string;
      footprint: Point[];
      ports: RoadPort[];
    }
  | {
      kind: "roundabout";
      id: string;
      origin: Point;
      size: RoundaboutSize;
      footprint: Point[];
      ports: RoadPort[];
    };

export type RejectionCode =
  | "insufficientBudget"
  | "invalidSpeed"
  | "blockedTile"
  | "outOfBounds"
  | "roadRequired"
  | "noRoadAccess"
  | "trackRequired"
  | "invalidRoadStroke"
  | "invalidTrackStroke"
  | "invalidDirectionChange"
  | "nodeAlreadyExists"
  | "ambiguousTransitNode"
  | "missingRouteNode"
  | "incompatibleRouteNode"
  | "tooFewRouteNodes"
  | "duplicateRouteNodes"
  | "disconnectedLeg"
  | "routeChangedWhileEditing"
  | "routeRevisionExhausted"
  | "routeNotFound"
  | "inactiveRoute"
  | "structureNotFound"
  | "invalidPlatform"
  | "invalidBuildingPlacement"
  | "blockedFootprint"
  | "unsafeRoundaboutPortMapping"
  | "invalidHeadway"
  | "headwayNotSet"
  | "fleetAlreadyAssigned";

export interface RejectionContext {
  routeId?: string;
  nodeId?: string;
  structureId?: string;
  fromWaypointId?: string;
  toWaypointId?: string;
  point?: Point;
  footprint?: Point[];
  expectedRevision?: number;
  actualRevision?: number;
  requiredBudget?: number;
  availableBudget?: number;
  /** Present on every Rust rejection; optional so omitted serde payloads normalize cleanly. */
  affectedRouteIds?: string[];
}

export interface GameplayRejection {
  code: RejectionCode;
  context: RejectionContext;
}

/** Unit direction vector for each road arrow (canonical direction -> vector). */
export const ROAD_DIRECTION_OFFSET: Record<RoadDirection, Point> = {
  north: { x: 0, y: -1 },
  east: { x: 1, y: 0 },
  south: { x: 0, y: 1 },
  west: { x: -1, y: 0 },
};

export interface Tile extends Point {
  id: string;
  kind: TileKind;
  /** Zoning layer; independent of `kind`. Long-lived across kind transitions
   *  (setTileKind retains it) and only honored by the renderer on `empty`
   *  tiles, so an `area` set on a road/building tile is latent state until
   *  the tile is bulldozed back to empty. */
  area?: AreaKind;
  /** Track is a layer, not a TileKind: a road tile with track is a level crossing. */
  hasTrack?: boolean;
  /** One-way constraint on a road lane. Undefined = two-way (default).
   *  Only meaningful when `kind === "road"`; stripped on non-road kinds. */
  oneWay?: RoadDirection;
  /** Authored reciprocal road edges in canonical N/E/S/W order. */
  roadConnections: Heading[];
  /** Structure ownership is independent of the road tile's visual kind. */
  roadStructureId?: string;
}

export interface GameMap {
  width: number;
  height: number;
  tiles: Tile[];
  roadStructures: RoadStructure[];
}

export interface PlacedBuilding {
  id: string;
  type: BuildingType;
  origin: Point;
  rotation: BuildingRotation;
  occupiedTiles: Point[];
  placedAt: number;
  transitNodeId?: string;
}

export interface Platform {
  id: string;
  label: string;
  capacity: number;
  routeIds: string[];
}

export interface Stop {
  id: string;
  kind: StopKind;
  status: TransitNodeStatus;
  position: Point;
  roadAccess?: StopRoadAccess;
  platforms: Platform[];
}

export interface StopRoadAccess {
  roadPoint: Point;
  preferredHeading?: Heading;
}

export interface Station {
  id: string;
  status: TransitNodeStatus;
  position: Point;
  platforms: Platform[];
}

export type MovementKind =
  | "straight"
  | "rightTurn"
  | "leftTurn"
  | "uTurn"
  | "roundaboutEntry"
  | "roundaboutCirculation"
  | "roundaboutExit";

export type PathGeometry =
  | { kind: "line"; from: TripPosition; to: TripPosition }
  | {
      kind: "quadraticBezier";
      from: TripPosition;
      control: TripPosition;
      to: TripPosition;
    }
  // Render-only: roundabout circulation curves. Constructed by
  // roundaboutRenderer's visual template and offset by routeGeometry;
  // Rust road/track path geometry never emits arcs (it uses line and
  // quadraticBezier for movement steps).
  | {
      kind: "arc";
      center: TripPosition;
      radius: number;
      startRadians: number;
      sweepRadians: number;
    };

export interface RoadPathStep {
  position: Point;
  enteringHeading: Heading;
  leavingHeading: Heading;
  movement: MovementKind;
  geometry: PathGeometry;
  travelSeconds: number;
}

export interface TrackPathStep {
  position: Point;
  heading: Heading;
  geometry: PathGeometry;
  travelSeconds: number;
}

export type TransitPath =
  | { kind: "road"; steps: RoadPathStep[]; totalTravelSeconds: number }
  | { kind: "track"; steps: TrackPathStep[]; totalTravelSeconds: number };

export interface RouteLegPath {
  fromWaypointId: string;
  toWaypointId: string;
  direction: ServiceDirection;
  kind: RouteLegKind;
  status: RouteLegStatus;
  currentPath: TransitPath | null;
  lastValidPath: TransitPath | null;
  estimatedSeconds: number | null;
  failureReason: LegFailureReason | null;
}

export interface BusServiceMetrics {
  roundTripSeconds: number;
  assignedFleet: number;
  requiredFleet: number | null;
  nominalHeadwaySeconds: number | null;
}

export interface Route {
  id: string;
  name: string;
  color: string;
  stopIds: string[];
  vehicleIds: string[];
  active: boolean;
  pattern: ServicePattern;
  revision: number;
  legs: RouteLegPath[];
  pathBroken: boolean;
  targetHeadwaySeconds: number | null;
  serviceMetrics: BusServiceMetrics | null;
}

export interface MetroLine {
  id: string;
  name: string;
  color: string;
  stationIds: string[];
  vehicleIds: string[];
  active: boolean;
  pattern: ServicePattern;
  revision: number;
  legs: RouteLegPath[];
  pathBroken: boolean;
}

export interface Vehicle {
  id: string;
  mode: "bus" | "metro";
  lineId: string;
  capacity: number;
  passengerIds: string[];
  itineraryIndex: number;
  pathStepIndex: number;
  stepProgress: number;
  parkedPosition: TripPosition | null;
}

export type WorkerProfile = "worker" | "nonWorker";
export type TripPurpose = "commuteOutbound" | "commuteReturn";

export interface Sim {
  id: string;
  home: Point;
  position: Point;
  workerProfile: WorkerProfile;
  shiftTemplate?: "standard" | "early" | "late" | "offPeak" | null;
  workplace?: Point;
  commuteDay: number;
  outboundResolvedToday: boolean;
  outboundArrivedToday: boolean;
  returnResolvedToday: boolean;
  returnedHomeToday: boolean;
}

export interface TripPosition {
  x: number;
  y: number;
}

export interface PrivateCarTrip {
  path: TransitPath;
  arrivalTime: number;
}

export interface ActiveTrip {
  id: string;
  simId: string;
  purpose: TripPurpose;
  origin: Point;
  destination: Point;
  position: TripPosition;
  status: CitizenStatus;
  deadline: number;
  routePlan: RoutePlan | null;
  currentLegIndex: number;
  patienceRemaining: number;
  privateCarTrip: PrivateCarTrip | null;
}

export interface RouteLeg {
  mode: TransitMode;
  from: Point;
  to: Point;
  lineId?: string;
  serviceDirection: ServiceDirection | null;
  boardItineraryIndex: number | null;
  alightItineraryIndex: number | null;
}

export interface RoutePlan {
  legs: RouteLeg[];
  estimatedSeconds: number;
}

export type GrowthAction =
  | { type: "paintAreaRectangle"; area: AreaKind; start: Point; end: Point }
  | {
      type: "placeBuilding";
      buildingType: BuildingType;
      origin: Point;
      rotation: BuildingRotation;
    };

export interface GrowthWave {
  id: string;
  triggerTime: number;
  message: string;
  applied: boolean;
  actions: GrowthAction[];
}

export interface Scenario {
  name: string;
  growthWaves: GrowthWave[];
  objectives: ObjectiveThresholds | null;
}

export type TripOutcomeKind = "arrived" | "late" | "unserved";

export interface TripOutcome {
  outcome: TripOutcomeKind;
  waitSeconds?: number;
  time: number;
}

export interface Metrics {
  lateTrips: number;
  completedTrips: number;
  unservedTrips: number;
  totalWaitSeconds: number;
  waitingCitizenCount: number;
  waitingTripCount?: number;
  averageWaitSeconds: number;
  tripOutcomes: TripOutcome[];
  state: "running" | "won" | "lost";
  lossReason: string | null;
}

export interface TransitNetwork {
  stops: Stop[];
  stations: Station[];
  routes: Route[];
  metroLines: MetroLine[];
  vehicles: Vehicle[];
}

export interface GameState {
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
  scenario: Scenario;
  transit: TransitNetwork;
  sims?: Sim[];
  activeTrips?: ActiveTrip[];
  tripSequenceDay?: number;
  nextTripSequence?: number;
  metrics: Metrics;
}

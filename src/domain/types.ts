export type TileKind = "empty" | "road";
export type AreaKind =
  | "residential"
  | "commercial"
  | "industrial"
  | "office"
  | "civic"
  | "park";
export type RoadDirection = "north" | "east" | "south" | "west";
export type TransitMode = "walk" | "bus" | "metro";
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
export type CitizenStatus =
  | "idle"
  | "walking"
  | "waiting"
  | "riding"
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
  | "track"
  | "remove";
export type RoadPreset = "twoWay" | "oneWay" | "dualBidirectional";
export type Overlay =
  | "coverage"
  | "crowding"
  | "demand"
  | "lateness"
  | "growth";

export interface Point {
  x: number;
  y: number;
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
}

export interface GameMap {
  width: number;
  height: number;
  tiles: Tile[];
}

export interface PlacedBuilding {
  id: string;
  type: BuildingType;
  origin: Point;
  rotation: BuildingRotation;
  occupiedTiles: Point[];
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
  position: Point;
  platforms: Platform[];
}

export interface Station {
  id: string;
  position: Point;
  platforms: Platform[];
}

export interface Route {
  id: string;
  name: string;
  color: string;
  stopIds: string[];
  vehicleIds: string[];
  active: boolean;
  /** Tile path per consecutive stop pair, closing the loop (last -> first).
   *  An unpathable pair is an empty array. */
  segments: Point[][];
  /** True when any segment is unpathable. Runs only when active && !pathBroken;
   *  network damage never touches the player's `active` toggle. */
  pathBroken: boolean;
}

export interface MetroLine {
  id: string;
  name: string;
  color: string;
  stationIds: string[];
  vehicleIds: string[];
  active: boolean;
  /** Tile path per consecutive station pair, closing the loop (last -> first).
   *  An unpathable pair is an empty array. */
  segments: Point[][];
  /** True when any segment is unpathable. Runs only when active && !pathBroken;
   *  network damage never touches the player's `active` toggle. */
  pathBroken: boolean;
}

export interface Vehicle {
  id: string;
  mode: "bus" | "metro";
  lineId: string;
  capacity: number;
  passengerIds: string[];
  segmentIndex: number;
  progress: number;
}

export interface Citizen {
  id: string;
  home: Point;
  destination: Point;
  position: Point;
  status: CitizenStatus;
  patienceRemaining: number;
  deadline: number;
  routePlan: RoutePlan | null;
  currentLegIndex: number;
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
}

export interface RouteLeg {
  mode: TransitMode;
  from: Point;
  to: Point;
  lineId?: string;
}

export interface RoutePlan {
  legs: RouteLeg[];
  estimatedSeconds: number;
}

/**
 * A tile seeded by a growth wave. Purpose-built (rather than intersecting
 * `Tile`) so authors cannot accidentally supply `kind`/`hasTrack`/`oneWay` —
 * applyDueGrowthWaves ignores them and zoned `area` only takes effect on
 * tiles that are still bare empty ground at trigger time.
 */
export interface GrowthWaveTile extends Point {
  id: string;
  area: AreaKind;
  /** Citizens spawned at this tile when the wave fires and the tile is bare. */
  createsCitizens: number;
}

export interface GrowthWave {
  id: string;
  triggerTime: number;
  tiles: GrowthWaveTile[];
  message: string;
  applied: boolean;
}

export interface Scenario {
  name: string;
  growthWaves: GrowthWave[];
  objectives: {
    maxLateRatio: number;
    maxUnservedRatio: number;
    maxAverageWait: number;
    rollingWindowSeconds: number;
    survivalTime: number;
  };
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
  time: number;
  citizens: Citizen[];
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

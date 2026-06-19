export type TileKind =
  | "empty"
  | "road"
  | "residential"
  | "jobs"
  | "civic"
  | "park";
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
  | "civicAnchor"
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
  districtId?: string;
  area?: AreaKind;
  /** Track is a layer, not a TileKind: a road tile with track is a level crossing. */
  hasTrack?: boolean;
  /** One-way constraint on a road lane. Undefined = two-way (default). */
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

export interface GrowthWave {
  id: string;
  triggerTime: number;
  tiles: Array<Tile & { createsCitizens: number }>;
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
  time: number;
  outcome: TripOutcomeKind;
}

export interface Metrics {
  lateTrips: number;
  completedTrips: number;
  unservedTrips: number;
  totalWaitSeconds: number;
  waitingCitizenCount: number;
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
  speed: 0 | 1 | 2 | 4;
  paused: boolean;
  budget: number;
  map: GameMap;
  buildings: PlacedBuilding[];
  scenario: Scenario;
  transit: TransitNetwork;
  citizens: Citizen[];
  metrics: Metrics;
}

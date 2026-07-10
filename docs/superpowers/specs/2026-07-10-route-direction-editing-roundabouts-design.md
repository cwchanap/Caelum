# Route Direction, Resilient Editing, and Roundabouts — Design

Date: 2026-07-10

Status: Approved in design review; pending written-spec review

## Summary

This design upgrades Caelum's road and transit model so buses understand heading,
legal turns, paired one-way lanes, and roundabouts. It also turns the existing
route-creation draft into a transactional editor for committed routes, preserves
routes when roads or transit nodes are demolished, and renders only the
unconnectable legs as dotted last-known paths.

The authoritative implementation belongs in crates/caelum-core. TypeScript owns
editing gestures, presentation state, and rendering, but it does not maintain a
second gameplay pathfinder. Browser and Tauri route previews use the same Rust
topology and route planner that committed gameplay uses.

The work is one architectural change delivered in four reviewable slices:

1. Heading-aware road topology and Rust route preview
2. Per-leg route resilience and broken-route presentation
3. Transactional committed-route editing and Loop/Shuttle service
4. Atomic 2x2 and 3x3 roundabouts plus final visual polish

## Current-state audit

The current checkout already has useful foundations:

- Rust stores one path per consecutive stop pair and recomputes paths after road,
  track, or direction changes.
- A removed road marks a route pathBroken and rebuilding connectivity restores it.
- Broken routes are excluded from trip planning, and their vehicles and riders are
  moved into a recoverable replanning state.
- Route creation supports ordered draft stops, explicit Finish, route selection,
  rename, recolor, pause, and delete.
- Roads support two-way, one-way, and dual-bidirectional straight-line presets.

The limiting behaviors are:

- Bus pathfinding is coordinate-only breadth-first search. It does not retain
  arrival heading or represent a turn as a first-class movement.
- Every orthogonally adjacent road tile is implicitly connected. Parallel lanes
  can therefore connect mid-block, while paired-lane intersections have no
  explicit lane connectors.
- A one-way road tile permits only one outgoing vector. That cannot express
  continuing around a roundabout while also allowing a legal exit.
- Route turns are only successive coordinate changes. They have no legality,
  cost, vehicle heading, or curved geometry.
- Removing a stop or station deletes every dependent route rather than preserving
  a repairable broken route.
- If any leg is broken, the renderer discards all stored leg paths and draws the
  entire route as a solid straight stop-to-stop fallback.
- Existing routes cannot edit their stop sequence or service pattern.
- The TypeScript draft pathfinder duplicates a subset of Rust routing behavior and
  can disagree with committed gameplay.

## Goals

1. Make road movement heading-aware and deterministic.
2. Automatically connect straight, left, right, and U-turn movements at valid
   junctions, including intersections between dual-bidirectional roads.
3. Add deterministic turn costs that affect both route choice and actual travel
   time.
4. Preserve route identity and player configuration through road, stop, and
   station damage.
5. Show connected legs as solid and unconnectable legs as dotted along their last
   valid alignment.
6. Add transactional editing for committed bus routes and metro lines.
7. Support Loop and Shuttle service patterns.
8. Add atomic fixed-circulation 2x2 and 3x3 roundabouts.
9. Keep gameplay topology and preview computation in Rust across browser and
   Tauri hosts.

## Non-goals

This project does not add:

- Private cars, congestion, traffic signals, lane capacity, or speed limits
- Manual lane connectors
- Manual road waypoints or locked route alignments
- Timetables, vehicle-count or frequency controls, or depot operations
- Partial service on only the connected fragment of a broken route
- Resizable or custom-shaped roundabouts
- Multi-segment or curved road-drawing gestures
- Detailed per-stop ridership or profitability analytics

The highest-value follow-up is vehicle-count and frequency management, followed
by route analytics.

## Approved product decisions

- Turns are gameplay-aware, not presentation-only.
- Ordinary junctions automatically provide legal straight, left, right, and
  U-turn movements into compatible outbound lanes.
- U-turns are allowed.
- Turn type affects route choice and actual bus travel time.
- The new road movement graph applies to buses only in this project, but its
  interfaces remain reusable for future road vehicles.
- Road changes automatically reroute a leg when another legal path exists.
- A broken leg preserves its last valid street alignment for dotted rendering.
- Demolished stops and stations remain as missing-node placeholders instead of
  deleting dependent routes.
- Rebuilding the same node kind at the same anchor automatically restores every
  matching placeholder.
- Committed routes receive a transactional Edit Route workflow.
- Routes support Loop and Shuttle patterns.
- Route-direction arrows appear only on the selected or edited route.
- A saved live-route edit takes effect immediately: vehicles move to the nearest
  retained live stop, riders disembark and replan, and service resumes when
  operational.
- Roundabouts are fixed counterclockwise for right-hand traffic.
- The road tool provides both 2x2 and 3x3 roundabout stamps.
- A roundabout may atomically replace empty tiles or an existing bare-road
  junction.

## Architecture

The runtime flow remains:

Svelte intent -> RuntimeController -> Rust backend preview or mutation ->
Rust GameEngine -> Rust snapshot -> runtime commit -> selectors and canvas render

Rust owns:

- Authored road connectivity
- Junction and roundabout structures
- The derived heading-aware movement graph
- Weighted route search and movement classification
- Route leg status and last-valid geometry
- Missing transit-node lifecycle
- Route revision validation and committed updates
- Vehicle and trip transitions after edits or network damage

TypeScript owns:

- The unsaved route-edit working copy
- Selection, insertion point, hover, and panel state
- Preview request scheduling and stale-response suppression
- Rendering Rust-provided paths, movements, warnings, and statuses

The frontend must not infer legal gameplay turns or rebuild road topology.

GameEngine owns the authoritative snapshot and a non-serialized RoadTopology
cache. The cache is built on new/reset and committed together with a candidate
snapshot after a topology-changing dispatch. Rejected dispatches change neither
one. Rust helpers that plan or advance trips receive an explicit routing context;
they do not read a global cache or reconstruct topology from the snapshot.
Route preview uses the current cache. Road-mutation preview compiles a temporary
candidate cache without committing it.

## Road topology state

### Authored tile connections

Road occupancy is no longer sufficient to imply connectivity. Each road tile
stores explicit physical connections to neighboring tile edges. Connections are
reciprocal: movement can cross a tile boundary only when both sides participate
in the authored connection.

The existing one-way attribute remains the authored travel direction for an
ordinary lane. It constrains which headings may enter and traverse that lane,
while explicit connections and junction ports determine where turning is
physically possible.

Straight road strokes author longitudinal connections along the drag axis.
Parallel lanes in the dual-bidirectional preset do not receive lateral
connections merely because they touch. This prevents mid-block lane changes.
A single-tile road placement behaves as a one-point stroke and connects only to
compatible neighboring endpoints or junction ports; the side of a parallel lane
is not an endpoint.

When road strokes meet, end, or overlap, Rust creates or refreshes an automatic
junction structure. The junction owns its footprint and boundary ports. Its
internal movements connect incoming ports to the correct compatible outbound
lanes. A simple one-tile L corner and a multi-tile crossing use the same port and
movement concepts.

Crossing construction preserves the direction and longitudinal connections of
each approach outside the generated junction. A later stroke does not overwrite
the earlier corridor's lane direction inside the overlap; the junction replaces
that overlap with ports and internal movements representing both corridors.
Removing part of the crossing regenerates or dissolves the junction from the
surviving authored approaches.

Tiles inside a road structure identify their structure owner. Internal movement
details belong to the structure and derived topology rather than being copied
onto every tile.

Direction cycling applies to ordinary lane tiles and approaches. It is rejected
on structure-owned junction or roundabout tiles with guidance to edit the
approach lane; roundabout circulation is fixed and automatic junction movements
are regenerated from their ports.

### Road structures

RoadStructure has two variants:

- Automatic junction: generated deterministically from intersecting authored
  road connections
- Roundabout: an explicitly placed 2x2 or 3x3 structure with fixed
  counterclockwise circulation

A structure records stable identity, footprint, boundary ports, and the
parameters needed to regenerate its internal movement transitions. The compiled
movement graph is derived and cached inside GameEngine; it is not serialized as a
second source of gameplay truth.

Automatic-junction identity is derived from its canonical sorted footprint and
port keys rather than allocation or discovery order. An unchanged junction
therefore keeps the same identity across topology rebuilds and provides a stable
routing tie-break.

Road mutation rebuilds only the affected topology region when practical. A full
deterministic rebuild remains the correctness fallback and is inexpensive on the
current 28x18 map.

## Heading-aware movement graph

The bus pathfinder state is a road position plus incoming heading. A transition
contains:

- Destination road position or internal structure node
- Outgoing heading
- Movement kind
- Geometry metadata for rendering
- Travel time

Movement kinds are:

- Straight
- Right turn
- Left turn
- U-turn
- Roundabout entry
- Roundabout circulation
- Roundabout exit

Ordinary automatic junctions expose straight, left, right, and U-turn
transitions whenever the outbound port accepts the resulting heading. A
transition may not enter a one-way lane against its direction. Automatic
connector selection chooses the compatible outbound lane; it never treats the
adjacent opposing lane as a mid-block connection.

Roundabouts install explicit entry, circulation, and exit transitions. Reverse
circulation is absent from the graph.

The heading-aware road graph is used only for bus legs. Metro creation, editing,
resilience, and Shuttle service use the same route-level contracts but continue
to use deterministic track pathfinding. Metro paths carry Rust-provided geometry
and travel time, but they do not receive road turn penalties or traverse
roundabouts.

### Deterministic weighted routing

Coordinate-only BFS is replaced with deterministic weighted shortest-path
routing. Base road travel time remains derived from bus speed. Initial extra
movement delays are:

| Movement | Extra delay |
| --- | ---: |
| Straight | 0.00 seconds |
| Right turn | 0.50 seconds |
| Left turn | 1.00 seconds |
| U-turn | 2.00 seconds |
| Roundabout entry | 0.75 seconds |
| Roundabout circulation/exit | 0.00 seconds beyond normal travel |

Equal-total-cost candidates use stable tie-breaking: total travel time, then
movement count, then canonical direction order, then stable structure or entity
identity. No hash iteration order, wall clock, or randomness may influence the
result.

The same transition travel times drive route-plan estimates and vehicle
movement. A bus must visibly take longer through a penalized turn; the penalty
cannot exist only in planning.

### Movement-aware paths and vehicles

A RouteLegPath contains a tagged TransitPath:

- RoadPath for buses: ordered movement-aware steps rather than only integer
  points
- TrackPath for metro: ordered track geometry, heading for presentation, and
  travel time

Each RoadPath step carries position, entering and leaving heading, movement kind,
render geometry, and travel time.

Vehicle progress is tracked at service-itinerary and path-step granularity so
turns can use their real duration and curved interpolation. The authoritative
fields are conceptually:

- Service-itinerary index
- Path step index
- Progress within the current step
- Optional out-of-service parked world position

The exact wire names may follow existing serde conventions, but a single
fraction across an entire unweighted leg is no longer sufficient.

## Rust-owned route preview

GameBackend gains a read-only previewRoute operation implemented by both WASM
and Tauri. It accepts:

- Transit mode
- Service pattern
- Ordered waypoint IDs
- Optional route ID and expected revision for committed edits
- Client draft generation token

Rust resolves nodes, builds every required directional leg, and returns:

- Per-leg connection status
- Movement-aware current and last-valid preview geometry
- Total travel time
- Authoritative initial-vehicle cost and affordability for creation
- Turn summaries
- Missing or incompatible nodes
- Typed errors and warnings
- The echoed generation token

The runtime ignores responses whose generation token is no longer current.
Save always recomputes and validates in Rust; a preview is informative, not
authorization.

Once Rust preview is available, src/ui/tilePath.ts is retired from live route
drafting. Test fixtures may keep read-only helpers, but production TypeScript
must not preserve a parallel pathfinding authority.

### Rust-owned road-mutation preview

GameBackend also gains previewRoadMutation for road strokes, direction changes,
removal gestures, and roundabout placement. The request contains the exact
prospective intent plus a client generation token. Rust returns:

- The tiles and structures that would actually change
- Authored boundary connections and generated junctions
- Authoritative cost
- Invalid or skipped stroke tiles
- Routes that would reroute or become broken
- Typed errors and warnings

The UI may compute a cheap rectangular hover footprint, but exact connections,
costs, and route impact come from Rust. Late mutation previews are ignored using
the same generation-token rule as route previews. Commit always revalidates
against current state.

## Route and transit-node model

### Present and missing nodes

Stops and stations gain a lifecycle status:

- Present: normal coverage, platform, boarding, and routing behavior
- Missing: no physical building, coverage, boarding, or routing, but stable
  identity and last position remain for route repair

Demolishing a referenced stop or station marks the shared node missing instead
of deleting it. Its kind, anchor, platform assignments, and route references are
retained. All routes sharing that node therefore see the same missing
placeholder.

Rebuilding the same logical node kind at the same canonical node anchor
reactivates the tombstone instead of allocating a new node. The compatibility
table is exact:

- Bus Stop restores Bus Stop, whether constructed by the lightweight stop tool
  or the Bus Stop building path
- Bus Terminal restores Bus Terminal only
- Metro Station restores Metro Station only

The canonical node anchor is resolved before matching, even when demolition or
placement begins from another tile in a multi-tile footprint. A retained
tombstone preserves its platforms. Placement first restores the one matching
tombstone; otherwise it allocates a new node. The state invariant permits at
most one present or missing node of a logical kind at an anchor, and ambiguous
duplicates are rejected rather than resolved by iteration order.

Every referring route is recomputed in the same transaction. A route edit can
instead replace the missing waypoint with another compatible live node.

A missing node is garbage-collected only after no route or other gameplay
reference uses it.

A missing node does not physically occupy its former tiles. Other construction
may therefore prevent exact-anchor restoration; in that case its routes remain
broken until the obstruction is removed or the placeholder is replaced through
Edit Route. An unreferenced demolished node is deleted normally and does not
create a tombstone.

### Per-leg path state

Routes and metro lines store a service pattern, revision, ordered waypoint IDs,
and directional RouteLegPath entries. Each leg records:

- From and to waypoint IDs
- Connected, network-disconnected, or missing-node status
- Current movement-aware path when connected
- Last valid movement-aware path when one has existed
- Current estimated travel time

The existing pathBroken field remains available as a derived route-level
summary while consumers migrate. A route is operational only when active is
true and every required leg is connected. Network damage never changes the
player's active choice.

### Loop and Shuttle patterns

Loop serves the ordered waypoints and adds one final directional leg from the
last waypoint to the first.

Shuttle independently computes:

- Outbound legs from first to last
- A mode-appropriate terminal reversal
- Return legs from last to first
- A mode-appropriate reversal back into the next outbound run

Return paths are not reversed copies of outbound paths. They are independently
routed so paired one-way roads and different turn costs work correctly.

For buses, a terminal reversal is a route-terminal movement that may use a
two-way road, a junction U-turn, a roundabout, or another connected return path.
It never jumps between physically unconnected parallel lanes. A one-way terminal
with no legal route to the return heading makes the Shuttle preview
network-disconnected. Metro reverses direction at the terminal station without a
road U-turn or turn delay.

The service itinerary is explicit. Loop contains its directional legs in order.
Shuttle contains outbound leg visits, the terminal reversal, inbound leg visits,
and the return reversal. Vehicles store an itinerary cursor, so an interior
Shuttle stop can be visited once in each direction without ambiguity. Transit
trip plans identify the required itinerary direction and boarding/alighting
visits; a rider boards only a vehicle whose upcoming itinerary reaches the
planned alighting visit in the correct direction.

Reverse keeps the first waypoint fixed for Loop and reverses the remaining
waypoints. For example, A-B-C becomes A-C-B. For Shuttle it reverses the complete
waypoint list, swapping the primary terminal and initial direction while
preserving service in both directions.

## Network changes and route resilience

Every topology-affecting operation uses a candidate state:

1. Validate the requested map or structure change.
2. Build the candidate authored connections and road structures.
3. Compile candidate road topology.
4. Recompute affected route legs.
5. Resolve vehicle and trip transitions.
6. Commit the candidate snapshot and topology cache together.

Atomicity is scoped by operation. UpdateRoute, a direction change, and each
roundabout placement or removal are all-or-nothing. Existing straight
road/track/remove strokes retain their established partial-stroke behavior:
valid affordable tiles are accumulated in order, while invalid tiles are
skipped. The resulting accumulated candidate and its topology are committed
together, so a stroke may be partial but can never leave snapshot and topology
out of sync.

When a changed leg has another legal path, the route automatically adopts it and
continues operating. A vehicle already travelling on that leg is projected onto
the nearest compatible point on the replacement path by squared world-space
distance, then stable path order. Its riders remain onboard because the service
is still valid. The connected replacement becomes both current and last-valid
geometry.

When no legal path exists, only that leg becomes network-disconnected. Its current
path is cleared and its last valid path is retained. Missing endpoints mark their
adjacent required legs missing-node.

If any required leg is broken, the entire route becomes temporarily
non-operational. On the transition into that state:

- Vehicles park at deterministic retained live stops.
- Riders disembark at those stops.
- Current and future trip plans using the route are invalidated.
- Trips re-enter normal replanning.

The route remains visible and retains its active setting, name, color, vehicles,
platform assignments, and edit history. Once every leg reconnects, it resumes
automatically unless the player had paused it.

Parking chooses the nearest retained live waypoint by squared world-space
distance, then waypoint order, then stable node ID. If no live waypoint remains,
the vehicle keeps an explicit out-of-service parked position at its current or
last valid world position. Riders disembark there and replan. When any waypoint
is later restored, the vehicle rebases through the normal nearest-waypoint rule.

## Transactional route editor

### Entry and working copy

The Manage panel adds Edit Route. Entering edit mode:

- Selects and highlights the route
- Captures route ID and expected revision
- Copies pattern and ordered waypoint IDs into a UI-only RouteDraft
- Leaves the committed route and service unchanged
- Requests a Rust preview after each meaningful draft change

Creation and editing share the same draft component. A creation draft has no
route ID or expected revision.

### Interactions

Edit mode provides:

- Numbered map handles and an ordered waypoint list
- Select a handle, choose Replace, then click a compatible node
- Select a handle, choose Insert after, then click a compatible node
- Append when no insertion handle is selected
- Remove
- Move up and Move down
- Reverse
- Loop and Shuttle selection
- Save and Cancel

Missing placeholders are visibly distinct and can be selected for replacement.
Escape cancels the working copy and leaves the committed route untouched.

Invalid node clicks and invalid reorder/removal outcomes return actionable
preview feedback instead of silently doing nothing.

### Validation

New routes require at least two distinct live compatible nodes and a fully
connected preview.

Every newly introduced directional leg must be connected. An edit of an already
broken route may carry forward a pre-existing missing or network-disconnected
leg only when the same from waypoint, to waypoint, and itinerary direction remain
unchanged. Save rejects any newly broken directional leg and identifies its
endpoints; there is no warning-based override.

### Save

Save sends one atomic UpdateRoute intent containing route ID, expected revision,
pattern, and waypoint IDs. Rust:

- Rejects a stale revision without changing state
- Revalidates every node and leg
- Preserves platform assignments for retained nodes
- Removes assignments from removed nodes
- Assigns added nodes to their least-loaded compatible platforms
- Rebuilds directional legs
- Increments the route revision

The revision is structural. It increments when waypoint order or service pattern
changes, a route leg path/status changes after topology mutation, a referenced
node becomes missing or present, or a platform assignment changes. Rename,
recolor, active toggle, and vehicle assignment do not increment it because
UpdateRoute does not overwrite those fields. Deletion still rejects as
route-not-found. This makes an open edit stale whenever its routing or platform
base changes without rejecting harmless presentation changes.

UpdateRoute writes only structural route fields and reads the latest name,
color, active flag, and vehicle set from the commit-time snapshot. Metadata
changes made while the editor is open are therefore preserved.

For a live route, each vehicle is moved immediately to the nearest retained live
stop by squared world-space distance, then stable stop order and node ID. Riders
disembark there and affected trip plans are invalidated. When no retained live
stop exists, the explicit out-of-service parked-position fallback applies. The
route resumes with its previous active setting when operational; a broken result
remains parked.

Cancel discards only the UI draft.

Backend failure, typed rejection, or stale revision leaves the draft intact.
The UI offers Reload from saved route for a stale revision rather than
overwriting newer state.

New-route creation uses the same editor and one atomic CreateRoute intent. Rust
validates the preview inputs and vehicle budget, stages the route, platform
assignments, initial vehicle, and budget charge in one candidate, then commits
all of them together. This replaces the current frontend two-dispatch
create-then-assign choreography and prevents a committed route with no initial
vehicle. The creation draft clears only after that atomic intent succeeds.

## Broken-route rendering and management

Rendering operates per leg:

- Connected legs draw a solid route-color stroke through current geometry.
- Road-disconnected and missing-node legs draw a dotted stroke through their
  last valid geometry.
- A leg that has never had valid geometry uses a dotted direct endpoint fallback
  when both last positions are known.
- Selected-route halos repeat the same solid/dotted split.

The dotted line therefore identifies the exact former street alignment that
needs repair. A legal automatic reroute replaces the current and last-valid path
and remains solid.

The Manage panel exposes three service states:

- Running
- Paused
- Broken

Status precedence is Broken, then Paused, then Running. A broken route whose
active flag is also false displays Broken with a secondary Paused after repair
note, preserving both facts without adding a fourth primary status.

Broken rows show the reason and affected waypoint pair, with Focus, Edit, and
repair guidance. Missing nodes and disconnected legs receive distinct map
markers.

Direction arrows appear only on the selected or edited route. They follow
movement heading through straight sections, turns, U-turns, and roundabouts.
Edit mode additionally shows numbered waypoint handles.

When multiple routes share a corridor, strokes receive small deterministic
parallel offsets derived from stable route ordering. Selected routes remain
fully saturated while unrelated routes dim slightly.

Road demolition, direction changes, and roundabout replacement previews list
routes that would become broken. The mutation still requires the player's
normal commit gesture; the warning is not a second confirmation dialog.

## Roundabout tool

The Road build menu adds:

- Compact Roundabout: 2x2
- Standard Roundabout: 3x3

Both are atomic fixed counterclockwise structures for right-hand traffic. The
cursor identifies the footprint's top-left tile. Hover preview shows the full
footprint, captured external connections, cost, validity, and affected routes.

### Geometry

The 2x2 structure uses four curved circulation tiles around their shared center.
It has no buildable center tile.

The 3x3 structure uses eight circulation tiles around one protected center
island. The island is structure-owned and unavailable for zoning, buildings,
track, or other infrastructure until the roundabout is removed.

Roundabout placement preserves any existing tile area as latent state, matching
ordinary road behavior. Structure-owned tiles cannot be painted or used by the
zoning renderer while occupied; removing the roundabout reveals the preserved
area again.

Boundary ports accept compatible incoming and outgoing road lanes. A roundabout
may connect on any side where compatible external authored connections exist.
Dual-bidirectional corridors map their inbound and outbound lanes to separate
compatible ports.

Traffic enters, pays the roundabout-entry delay, circulates counterclockwise,
and may take any compatible exit. A vehicle may continue around and exit onto
its incoming arm, providing a legal U-turn. No clockwise transition exists.

### Placement

Proposed flat costs are:

| Structure | Cost |
| --- | ---: |
| Compact 2x2 | $1,000 |
| Standard 3x3 | $2,000 |

The cost is a conversion cost. Replaced roads receive no credit or refund.

Placement may replace empty tiles and bare road tiles, including an automatic
junction. It captures every authored connection crossing the proposed footprint
boundary, even when the replaced footprint is only bare road rather than a
formal junction. It rejects the whole operation when:

- Any footprint tile is out of bounds
- A building, transit node, track, roundabout, or other non-replaceable road
  structure occupies the footprint
- The budget is insufficient
- Existing external connections cannot be mapped safely to structure ports

An automatic junction is replaceable only when its complete footprint lies
inside the new stamp. Partial overlap rejects placement. Rust removes captured
interior road connections and fully contained automatic junctions, installs the
roundabout, and reattaches compatible boundary ports in one transaction.

Roundabout prices are Rust-authoritative. Preview returns the cost used by
validation; the TypeScript catalog provides labels and tool identity but does
not duplicate gameplay cost logic.

### Removal

Clicking any roundabout-owned tile with Remove previews the complete footprint
and removes the whole structure atomically. The footprint becomes empty
infrastructure space; previously replaced road geometry is not restored.
Affected routes then reroute or become broken through the normal candidate-state
flow. A partial roundabout can never exist.

### Rendering

The map renderer uses authored connections and structure geometry to draw:

- Connected road centerlines and corners
- Junction approaches
- Curved roundabout carriageways
- The 3x3 center island
- Connection stubs and entry markings

Buses and route lines use RoadPath movement geometry, so vehicle orientation,
route curves, and direction arrows agree with the authoritative topology.

## Error handling and concurrency

Preview and mutation failures use one camelCase GameplayRejection wire shape:

- code: a stable RejectionCode enum
- context: structured optional fields such as route ID, waypoint pair,
  footprint, required/available budget, affected route IDs, and expected/actual
  revision

DispatchResult.rejection and both preview responses use this shape instead of a
free-form string. The shell maps code plus context to user-facing copy; fatal
host failures remain separate backend errors. Required rejection codes include:

- Insufficient budget
- Blocked or out-of-bounds footprint
- Unsafe roundabout port mapping
- Missing or incompatible route node
- Too few or duplicate route nodes
- Disconnected leg
- Route changed while editing
- Route or structure no longer exists

Rejected atomic operations never mutate GameSnapshot. A bulk stroke that applies
at least one valid tile succeeds with its documented applied subset and reports
skipped tiles in preview/result context; it is not treated as a partially
committed rejection. Recoverable rejection does not stop the runtime and does
not clear the route draft.

Each preview carries a monotonically increasing draft generation. The runtime
ignores late preview results. UpdateRoute also carries expected revision, so
preview ordering cannot authorize a stale save.

## Compatibility and migration

This is a strict authoritative-schema cutover. Caelum currently exposes new and
reset but no persisted GameSnapshot load API, and the old tile shape does not
contain enough stroke or lane provenance to reconstruct connections without
guessing. This design therefore does not promise ambiguous legacy-snapshot
inference.

- Rust scenario construction authors explicit road connections and structures.
- Reset rebuilds snapshot and topology cache from that authored scenario.
- A snapshot schema version lets both hosts assert the expected wire contract.
- Rust and TypeScript wire types change in the same slice.
- Test fixtures move to explicit upgraded builders; production TypeScript does
  not synthesize road topology.
- During the per-leg transition, a non-empty old segment may seed current and
  last-valid geometry. An empty old segment seeds network-disconnected with no
  last-valid geometry, so its renderer uses the documented direct dotted
  fallback until a valid path is found.
- Loop is the default pattern and structural revision starts at zero for
  fixtures created through the upgraded builders.

If persisted save loading is added later, migration from pre-topology snapshots
requires a separate explicit product decision rather than heuristic lane
inference.

The WASM and Tauri wire types change together. Model wire-format tests enumerate
all new intent, preview, movement, route-leg, node-status, and road-structure
shapes.

## Testing strategy

### Rust topology and routing

- Straight, left, right, and U-turn classification
- Correct outbound-lane selection at L, T, and cross junctions
- Turns between two dual-bidirectional corridors
- No lateral mid-block connection between adjacent lanes
- Rejection of wrong-way lane entry
- Turn penalties alter chosen paths and reported travel time
- Actual vehicle timing matches path travel time
- Stable equal-cost tie-breaking
- Automatic junction creation and dissolution
- Snapshot/topology cache parity after new, reset, accepted dispatch, rejected
  dispatch, route preview, and mutation preview
- Existing partial-stroke skip semantics with a topology-consistent final
  candidate

### Rust route lifecycle

- Loop closing direction
- Independently routed Shuttle outbound and return legs
- Bus terminal U-turns and metro terminal reversals
- Shuttle itinerary cursor and repeated interior-stop visits
- Direction-aware planning, boarding, and alighting on Shuttle service
- Automatic alternate-path rerouting
- Vehicle projection onto a replacement path
- Broken-leg last-valid geometry retention
- Route-level operational state with active preserved
- Passenger disembark and trip invalidation on break
- Missing-node tombstone creation and shared-route behavior
- Exact-anchor node restoration
- Logical-kind compatibility across direct and building-backed construction paths
- Multi-tile demolition anchor resolution and duplicate-anchor rejection
- Tombstone garbage collection
- Atomic UpdateRoute, platform reassignment, vehicle rebasing, and revision
  rejection

### Rust roundabouts

- Atomic 2x2 and 3x3 placement
- Bounds, occupancy, track, structure, port, and budget rejection
- Replacement of bare-road junctions
- Every compatible entry and exit
- Fixed counterclockwise circulation
- Roundabout U-turn
- Whole-structure removal
- Route reroute, break, and repair after placement or removal

### Host and runtime

- WASM and Tauri preview parity
- Preview generation and stale-response suppression
- Road-mutation preview generation, authoritative costs, and route-impact parity
- Save and Cancel
- Stale expected revision
- Draft preservation after rejection
- Atomic route creation with initial vehicle and budget charge
- Backend wire-format coverage
- Structured rejection codes and context across dispatch and preview responses

### UI and rendering

- Route insertion, replacement, removal, reorder, Reverse, Loop, and Shuttle
- Missing-node and failed-leg feedback
- Running, Paused, and Broken management states
- Curved route turns and vehicle heading
- Selected-route direction arrows
- Solid versus dotted per-leg strokes and halos
- Last-valid dotted alignment
- Deterministic shared-corridor offsets
- Demolition impact warnings
- 2x2 and 3x3 previews and committed roundabout rendering

### End-to-end

At minimum:

1. Build intersecting dual-bidirectional roads, create a route that turns
   between them, edit it, and verify correct direction cues.
2. Remove a used road, observe alternate rerouting or a dotted broken leg, then
   repair it and observe service resume.
3. Demolish a station, observe its missing placeholder and broken legs, rebuild
   it at the same anchor, and observe automatic repair.
4. Place and use both roundabout sizes, including a U-turn exit, then demolish
   one and verify atomic route recomputation.

### Verification commands

The final verification ladder is:

- rtk bun run check
- rtk bun run lint
- rtk bun run format:check
- rtk cargo test --workspace
- rtk cargo clippy --workspace --all-targets -- -D warnings
- rtk bun run test
- rtk bun run build
- rtk bun run test:e2e

Focused tests should run within each delivery slice before the full ladder.

## Delivery slices

### Slice 1: topology and preview

- Authored road connections and automatic junction structures
- Heading-aware deterministic weighted routing
- Movement-aware vehicle path progress
- Rust preview across WASM and Tauri
- Retirement of production TypeScript route pathfinding

### Slice 2: resilience

- Per-leg current and last-valid paths
- Missing transit-node tombstones
- Alternate rerouting and vehicle projection
- Broken transition and automatic restoration
- Solid/dotted rendering and management status

### Slice 3: route editor

- Shared creation/edit RouteDraft
- Map/list editing interactions
- Loop and Shuttle
- Route revision and atomic UpdateRoute
- Vehicle rebasing, platform reassignment, and actionable failures

### Slice 4: roundabouts and polish

- 2x2 and 3x3 road-tool stamps
- Port capture and fixed circulation
- Atomic replacement and demolition
- Structure rendering, direction cues, shared-corridor offsets, and impact
  warnings

Each slice must leave browser and Tauri hosts on the same Rust contract. No slice
may introduce a temporary TypeScript gameplay authority.

## Expected affected areas

Rust:

- crates/caelum-core/src/model.rs
- crates/caelum-core/src/network.rs or focused road-topology modules
- crates/caelum-core/src/transit.rs
- crates/caelum-core/src/router.rs
- crates/caelum-core/src/trips.rs
- crates/caelum-core/src/intent.rs
- crates/caelum-core/src/engine.rs
- crates/caelum-core tests and golden/wire-format coverage
- crates/caelum-wasm host surface
- src-tauri command surface

Frontend:

- src/domain/types.ts
- src/runtime/backend types and both adapters
- src/runtime/createGameRuntime.ts
- src/runtime/types.ts and runtimeSelectors.ts
- src/ui/uiState.ts and route-draft helpers
- src/components/hud/panels/RoutesPanel.svelte
- src/components/hud/panels/ManagePanel.svelte
- src/render/mapRenderer.ts
- src/render/transitRenderer.ts
- src/render/overlayRenderer.ts
- Road and route catalogs
- Runtime, UI, render, and end-to-end tests
- docs/architecture.md and repository architecture guidance

Implementation may split files further to keep topology compilation, route
preview, route lifecycle, and road structures independently understandable.
Unrelated refactoring is out of scope.

## Acceptance criteria

The design is complete when all of the following are true:

1. A bus route can turn automatically between paired dual-bidirectional roads
   and enters the correct outbound lane.
2. Straight, left, right, U-turn, and roundabout movements are distinguishable,
   deterministic, visibly curved, and reflected in actual travel time.
3. Route drafts and committed gameplay use the same Rust preview/path logic.
4. Road damage automatically reroutes when possible; otherwise only failed legs
   become dotted along their last valid alignment.
5. Demolishing a referenced stop or station preserves a missing placeholder and
   route identity.
6. Rebuilding the same node kind at the same anchor automatically repairs every
   affected route.
7. Existing routes can be edited transactionally with add, replace, remove,
   reorder, Reverse, Loop/Shuttle, Save, and Cancel; new routes create their
   initial vehicle atomically.
8. Saving a live route rebases vehicles and replans riders deterministically.
9. Both 2x2 and 3x3 roundabouts place, route, render, and remove atomically with
   fixed counterclockwise circulation and legal U-turn exits.
10. Browser and Tauri behavior remain contract-identical, deterministic, and
    fully covered by the verification ladder.

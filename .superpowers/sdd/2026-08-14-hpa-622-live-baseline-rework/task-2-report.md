# HPA-622 Task 2 report

## Status

Complete. This slice adds topology-valid natural mode-choice coverage, explicit RoadFlow boundary arithmetic, staggered car-arrival determinism coverage, and the requested architecture contract wording. No production Rust correction was needed: the focused acceptance coverage passed against the Task 1 API after test-fixture/assertion corrections.

## Commit SHA(s)

- `1183853b9498d21fb31a701666e79f1db7973df4` — implementation, focused acceptance coverage, architecture note, and this report.
- A follow-up report-only commit records this SHA in the committed report; its SHA is supplied in the handoff.

## Changed files

- `crates/caelum-core/tests/router_planning.rs`
  - Blank-grid, compiled-topology fixtures for short walk, long car, direct bus, and detouring bus costs.
  - Assertions use `find_route_plan`, `private_car_candidate`, actual route `RoadPathStep.travel_seconds`, and relative mode/cost results.
- `crates/caelum-core/tests/trip_lifecycle.rs`
  - Same-time admitted-flow assertion.
  - Exact scheduled-departure 4 -> 5 flow/multiplier/duration/current-step remainder proof.
  - Pre-arrival and post-arrival flow/timing assertions.
  - Five staggered valid frozen-car arrivals with coarse/split equality.
- `docs/architecture.md`
  - Documents the fixed access cost, shared walking cost, ephemeral borrowed RoadFlow boundary, frozen car timestamps, bus fractional progress, structural route paths, and current-road UI overlay.
- No production files were changed. The Task 1 public API was preserved.

## Required fixture inventory

Command run exactly as requested:

```sh
rtk proxy rg -n 'tick_trips|tick\(|CommuteOutbound|CommuteReturn|completed_trips|late_trips|unserved_trips|average_wait|outbound_arrived_today|returned_home_today' \
  crates/caelum-core/tests/golden_sequences.rs \
  crates/caelum-core/tests/commute_requirements.rs \
  crates/caelum-core/tests/population.rs \
  crates/caelum-core/tests/objectives_metrics.rs \
  crates/caelum-core/tests/trip_lifecycle.rs
```

Exact output:

```text
crates/caelum-core/tests/objectives_metrics.rs:19:    let result = engine.tick(1_201.0);
crates/caelum-core/tests/objectives_metrics.rs:28:    state.metrics.completed_trips = 1;
crates/caelum-core/tests/objectives_metrics.rs:39:    below_gate.metrics.unserved_trips = 9;
crates/caelum-core/tests/objectives_metrics.rs:46:    unserved.metrics.completed_trips = 7;
crates/caelum-core/tests/objectives_metrics.rs:47:    unserved.metrics.unserved_trips = 3;
crates/caelum-core/tests/objectives_metrics.rs:56:    late.metrics.completed_trips = 10;
crates/caelum-core/tests/objectives_metrics.rs:57:    late.metrics.late_trips = 3;
crates/caelum-core/tests/objectives_metrics.rs:67:fn average_wait_loss_requires_waiting_trips() {
crates/caelum-core/tests/objectives_metrics.rs:69:    no_waiters.metrics.average_wait_seconds = 181.0;
crates/caelum-core/tests/objectives_metrics.rs:90:    state.metrics.completed_trips = 20;
crates/caelum-core/tests/objectives_metrics.rs:91:    state.metrics.late_trips = 8;
crates/caelum-core/tests/objectives_metrics.rs:119:    state.metrics.unserved_trips = 10;
crates/caelum-core/tests/objectives_metrics.rs:137:    won.metrics.completed_trips = 10;
crates/caelum-core/tests/objectives_metrics.rs:138:    won.metrics.late_trips = 10;
crates/caelum-core/tests/objectives_metrics.rs:144:    lost.metrics.completed_trips = 1;
crates/caelum-core/tests/objectives_metrics.rs:153:    snapshot.metrics.completed_trips = 1;
crates/caelum-core/tests/objectives_metrics.rs:156:    let result = engine.tick(1_201.0);
crates/caelum-core/tests/objectives_metrics.rs:166:    state.metrics.completed_trips = 7;
crates/caelum-core/tests/objectives_metrics.rs:167:    state.metrics.unserved_trips = 3;
crates/caelum-core/tests/objectives_metrics.rs:178:    state.metrics.completed_trips = 10;
crates/caelum-core/tests/objectives_metrics.rs:179:    state.metrics.late_trips = 3;
crates/caelum-core/tests/objectives_metrics.rs:198:    state.metrics.completed_trips = 100;
crates/caelum-core/tests/objectives_metrics.rs:199:    state.metrics.unserved_trips = 10;
crates/caelum-core/tests/golden_sequences.rs:15:fn tick_trips(state: &GameSnapshot, topology: &RoadTopology, delta_seconds: f64) -> GameSnapshot {
crates/caelum-core/tests/golden_sequences.rs:16:    trips::tick_trips(state, topology, delta_seconds)
crates/caelum-core/tests/golden_sequences.rs:98:    engine.tick(500.0);
crates/caelum-core/tests/golden_sequences.rs:115:    let result = engine.tick(900.0);
crates/caelum-core/tests/golden_sequences.rs:123:    assert_eq!(snapshot.metrics.completed_trips, 6);
crates/caelum-core/tests/golden_sequences.rs:124:    assert_eq!(snapshot.metrics.late_trips, 0);
crates/caelum-core/tests/golden_sequences.rs:125:    assert_eq!(snapshot.metrics.unserved_trips, 0);
crates/caelum-core/tests/golden_sequences.rs:140:    let large_snapshot = large.tick(900.0).snapshot;
crates/caelum-core/tests/golden_sequences.rs:142:    let mut stepped_snapshot = stepped.tick(0.0).snapshot;
crates/caelum-core/tests/golden_sequences.rs:144:        stepped_snapshot = stepped.tick(1.0).snapshot;
crates/caelum-core/tests/golden_sequences.rs:148:        stepped_snapshot.metrics.completed_trips,
crates/caelum-core/tests/golden_sequences.rs:149:        large_snapshot.metrics.completed_trips
crates/caelum-core/tests/golden_sequences.rs:152:        stepped_snapshot.metrics.late_trips,
crates/caelum-core/tests/golden_sequences.rs:153:        large_snapshot.metrics.late_trips
crates/caelum-core/tests/golden_sequences.rs:156:        stepped_snapshot.metrics.unserved_trips,
crates/caelum-core/tests/golden_sequences.rs:157:        large_snapshot.metrics.unserved_trips
crates/caelum-core/tests/golden_sequences.rs:167:    let result = engine.tick(clock::GAME_DAY_SECONDS + 1.0);
crates/caelum-core/tests/golden_sequences.rs:171:    assert!(result.snapshot.metrics.completed_trips > 0);
crates/caelum-core/tests/golden_sequences.rs:179:    let mut snapshot = engine.tick(clock::GAME_DAY_SECONDS - 1.0).snapshot;
crates/caelum-core/tests/golden_sequences.rs:188:    snapshot = tick_trips(&snapshot, &topology, 400.0);
crates/caelum-core/tests/golden_sequences.rs:195:            && !sim.outbound_arrived_today
crates/caelum-core/tests/golden_sequences.rs:260:    let advanced = tick_trips(&state, &topology, delta);
crates/caelum-core/tests/golden_sequences.rs:274:fn short_metro_segment_large_tick_matches_stepped_tick() {
crates/caelum-core/tests/golden_sequences.rs:301:    let large = tick_trips(&start, &topology, 200.0);
crates/caelum-core/tests/golden_sequences.rs:305:        stepped = tick_trips(&stepped, &topology, 1.0);
crates/caelum-core/tests/golden_sequences.rs:335:/// it directly through `tick_trips`.
crates/caelum-core/tests/golden_sequences.rs:398:fn roundabout_bus_large_tick_matches_stepped_tick() {
crates/caelum-core/tests/golden_sequences.rs:401:    let large = tick_trips(&start, &topology, 200.0);
crates/caelum-core/tests/golden_sequences.rs:405:        stepped = tick_trips(&stepped, &topology, 1.0);
crates/caelum-core/tests/golden_sequences.rs:436:    let after = tick_trips(&state, &topology, 120.0);
crates/caelum-core/tests/commute_requirements.rs:131:    let result = engine.tick(360.0);
crates/caelum-core/tests/commute_requirements.rs:137:        .any(|trip| { trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteOutbound }));
crates/caelum-core/tests/commute_requirements.rs:146:    let result = engine.tick(360.0);
crates/caelum-core/tests/commute_requirements.rs:151:        .find(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteOutbound)
crates/caelum-core/tests/commute_requirements.rs:166:    let result = engine.tick(scheduled);
crates/caelum-core/tests/commute_requirements.rs:171:        .find(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteOutbound)
crates/caelum-core/tests/commute_requirements.rs:181:fn large_tick_stops_at_return_boundary_after_outbound_arrives_same_tick() {
crates/caelum-core/tests/commute_requirements.rs:187:    let result = engine.tick(scheduled_return + post_return_elapsed);
crates/caelum-core/tests/commute_requirements.rs:192:        .find(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteReturn)
crates/caelum-core/tests/commute_requirements.rs:211:    let large_result = large_tick.tick(final_time);
crates/caelum-core/tests/commute_requirements.rs:212:    let after_return_boundary = stepped_tick.tick(return_time);
crates/caelum-core/tests/commute_requirements.rs:217:        .any(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteReturn));
crates/caelum-core/tests/commute_requirements.rs:224:            .any(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteReturn)
crates/caelum-core/tests/commute_requirements.rs:226:        stepped_snapshot = stepped_tick.tick(1.0).snapshot;
crates/caelum-core/tests/commute_requirements.rs:230:    let stepped_result = stepped_tick.tick(final_time - stepped_snapshot.time);
crates/caelum-core/tests/commute_requirements.rs:235:        .find(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteReturn)
crates/caelum-core/tests/commute_requirements.rs:241:        .find(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteReturn)
crates/caelum-core/tests/commute_requirements.rs:265:    let evening = engine.tick(900.0);
crates/caelum-core/tests/commute_requirements.rs:268:    assert_eq!(evening.snapshot.metrics.unserved_trips, 0);
crates/caelum-core/tests/commute_requirements.rs:298:    engine.tick(past_departure);
crates/caelum-core/tests/commute_requirements.rs:307:    assert_eq!(before_destination.metrics.unserved_trips, 0);
crates/caelum-core/tests/commute_requirements.rs:324:    engine.tick(60.0);
crates/caelum-core/tests/commute_requirements.rs:331:            .any(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteOutbound),
crates/caelum-core/tests/commute_requirements.rs:334:    assert_eq!(after.metrics.unserved_trips, 0);
crates/caelum-core/tests/commute_requirements.rs:335:    assert_eq!(after.metrics.late_trips, 0);
crates/caelum-core/tests/commute_requirements.rs:360:    engine.tick(day0_scheduled + 50.0);
crates/caelum-core/tests/commute_requirements.rs:374:    engine.tick(60.0);
crates/caelum-core/tests/commute_requirements.rs:379:        .any(|trip| { trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteOutbound }));
crates/caelum-core/tests/commute_requirements.rs:386:    engine.tick(elapsed_since_last);
crates/caelum-core/tests/commute_requirements.rs:393:            .any(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteOutbound),
crates/caelum-core/tests/commute_requirements.rs:399:        .find(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteOutbound)
crates/caelum-core/tests/population.rs:119:    let filled = engine.tick(600.0).snapshot;
crates/caelum-core/tests/population.rs:216:    let filled = engine.tick(600.0).snapshot;
crates/caelum-core/tests/population.rs:340:    let snapshot = engine.tick(600.0).snapshot;
crates/caelum-core/tests/population.rs:391:    let snapshot = engine.tick(600.0).snapshot;
crates/caelum-core/tests/population.rs:416:fn sandbox_move_ins_start_on_first_running_tick() {
crates/caelum-core/tests/population.rs:427:    let first_tick = engine.tick(1.0);
crates/caelum-core/tests/population.rs:445:    let coarse_snapshot = coarse.tick(150.0).snapshot;
crates/caelum-core/tests/population.rs:446:    let _ = fine.tick(50.0);
crates/caelum-core/tests/population.rs:447:    let _ = fine.tick(50.0);
crates/caelum-core/tests/population.rs:448:    let fine_snapshot = fine.tick(50.0).snapshot;
crates/caelum-core/tests/population.rs:459:    let coarse_snapshot = coarse.tick(900.0).snapshot;
crates/caelum-core/tests/population.rs:460:    let mut fine_snapshot = fine.tick(0.0).snapshot;
crates/caelum-core/tests/population.rs:462:        fine_snapshot = fine.tick(50.0).snapshot;
crates/caelum-core/tests/population.rs:472:            coarse_snapshot.metrics.completed_trips,
crates/caelum-core/tests/population.rs:473:            coarse_snapshot.metrics.late_trips,
crates/caelum-core/tests/population.rs:474:            coarse_snapshot.metrics.unserved_trips,
crates/caelum-core/tests/population.rs:477:            fine_snapshot.metrics.completed_trips,
crates/caelum-core/tests/population.rs:478:            fine_snapshot.metrics.late_trips,
crates/caelum-core/tests/population.rs:479:            fine_snapshot.metrics.unserved_trips,
crates/caelum-core/tests/population.rs:507:    let filled = engine.tick(600.0).snapshot;
crates/caelum-core/tests/population.rs:510:    let later = engine.tick(600.0).snapshot;
crates/caelum-core/tests/population.rs:525:    assert!(engine.tick(after_departure).applied);
crates/caelum-core/tests/population.rs:567:    let due = engine.tick(0.0).snapshot;
crates/caelum-core/tests/population.rs:570:        !(trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteOutbound)
crates/caelum-core/tests/population.rs:575:    let next_day = engine.tick(until_next_departure).snapshot;
crates/caelum-core/tests/population.rs:579:        .any(|trip| { trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteOutbound }));
crates/caelum-core/tests/population.rs:593:    assert!(engine.tick(scheduled).applied);
crates/caelum-core/tests/population.rs:632:    let due = engine.tick(0.0).snapshot;
crates/caelum-core/tests/population.rs:639:    assert!(!sim.outbound_arrived_today);
crates/caelum-core/tests/population.rs:642:            && trip.purpose == TripPurpose::CommuteOutbound
crates/caelum-core/tests/trip_lifecycle.rs:26:        outbound_arrived_today: false,
crates/caelum-core/tests/trip_lifecycle.rs:28:        returned_home_today: false,
crates/caelum-core/tests/trip_lifecycle.rs:36:        purpose: TripPurpose::CommuteOutbound,
crates/caelum-core/tests/trip_lifecycle.rs:326:            purpose: TripPurpose::CommuteOutbound,
crates/caelum-core/tests/trip_lifecycle.rs:372:        purpose: TripPurpose::CommuteOutbound,
crates/caelum-core/tests/trip_lifecycle.rs:414:            purpose: TripPurpose::CommuteOutbound,
crates/caelum-core/tests/trip_lifecycle.rs:436:        purpose: TripPurpose::CommuteOutbound,
crates/caelum-core/tests/trip_lifecycle.rs:449:fn tick_trips(state: &GameSnapshot, topology: &RoadTopology, delta_seconds: f64) -> GameSnapshot {
crates/caelum-core/tests/trip_lifecycle.rs:450:    trips::tick_trips(state, topology, delta_seconds)
crates/caelum-core/tests/trip_lifecycle.rs:453:fn tick_trips_with_objectives(
crates/caelum-core/tests/trip_lifecycle.rs:458:    trips::tick_trips_with_objectives(state, topology, delta_seconds)
crates/caelum-core/tests/trip_lifecycle.rs:465:    let next = tick_trips(&state, &topology, 0.0);
crates/caelum-core/tests/trip_lifecycle.rs:480:    let next = tick_trips(&state, &topology, 0.0);
crates/caelum-core/tests/trip_lifecycle.rs:487:    let walking = tick_trips(&next, &topology, 1.0);
crates/caelum-core/tests/trip_lifecycle.rs:514:            purpose: TripPurpose::CommuteOutbound,
crates/caelum-core/tests/trip_lifecycle.rs:530:    let next = tick_trips(&state, &topology, 0.0);
crates/caelum-core/tests/trip_lifecycle.rs:609:    let coarse = tick_trips(&state, &topology, 3.0);
crates/caelum-core/tests/trip_lifecycle.rs:613:        fine = tick_trips(&fine, &topology, 1.0);
crates/caelum-core/tests/trip_lifecycle.rs:630:    let coarse = tick_trips(&state, &topology, total_delta);
crates/caelum-core/tests/trip_lifecycle.rs:631:    let at_departure = tick_trips(&state, &topology, departure_delta);
crates/caelum-core/tests/trip_lifecycle.rs:641:    let split = tick_trips(&at_departure, &topology, total_delta - departure_delta);
crates/caelum-core/tests/trip_lifecycle.rs:663:    let spawned = tick_trips(&state, &topology, 0.0);
crates/caelum-core/tests/trip_lifecycle.rs:712:    let at_arrival = tick_trips(&state, &topology, 1.25);
crates/caelum-core/tests/trip_lifecycle.rs:725:    assert_eq!(at_arrival.metrics.completed_trips, 1);
crates/caelum-core/tests/trip_lifecycle.rs:738:    let coarse = tick_trips(&state, &topology, 1.5);
crates/caelum-core/tests/trip_lifecycle.rs:739:    let split = tick_trips(&at_arrival, &topology, 0.25);
crates/caelum-core/tests/trip_lifecycle.rs:743:        coarse.metrics.completed_trips,
crates/caelum-core/tests/trip_lifecycle.rs:744:        split.metrics.completed_trips
crates/caelum-core/tests/trip_lifecycle.rs:751:    let coarse = tick_trips(&state, &topology, 3.0);
crates/caelum-core/tests/trip_lifecycle.rs:755:        split = tick_trips(&split, &topology, 0.5);
crates/caelum-core/tests/trip_lifecycle.rs:764:    assert_eq!(coarse.metrics.completed_trips, 5);
crates/caelum-core/tests/trip_lifecycle.rs:771:    let spawned = tick_trips(&state, &topology, 0.0);
crates/caelum-core/tests/trip_lifecycle.rs:782:    let before_arrival = tick_trips(&spawned, &topology, 1.0);
crates/caelum-core/tests/trip_lifecycle.rs:789:    let arrived = tick_trips(&spawned, &topology, (arrival_time - spawned.time).max(0.0));
crates/caelum-core/tests/trip_lifecycle.rs:791:    assert_eq!(arrived.metrics.completed_trips, 1);
crates/caelum-core/tests/trip_lifecycle.rs:798:    let coarse = tick_trips(&state, &topology, 12.0);
crates/caelum-core/tests/trip_lifecycle.rs:802:        fine = tick_trips(&fine, &topology, 1.0);
crates/caelum-core/tests/trip_lifecycle.rs:808:    assert_eq!(coarse.metrics.completed_trips, fine.metrics.completed_trips);
crates/caelum-core/tests/trip_lifecycle.rs:809:    assert_eq!(coarse.metrics.late_trips, fine.metrics.late_trips);
crates/caelum-core/tests/trip_lifecycle.rs:810:    assert_eq!(coarse.metrics.unserved_trips, fine.metrics.unserved_trips);
crates/caelum-core/tests/trip_lifecycle.rs:821:    assert_eq!(next.metrics.unserved_trips, 1);
crates/caelum-core/tests/trip_lifecycle.rs:852:    assert_eq!(next.metrics.completed_trips, 0);
crates/caelum-core/tests/trip_lifecycle.rs:859:        state.metrics.completed_trips = 11;
crates/caelum-core/tests/trip_lifecycle.rs:860:        state.metrics.late_trips = 3;
crates/caelum-core/tests/trip_lifecycle.rs:861:        state.metrics.unserved_trips = 5;
crates/caelum-core/tests/trip_lifecycle.rs:870:        assert_eq!(next.metrics.completed_trips, state.metrics.completed_trips);
crates/caelum-core/tests/trip_lifecycle.rs:871:        assert_eq!(next.metrics.late_trips, state.metrics.late_trips);
crates/caelum-core/tests/trip_lifecycle.rs:872:        assert_eq!(next.metrics.unserved_trips, state.metrics.unserved_trips);
crates/caelum-core/tests/trip_lifecycle.rs:1013:    assert_eq!(next.metrics.unserved_trips, 1);
crates/caelum-core/tests/trip_lifecycle.rs:1016:    assert_eq!(next.metrics.average_wait_seconds, 0.0);
crates/caelum-core/tests/trip_lifecycle.rs:1041:    assert_eq!(arrived.metrics.completed_trips, 1);
crates/caelum-core/tests/trip_lifecycle.rs:1042:    assert_eq!(arrived.metrics.late_trips, 0);
crates/caelum-core/tests/trip_lifecycle.rs:1076:    assert_eq!(late_next.metrics.completed_trips, 1);
crates/caelum-core/tests/trip_lifecycle.rs:1077:    assert_eq!(late_next.metrics.late_trips, 1);
crates/caelum-core/tests/trip_lifecycle.rs:1113:    assert_eq!(next.metrics.completed_trips, 0);
crates/caelum-core/tests/trip_lifecycle.rs:1114:    assert_eq!(next.metrics.unserved_trips, 1);
crates/caelum-core/tests/trip_lifecycle.rs:1134:    assert_eq!(next.metrics.unserved_trips, 1);
crates/caelum-core/tests/trip_lifecycle.rs:1146:fn waiting_timeout_outcome_uses_exact_time_under_large_tick() {
crates/caelum-core/tests/trip_lifecycle.rs:1163:    let next = tick_trips(&state, &topology, 100.0);
crates/caelum-core/tests/trip_lifecycle.rs:1166:    assert_eq!(next.metrics.unserved_trips, 1);
crates/caelum-core/tests/trip_lifecycle.rs:1181:    state.metrics.unserved_trips = 10;
crates/caelum-core/tests/trip_lifecycle.rs:1225:        purpose: TripPurpose::CommuteOutbound,
crates/caelum-core/tests/trip_lifecycle.rs:1239:    let coarse = tick_trips(&state, &topology, 12.5);
crates/caelum-core/tests/trip_lifecycle.rs:1242:        next = tick_trips(&next, &topology, 1.25);
crates/caelum-core/tests/trip_lifecycle.rs:1246:    assert_eq!(next.metrics.completed_trips, 1);
crates/caelum-core/tests/trip_lifecycle.rs:1256:    assert_eq!(coarse.metrics.completed_trips, next.metrics.completed_trips);
crates/caelum-core/tests/trip_lifecycle.rs:1296:        purpose: TripPurpose::CommuteOutbound,
crates/caelum-core/tests/trip_lifecycle.rs:1315:    let coarse_disembarked = tick_trips(&state, &topology, 12.5);
crates/caelum-core/tests/trip_lifecycle.rs:1318:        disembarked = tick_trips(&disembarked, &topology, 1.25);
crates/caelum-core/tests/trip_lifecycle.rs:1325:    assert_eq!(disembarked.metrics.completed_trips, 0);
crates/caelum-core/tests/trip_lifecycle.rs:1334:        coarse_disembarked.metrics.completed_trips,
crates/caelum-core/tests/trip_lifecycle.rs:1335:        disembarked.metrics.completed_trips
crates/caelum-core/tests/trip_lifecycle.rs:1338:    let arrived = tick_trips(&disembarked, &topology, 20.0);
crates/caelum-core/tests/trip_lifecycle.rs:1341:    assert_eq!(arrived.metrics.completed_trips, 1);
crates/caelum-core/tests/trip_lifecycle.rs:1378:        purpose: TripPurpose::CommuteOutbound,
crates/caelum-core/tests/trip_lifecycle.rs:1399:    let coarse_disembarked = tick_trips(&state, &topology, 12.5);
crates/caelum-core/tests/trip_lifecycle.rs:1402:        disembarked = tick_trips(&disembarked, &topology, 1.25);
crates/caelum-core/tests/trip_lifecycle.rs:1409:    assert_eq!(disembarked.metrics.completed_trips, 0);
crates/caelum-core/tests/trip_lifecycle.rs:1418:        coarse_disembarked.metrics.completed_trips,
crates/caelum-core/tests/trip_lifecycle.rs:1419:        disembarked.metrics.completed_trips
crates/caelum-core/tests/trip_lifecycle.rs:1422:    let arrived = tick_trips(&disembarked, &topology, 20.0);
crates/caelum-core/tests/trip_lifecycle.rs:1425:    assert_eq!(arrived.metrics.completed_trips, 1);
crates/caelum-core/tests/trip_lifecycle.rs:1460:        purpose: TripPurpose::CommuteOutbound,
crates/caelum-core/tests/trip_lifecycle.rs:1480:    let next = tick_trips(&state, &topology, seconds);
crates/caelum-core/tests/trip_lifecycle.rs:1486:    assert_eq!(next.metrics.completed_trips, 1);
crates/caelum-core/tests/trip_lifecycle.rs:1515:        purpose: TripPurpose::CommuteOutbound,
crates/caelum-core/tests/trip_lifecycle.rs:1553:        outbound_arrived_today: false,
crates/caelum-core/tests/trip_lifecycle.rs:1555:        returned_home_today: false,
crates/caelum-core/tests/trip_lifecycle.rs:1560:        purpose: TripPurpose::CommuteOutbound,
crates/caelum-core/tests/trip_lifecycle.rs:1577:    assert!(!sim.outbound_arrived_today);
crates/caelum-core/tests/trip_lifecycle.rs:1590:    let ticked = tick_trips(&after_return_window, &topology, 0.0);
crates/caelum-core/tests/trip_lifecycle.rs:1595:        .any(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteReturn));
crates/caelum-core/tests/trip_lifecycle.rs:1617:        outbound_arrived_today: true,
crates/caelum-core/tests/trip_lifecycle.rs:1619:        returned_home_today: false,
crates/caelum-core/tests/trip_lifecycle.rs:1623:    let arrived = tick_trips(&state, &topology, 20.0);
crates/caelum-core/tests/trip_lifecycle.rs:1627:    assert_eq!(arrived.metrics.completed_trips, 1);
crates/caelum-core/tests/trip_lifecycle.rs:1630:    assert!(sim.returned_home_today);
crates/caelum-core/tests/trip_lifecycle.rs:1632:    let ticked_again = tick_trips(&arrived, &topology, 0.0);
crates/caelum-core/tests/trip_lifecycle.rs:1635:    assert_eq!(ticked_again.metrics.completed_trips, 1);
crates/caelum-core/tests/trip_lifecycle.rs:1655:        purpose: TripPurpose::CommuteOutbound,
crates/caelum-core/tests/trip_lifecycle.rs:1672:    let next = tick_trips(&state, &topology, 2.0);
crates/caelum-core/tests/trip_lifecycle.rs:1676:    assert_eq!(next.metrics.unserved_trips, 1);
crates/caelum-core/tests/trip_lifecycle.rs:1679:    assert!(!sim.outbound_arrived_today);
crates/caelum-core/tests/trip_lifecycle.rs:1703:        outbound_arrived_today: true,
crates/caelum-core/tests/trip_lifecycle.rs:1705:        returned_home_today: false,
crates/caelum-core/tests/trip_lifecycle.rs:1710:        purpose: TripPurpose::CommuteReturn,
crates/caelum-core/tests/trip_lifecycle.rs:1723:    let next = tick_trips(&state, &topology, 2.0);
crates/caelum-core/tests/trip_lifecycle.rs:1727:    assert_eq!(next.metrics.unserved_trips, 1);
crates/caelum-core/tests/trip_lifecycle.rs:1730:    assert!(!sim.returned_home_today);
crates/caelum-core/tests/trip_lifecycle.rs:1741:    // `tick_trip` immediately scores as arrived — inflating `completed_trips`
crates/caelum-core/tests/trip_lifecycle.rs:1768:        outbound_arrived_today: true,
crates/caelum-core/tests/trip_lifecycle.rs:1770:        returned_home_today: false,
crates/caelum-core/tests/trip_lifecycle.rs:1775:    let next = tick_trips(&state, &topology, 1.0);
crates/caelum-core/tests/trip_lifecycle.rs:1782:            .any(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteOutbound),
crates/caelum-core/tests/trip_lifecycle.rs:1786:        next.metrics.completed_trips, 0,
crates/caelum-core/tests/trip_lifecycle.rs:1789:    assert_eq!(next.metrics.unserved_trips, 0);
crates/caelum-core/tests/trip_lifecycle.rs:1793:    assert!(sim.outbound_arrived_today);
crates/caelum-core/tests/trip_lifecycle.rs:1804:    // `outbound_arrived_today`, unlocking the return spawn. Once the
crates/caelum-core/tests/trip_lifecycle.rs:1807:    // `returned_home_today`/`return_resolved_today`), the current day's return
crates/caelum-core/tests/trip_lifecycle.rs:1829:        outbound_arrived_today: true,
crates/caelum-core/tests/trip_lifecycle.rs:1831:        returned_home_today: false,
crates/caelum-core/tests/trip_lifecycle.rs:1837:        purpose: TripPurpose::CommuteReturn,
crates/caelum-core/tests/trip_lifecycle.rs:1850:    let next = tick_trips(&state, &topology, 1.0);
crates/caelum-core/tests/trip_lifecycle.rs:1859:        !sim.outbound_arrived_today,
crates/caelum-core/tests/trip_lifecycle.rs:1867:            .any(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteOutbound),
crates/caelum-core/tests/trip_lifecycle.rs:1874:            .any(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteReturn),
crates/caelum-core/tests/trip_lifecycle.rs:1903:        outbound_arrived_today: true,
crates/caelum-core/tests/trip_lifecycle.rs:1905:        returned_home_today: false,
crates/caelum-core/tests/trip_lifecycle.rs:1911:        purpose: TripPurpose::CommuteReturn,
crates/caelum-core/tests/trip_lifecycle.rs:1929:    let next = tick_trips(&state, &topology, day1_return_time - state.time + 1.0);
crates/caelum-core/tests/trip_lifecycle.rs:1936:    // `outbound_arrived_today` set only by the guard itself — but no actual
crates/caelum-core/tests/trip_lifecycle.rs:1940:        sim.outbound_arrived_today,
crates/caelum-core/tests/trip_lifecycle.rs:1954:        .find(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteReturn);
crates/caelum-core/tests/trip_lifecycle.rs:1984:        outbound_arrived_today: true,
crates/caelum-core/tests/trip_lifecycle.rs:1986:        returned_home_today: false,
crates/caelum-core/tests/trip_lifecycle.rs:1991:        purpose: TripPurpose::CommuteOutbound,
crates/caelum-core/tests/trip_lifecycle.rs:2004:    let next = tick_trips(&state, &topology, 0.0);
crates/caelum-core/tests/trip_lifecycle.rs:2074:fn zero_length_walk_leg_accrues_wait_time_under_large_tick() {
crates/caelum-core/tests/trip_lifecycle.rs:2078:    let next = tick_trips(&state, &topology, 60.0);
crates/caelum-core/tests/trip_lifecycle.rs:2096:    let large_snapshot = tick_trips(&state, &topology, 60.0);
crates/caelum-core/tests/trip_lifecycle.rs:2100:        stepped_snapshot = tick_trips(&stepped_snapshot, &topology, 1.0);
crates/caelum-core/tests/trip_lifecycle.rs:2157:    let next = tick_trips(&state, &topology, 1.0);
crates/caelum-core/tests/trip_lifecycle.rs:2160:    assert_eq!(next.metrics.completed_trips, 1);
crates/caelum-core/tests/trip_lifecycle.rs:2230:    let next = tick_trips(&state, &topology, 30.0);
crates/caelum-core/tests/trip_lifecycle.rs:2261:    let large = tick_trips(&start, &topology, 100.0);
crates/caelum-core/tests/trip_lifecycle.rs:2265:        stepped = tick_trips(&stepped, &topology, 1.0);
crates/caelum-core/tests/trip_lifecycle.rs:2268:    assert_eq!(large.metrics.unserved_trips, stepped.metrics.unserved_trips);
crates/caelum-core/tests/trip_lifecycle.rs:2317:    let next = tick_trips_with_objectives(&state, &topology, 70.0);
crates/caelum-core/tests/trip_lifecycle.rs:2326:/// Regression: a coarse tick can miss the aggregate `average_wait_seconds`
crates/caelum-core/tests/trip_lifecycle.rs:2367:    let next = tick_trips_with_objectives(&state, &topology, 200.0);
crates/caelum-core/tests/trip_lifecycle.rs:2376:fn assert_average_wait_loss_matches_coarse_and_fine(
crates/caelum-core/tests/trip_lifecycle.rs:2380:    let coarse = tick_trips_with_objectives(state, topology, 300.0);
crates/caelum-core/tests/trip_lifecycle.rs:2381:    let fine = tick_trips_with_objectives(state, topology, 1.0);
crates/caelum-core/tests/trip_lifecycle.rs:2402:    state.scenario.objectives.as_mut().unwrap().max_average_wait =
crates/caelum-core/tests/trip_lifecycle.rs:2426:    assert_average_wait_loss_matches_coarse_and_fine(&state, &topology);
crates/caelum-core/tests/trip_lifecycle.rs:2433:    state.scenario.objectives.as_mut().unwrap().max_average_wait =
crates/caelum-core/tests/trip_lifecycle.rs:2443:    assert_average_wait_loss_matches_coarse_and_fine(&state, &topology);
crates/caelum-core/tests/trip_lifecycle.rs:2475:    let next = tick_trips_with_objectives(&state, &topology, 400.0);
crates/caelum-core/tests/trip_lifecycle.rs:2495:        state.scenario.objectives.as_mut().unwrap().max_average_wait =
crates/caelum-core/tests/trip_lifecycle.rs:2515:    let coarse = tick_trips_with_objectives(&start, &topology, 700.0);
crates/caelum-core/tests/trip_lifecycle.rs:2529:        fine = tick_trips_with_objectives(&fine, &topology, 1.0);
crates/caelum-core/tests/trip_lifecycle.rs:2540:    assert_eq!(coarse.metrics.unserved_trips, fine.metrics.unserved_trips);
crates/caelum-core/tests/trip_lifecycle.rs:2567:    state.metrics.completed_trips = 40;
crates/caelum-core/tests/trip_lifecycle.rs:2568:    state.metrics.unserved_trips = 10;
crates/caelum-core/tests/trip_lifecycle.rs:2586:    let coarse = tick_trips_with_objectives(&state, &topology, 15.0);
crates/caelum-core/tests/trip_lifecycle.rs:2605:        fine = tick_trips_with_objectives(&fine, &topology, 1.0);

```

Fixture-impact rationale:

- No existing golden, commute-requirement, population, objective, or lifecycle expectation was bulk-rewritten.
- New natural-cost fixtures use `blankGrid` through `GameEngine::from_sandbox_request`; the first RED attempt used `GameEngine::new()`, whose Crossroads roads contaminated the long endpoint. The fixture was corrected rather than changing production behavior.
- The direct-bus fixture uses one-tile endpoint walks and a route created through road/stop/route intents. Its expected timing is derived from the captured path's actual road-step durations.
- The poor-bus fixture uses a compiled U-shaped detour component plus a separate direct car corridor; endpoint-adjacent road access is kept unambiguous.
- The staggered-arrival fixture clones a valid topology-produced car path and assigns sequential frozen arrival timestamps inside the coarse interval. It does not invent an impossible path or change car timing.

## RED-to-GREEN evidence

1. Natural-cost RED:
   - `rtk proxy cargo test -p caelum-core --test router_planning natural_no_transit_costs_keep_short_walk_and_make_long_car_faster -- --nocapture`
   - Failed with `long commute should have a car candidate`.
   - Cause: the test fixture used the Crossroads default and inherited an unrelated one-way road beside the destination. No production code was changed; the fixture moved to blank grid.
   - GREEN: `rtk proxy cargo test -p caelum-core --test router_planning natural_ -- --nocapture` — 3 passed.

2. Exact fractional-boundary RED:
   - `rtk proxy cargo test -p caelum-core --test trip_lifecycle -- --nocapture`
   - The new exact boundary case failed because `seconds_until_next_vehicle_stop` correctly includes later steps in the multi-step service leg, so it is larger than the requested 0.78125 seconds for the current step.
   - The assertion was corrected to `effective_road_step_seconds(flow, current_step) * (1.0 - step_progress)`; no production code was changed.
   - GREEN: the same target — 50 passed.

3. Final focused GREEN:
   - `rtk proxy cargo test -p caelum-core --test traffic --test trip_lifecycle --test router_planning --test router_estimate_branches --test transit_router --test shuttle_service --test golden_sequences --test commute_requirements --test population --test objectives_metrics` — 143 passed, 0 failed.

## Verification

- `rtk proxy cargo test --workspace` — passed.
- `rtk proxy cargo clippy --workspace --all-targets -- -D warnings` — passed.
- `rtk proxy cargo fmt --all --check` — passed.
- `rtk proxy bun run test:unit` — 54 files, 702 tests passed; WASM artifact rebuilt by the existing hook.
- `rtk proxy bun run check` — passed; 0 Svelte diagnostics.
- Sandboxed `rtk proxy bun run test:e2e -- tests/e2e/smoke.spec.ts` — environment failed to bind 127.0.0.1:5281 with EPERM.
- Elevated `rtk proxy bun run test:e2e -- tests/e2e/smoke.spec.ts` — 1 passed.
- `rtk proxy bun run format:check` — passed.
- `rtk proxy bun run lint` — passed.
- `rtk proxy git diff --check` — passed.

## Production-change audit

No production edit was required. The new acceptance cases did not expose a Task 1 flow-propagation or arithmetic defect. No UI, host, persistence, schema, ledger, or compatibility files were changed.

## Concerns and deviations

- The initial Playwright invocation was sandbox-blocked by localhost bind permissions; the exact command passed when retried with permission to run the local server with elevation.
- The report's commit SHA is filled after the task commit is created.

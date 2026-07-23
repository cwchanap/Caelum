use crate::heading::{canonical_headings, offset};
use crate::model::{BusStopKind, GameMap, GameSnapshot, Point, Stop, StopRoadAccess};
use crate::road::reciprocal_connection;
use crate::road_topology::{is_road, lane_accepts};
use crate::transit_nodes::is_present_node;

fn usable_road(map: &GameMap, point: Point) -> bool {
    map.tile(point).is_some_and(|tile| {
        is_road(map, point)
            && tile.road_structure_id.is_none()
            && canonical_headings().into_iter().any(|heading| {
                lane_accepts(tile.one_way, heading) && reciprocal_connection(map, point, heading)
            })
    })
}

pub(crate) fn derive_stop_access(map: &GameMap, anchor: Point) -> Option<StopRoadAccess> {
    derive_stop_access_for_footprint(map, &[anchor])
}

pub(crate) fn derive_stop_access_for_footprint(
    map: &GameMap,
    footprint: &[Point],
) -> Option<StopRoadAccess> {
    let road_point = footprint
        .iter()
        .flat_map(|point| {
            canonical_headings()
                .into_iter()
                .map(|heading| offset(*point, heading))
        })
        .find(|point| usable_road(map, *point))?;
    let tile = map.tile(road_point)?;
    let preferred_heading = canonical_headings()
        .into_iter()
        .find(|heading| {
            lane_accepts(tile.one_way, *heading) && tile.road_connections.contains(heading)
        })
        .or_else(|| {
            canonical_headings()
                .into_iter()
                .find(|heading| lane_accepts(tile.one_way, *heading))
        });
    Some(StopRoadAccess {
        road_point,
        preferred_heading,
    })
}

pub(crate) fn stop_footprint(snapshot: &GameSnapshot, stop: &Stop) -> Vec<Point> {
    snapshot
        .buildings
        .iter()
        .find(|building| building.transit_node_id.as_deref() == Some(stop.id.as_str()))
        .map_or_else(
            || vec![stop.position],
            |building| building.occupied_tiles.clone(),
        )
}

pub(crate) fn is_valid_access(map: &GameMap, footprint: &[Point], access: StopRoadAccess) -> bool {
    let adjacent_to_footprint = footprint.iter().any(|point| {
        canonical_headings()
            .into_iter()
            .any(|heading| offset(*point, heading) == access.road_point)
    });
    let legacy_on_road_fallback = footprint.len() == 1
        && footprint[0] == access.road_point
        && map.tile(access.road_point).is_some_and(|tile| {
            is_road(map, access.road_point) && tile.road_structure_id.is_none()
        });

    usable_road(map, access.road_point) && (adjacent_to_footprint || legacy_on_road_fallback)
}

pub(crate) fn stop_access(snapshot: &GameSnapshot, stop_id: &str) -> Option<StopRoadAccess> {
    let stop = snapshot
        .transit
        .stops
        .iter()
        .find(|stop| stop.id == stop_id && is_present_node(stop.status))?;
    let footprint = stop_footprint(snapshot, stop);
    match stop.road_access {
        Some(access) if is_valid_access(&snapshot.map, &footprint, access) => Some(access),
        _ => derive_stop_access_for_footprint(&snapshot.map, &footprint),
    }
}

#[derive(Clone, Debug)]
struct StopMove {
    stop_id: String,
    old_position: Point,
    new_position: Point,
    road_point: Point,
}

pub(crate) fn normalize_snapshot_stops(
    mut snapshot: GameSnapshot,
) -> crate::rejection::GameplayResult<GameSnapshot> {
    let mut stop_indexes: Vec<usize> = snapshot
        .transit
        .stops
        .iter()
        .enumerate()
        .filter_map(|(index, stop)| is_present_node(stop.status).then_some(index))
        .collect();
    stop_indexes.sort_by(|left, right| {
        snapshot.transit.stops[*left]
            .id
            .cmp(&snapshot.transit.stops[*right].id)
            .then_with(|| left.cmp(right))
    });

    let mut moves = Vec::new();
    for stop_index in stop_indexes {
        let stop = snapshot.transit.stops[stop_index].clone();
        let is_legacy_on_road = stop.kind == BusStopKind::BusStop
            && snapshot
                .map
                .tile(stop.position)
                .is_some_and(|tile| tile.kind == "road");

        if is_legacy_on_road {
            let road_point = stop.position;
            let new_position = canonical_headings()
                .into_iter()
                .map(|heading| offset(stop.position, heading))
                .find(|candidate| is_free_anchor(&snapshot, *candidate));
            let access = access_for_road_point(&snapshot.map, road_point).or_else(|| {
                new_position.and_then(|position| {
                    derive_stop_access_for_footprint(&snapshot.map, &[position])
                })
            });

            if let Some(new_position) = new_position {
                snapshot.transit.stops[stop_index].position = new_position;
                snapshot.transit.stops[stop_index].road_access = access;
                moves.push(StopMove {
                    stop_id: stop.id,
                    old_position: stop.position,
                    new_position,
                    road_point,
                });
            } else {
                snapshot.transit.stops[stop_index].road_access = access;
            }
            continue;
        }

        let current_stop = snapshot.transit.stops[stop_index].clone();
        let footprint = stop_footprint(&snapshot, &current_stop);
        snapshot.transit.stops[stop_index].road_access = match current_stop.road_access {
            Some(access) if is_valid_access(&snapshot.map, &footprint, access) => Some(access),
            _ => derive_stop_access_for_footprint(&snapshot.map, &footprint),
        };
    }

    rebase_active_trips(&mut snapshot, &moves);
    Ok(snapshot)
}

fn access_for_road_point(map: &GameMap, road_point: Point) -> Option<StopRoadAccess> {
    let tile = map.tile(road_point)?;
    if !usable_road(map, road_point) {
        return None;
    }
    let preferred_heading = canonical_headings()
        .into_iter()
        .find(|heading| {
            lane_accepts(tile.one_way, *heading) && tile.road_connections.contains(heading)
        })
        .or_else(|| {
            canonical_headings()
                .into_iter()
                .find(|heading| lane_accepts(tile.one_way, *heading))
        });
    Some(StopRoadAccess {
        road_point,
        preferred_heading,
    })
}

fn is_free_anchor(snapshot: &GameSnapshot, point: Point) -> bool {
    snapshot.map.tile(point).is_some_and(|tile| {
        tile.kind == "empty"
            && !tile.has_track
            && tile.road_structure_id.is_none()
            && !snapshot
                .buildings
                .iter()
                .any(|building| building.occupied_tiles.contains(&point))
            && !snapshot
                .transit
                .stops
                .iter()
                .any(|stop| is_present_node(stop.status) && stop.position == point)
            && !snapshot
                .transit
                .stations
                .iter()
                .any(|station| is_present_node(station.status) && station.position == point)
    })
}

fn rebase_active_trips(snapshot: &mut GameSnapshot, moves: &[StopMove]) {
    for movement in moves {
        debug_assert!(!movement.stop_id.is_empty());
        debug_assert_eq!(movement.road_point, movement.old_position);
        for trip in &mut snapshot.active_trips {
            if trip.status == crate::model::TripStatus::Waiting
                && trip.position == movement.old_position.into()
            {
                trip.position = movement.new_position.into();
            }

            let Some(route_plan) = trip.route_plan.as_mut() else {
                continue;
            };
            for leg_index in 0..route_plan.legs.len() {
                if route_plan.legs[leg_index].mode != crate::model::TransitMode::Bus {
                    continue;
                }

                let from_moved = route_plan.legs[leg_index].from == movement.old_position;
                let to_moved = route_plan.legs[leg_index].to == movement.old_position;
                if from_moved {
                    route_plan.legs[leg_index].from = movement.new_position;
                    if leg_index > 0
                        && route_plan.legs[leg_index - 1].mode == crate::model::TransitMode::Walk
                        && route_plan.legs[leg_index - 1].to == movement.old_position
                    {
                        route_plan.legs[leg_index - 1].to = movement.new_position;
                    }
                }
                if to_moved {
                    route_plan.legs[leg_index].to = movement.new_position;
                    if leg_index + 1 < route_plan.legs.len()
                        && route_plan.legs[leg_index + 1].mode == crate::model::TransitMode::Walk
                        && route_plan.legs[leg_index + 1].from == movement.old_position
                    {
                        route_plan.legs[leg_index + 1].from = movement.new_position;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intent::RoadPreset;
    use crate::road::{apply_road_mutation, RoadMutation};
    use crate::state::create_initial_snapshot;

    #[test]
    fn accepts_the_supported_on_road_fallback_access() {
        let snapshot = create_initial_snapshot();
        let candidate = apply_road_mutation(
            &snapshot,
            &RoadMutation::LayRoadLine {
                points: (2..=10).map(|x| Point { x, y: 5 }).collect(),
                preset: RoadPreset::TwoWay,
            },
        )
        .expect("fixture road should apply")
        .snapshot;

        assert!(is_valid_access(
            &candidate.map,
            &[Point { x: 4, y: 5 }],
            StopRoadAccess {
                road_point: Point { x: 4, y: 5 },
                preferred_heading: None,
            },
        ));
    }
}

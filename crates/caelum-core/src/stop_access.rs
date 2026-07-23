use crate::heading::{canonical_headings, offset};
use crate::model::{GameMap, GameSnapshot, Point, Stop, StopRoadAccess};
use crate::road::reciprocal_connection;
use crate::road_topology::{is_road, lane_accepts};

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
    usable_road(map, access.road_point)
        && footprint.iter().any(|point| {
            canonical_headings()
                .into_iter()
                .any(|heading| offset(*point, heading) == access.road_point)
        })
}

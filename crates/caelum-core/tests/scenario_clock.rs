use caelum_core::clock::{clock_minutes, day_index, scaled_delta, GAME_DAY_SECONDS};
use caelum_core::model::Heading;
use caelum_core::state::create_initial_snapshot;

#[test]
fn game_day_is_twenty_real_minutes_at_one_x() {
    assert_eq!(GAME_DAY_SECONDS, 1_200.0);
    assert_eq!(day_index(0.0), 0);
    assert_eq!(day_index(1_199.9), 0);
    assert_eq!(day_index(1_200.0), 1);
    assert_eq!(clock_minutes(0.0), 0);
    assert_eq!(clock_minutes(600.0), 720);
    assert_eq!(clock_minutes(1_199.9), 1_439);
    assert_eq!(scaled_delta(10.0, 4), 40.0);
}

#[test]
fn initial_map_matches_growing_suburb_surface() {
    let snapshot = create_initial_snapshot();
    assert_eq!(snapshot.map.width, 28);
    assert_eq!(snapshot.map.height, 18);
    assert_eq!(snapshot.map.tiles.len(), 28 * 18);

    let roads = snapshot
        .map
        .tiles
        .iter()
        .filter(|tile| tile.kind == "road")
        .count();
    assert_eq!(roads, 88);

    let west_lane = snapshot
        .map
        .tiles
        .iter()
        .find(|tile| tile.x == 2 && tile.y == 8)
        .unwrap();
    assert_eq!(
        west_lane.one_way.as_ref().map(Heading::as_str),
        Some("west")
    );

    let east_lane = snapshot
        .map
        .tiles
        .iter()
        .find(|tile| tile.x == 2 && tile.y == 9)
        .unwrap();
    assert_eq!(
        east_lane.one_way.as_ref().map(Heading::as_str),
        Some("east")
    );
}

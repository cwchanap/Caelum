use caelum_core::model::{Point, RoadStructure};
use caelum_core::road_topology::RoadTopologyCompileError;
use caelum_core::roundabouts::compile_roundabout_transitions;

#[test]
fn roundabout_compiler_reports_a_focused_error_with_the_candidate_footprint() {
    let footprint = vec![Point { x: 4, y: 2 }, Point { x: 5, y: 2 }];
    let structure = RoadStructure::AutomaticJunction {
        id: "junction-unsafe".to_string(),
        footprint: footprint.clone(),
        ports: Vec::new(),
    };

    assert_eq!(
        compile_roundabout_transitions(&structure).unwrap_err(),
        RoadTopologyCompileError::UnsafeRoundaboutPortMapping {
            structure_id: "junction-unsafe".to_string(),
            footprint,
        }
    );
}

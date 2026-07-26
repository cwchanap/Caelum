use crate::model::GameSnapshot;
use crate::sandbox::{canonical_default_request, create_sandbox_snapshot};

pub fn create_initial_snapshot() -> GameSnapshot {
    create_sandbox_snapshot(canonical_default_request())
        .expect("canonical default sandbox request and template must remain valid")
}

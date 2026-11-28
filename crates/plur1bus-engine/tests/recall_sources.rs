//! RE-D12 rank contracts for independent candidate sources.
use plur1bus_engine::recall::fusion::rrf;

#[test]
fn rank_fusion_preserves_each_source_order() {
    assert_eq!(
        rrf(&[&["third", "first", "second"]]),
        ["third", "first", "second"]
    );
    assert_eq!(rrf(&[&["a", "a", "b"], &["c", "b"]]), ["b", "a", "c"]);
}

#[test]
fn two_identities_fuse_by_rank_not_by_score() {
    let left = ["only-left", "shared"];
    let right = ["only-right", "shared"];
    assert_eq!(rrf(&[&left, &right]), ["shared", "only-left", "only-right"]);
}

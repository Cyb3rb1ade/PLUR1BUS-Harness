use plur1bus_desktop::controller::bundle::{embedded, Arch};
#[test]
fn embedded_bundle_parses() {
    let b = embedded();
    assert_eq!(b.version, "0.1.0-desktop-stub");
    assert_eq!(b.docker_min_api, "1.41");
}
#[test]
fn release_build_refuses_placeholder_digests() {
    assert!(embedded().validate_release(false).is_err());
    assert!(embedded().validate_release(true).is_ok());
}
#[test]
fn arch_maps_to_the_right_image() {
    let b = embedded();
    assert!(b.digest(Arch::Arm64).unwrap().starts_with("sha256:"));
    assert!(b.digest(Arch::Amd64).unwrap().starts_with("sha256:"));
}

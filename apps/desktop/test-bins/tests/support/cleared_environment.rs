// Compare with the same executable launched directly under env_clear. ARM
// Windows can synthesize PROCESSOR_ARCHITECTURE after CreateProcess; no other
// unrequested name may be excused by the baseline. Never expose values.
pub fn assert_environment(
    actual: &serde_json::Value,
    cleared: &serde_json::Value,
    allowed: &[&str],
) {
    assert_eq!(
        actual["architectureCanary"], false,
        "injected architecture value escaped clearing"
    );
    assert_eq!(cleared["architectureCanary"], false);
    assert_eq!(
        actual["architectureFingerprint"], cleared["architectureFingerprint"],
        "only the same native startup value may appear"
    );
    let baseline: Vec<String> = serde_json::from_value(cleared["env"].clone()).unwrap();
    assert!(
        baseline
            .iter()
            .all(|name| cfg!(windows) && name.eq_ignore_ascii_case("PROCESSOR_ARCHITECTURE")),
        "unexpected cleared environment names: {baseline:?}"
    );
    let names: Vec<String> = serde_json::from_value(actual["env"].clone()).unwrap();
    for name in &names {
        assert!(
            allowed
                .iter()
                .any(|allowed| allowed.eq_ignore_ascii_case(name))
                || baseline
                    .iter()
                    .any(|native| native.eq_ignore_ascii_case(name)),
            "unexpected child environment name: {name}; names: {names:?}"
        );
    }
}

use plur1bus_desktop::{
    connections::Origin,
    policy::{self, NavDecision},
};
use url::Url;
#[test]
fn navigation_table() {
    let upstream = Origin::parse("https://harness.test").unwrap();
    let proxy = Origin::parse("http://127.0.0.1:30001").unwrap();
    for (url, want) in [
        ("http://127.0.0.1:30001/a", NavDecision::Allow),
        ("https://harness.test/a", NavDecision::Allow),
        ("https://foreign.test/a", NavDecision::OpenExternal),
        ("mailto:owner@example.test", NavDecision::OpenExternal),
        ("file:///tmp/a", NavDecision::Block),
        ("javascript:alert(1)", NavDecision::Block),
        ("plur1bus://pair", NavDecision::Block),
    ] {
        assert_eq!(
            policy::navigation(&proxy, &upstream, &Url::parse(url).unwrap()),
            want
        );
    }
}
#[test]
fn caller_check_rejects_other_webview_and_other_origin() {
    let proxy = Origin::parse("http://127.0.0.1:30001").unwrap();
    assert!(policy::check_spa_caller(
        "spa",
        &Url::parse("http://127.0.0.1:30001/").unwrap(),
        &proxy
    )
    .is_ok());
    for (label, url) in [
        ("shell", "http://127.0.0.1:30001/"),
        ("panel-1", "http://127.0.0.1:30001/"),
        ("spa", "http://127.0.0.1:30002/"),
        ("spa", "http://user@127.0.0.1:30001/"),
    ] {
        assert!(policy::check_spa_caller(label, &Url::parse(url).unwrap(), &proxy).is_err());
    }
}

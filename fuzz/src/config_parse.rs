//! `plur1bus-config`: `parse` (JSON, defaults, schema validation) and the key-addressed helpers. Input layout: the
//! text up to the first NUL is config.json, the rest is `key\0json-value` pairs fed to `get`/`set`. Invariants: no
//! panic; a parsed config validates, serialises to text that parses back to the same value, has a stable revision, and
//! a successful `set` yields a config that still validates.
use plur1bus_config as cfg;
use serde_json::Value;

pub fn run(data: &[u8]) {
    let mut parts = data.splitn(2, |b| *b == 0);
    let text = parts.next().unwrap_or(&[]);
    let tail = parts.next().unwrap_or(&[]);
    let Ok(text) = std::str::from_utf8(text) else {
        return;
    };
    let tail = String::from_utf8_lossy(tail);

    let _ = cfg::ajv_date_time(text);
    let _ = cfg::restart_class_of(&tail);
    let _ = cfg::restart_class_name(&tail);
    let _ = cfg::tier_of(&tail);

    let Ok(config) = cfg::parse(text) else {
        return;
    };
    assert!(
        cfg::validate(&config).is_ok(),
        "a parsed config fails validation"
    );
    let rev = cfg::revision(&config);
    assert_eq!(rev, cfg::revision(&config), "revision is not deterministic");
    let reparsed = cfg::parse(&cfg::serialize(&config)).expect("serialised config re-parses");
    assert_eq!(
        config, reparsed,
        "serialise/parse round trip changed the config"
    );

    let mut it = tail.split('\0');
    let key = it.next().unwrap_or("");
    let _ = cfg::get(&config, Some(key));
    let _ = cfg::get(&config, None);
    let _ = cfg::restart_plan(&config, &reparsed);
    for tier in [cfg::Tier::Basic, cfg::Tier::Advanced] {
        let _ = cfg::filter_config_by_tier(&config, tier);
    }
    if let Some(Ok(value)) = it.next().map(serde_json::from_str::<Value>) {
        if let Ok(plan) = cfg::set(&config, key, value) {
            assert!(
                cfg::validate(&plan.after).is_ok(),
                "set returned a config that does not validate"
            );
        }
    }
}

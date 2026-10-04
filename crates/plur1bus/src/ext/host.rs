//! What this host offers an extension, and the test seams the ext layer honours (global constraints). Every seam works
//! only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`.
use plur1bus_ext::compat::HostFacts;
use plur1bus_ext::trust::TrustStore;
use std::time::Duration;

/// Extensions are inspected for 10 minutes before the inspection expires (spec §9.2).
const INSPECT_TTL: Duration = Duration::from_secs(10 * 60);

use super::record::allow_internals;

/// The facts `plur1bus_ext::compat::check_compat` checks a manifest against (X1-R20): the harness version (the crate's
/// own, or the seam `PLUR1BUS_TEST_HARNESS_VERSION=<semver>`), the module API this build speaks (with its own seam),
/// the RPC version (`plur1bus_rpc::RPC_VERSION`, which Task 10 generates from the schema), the release target as an
/// `install::targets` id (`check_compat` maps `win-*` to the manifest's `win32-*`) and container mode.
pub fn host_facts() -> HostFacts {
    let seam = allow_internals()
        .then(|| std::env::var("PLUR1BUS_TEST_HARNESS_VERSION").ok())
        .flatten()
        .filter(|v| semver::Version::parse(v).is_ok());
    HostFacts {
        harness_version: seam.unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string()),
        module_api_current: crate::modules::manifest::current_api_version(),
        rpc_version: plur1bus_rpc::RPC_VERSION.to_string(),
        platform: crate::install::targets::Target::current().map(|t| t.id().to_string()),
        container: crate::container::container_mode(),
    }
}

/// The keys a package signature may verify with: the pinned set (empty until X5, X1-R6) plus the seam
/// `PLUR1BUS_TEST_EXT_PUBKEYS`, which `TrustStore::from_env` honours only with test internals. A malformed seam value
/// never widens trust: the store falls back to the pinned set.
pub fn trust_store() -> TrustStore {
    TrustStore::from_env().unwrap_or_else(|_| TrustStore::pinned())
}

/// The names no extension may take (the D14 reserved module names, `core` and `supervisor` among them).
pub fn reserved_names() -> &'static [&'static str] {
    crate::modules::manifest::RESERVED_NAMES
}

/// How long an inspection stays valid: 10 minutes, or `PLUR1BUS_TEST_EXT_INSPECT_TTL_MS` with test internals.
pub fn inspect_ttl() -> Duration {
    allow_internals()
        .then(|| std::env::var("PLUR1BUS_TEST_EXT_INSPECT_TTL_MS").ok())
        .flatten()
        .and_then(|s| s.parse::<u64>().ok())
        .map_or(INSPECT_TTL, Duration::from_millis)
}

#[cfg(test)]
mod tests {
    #[test]
    fn host_rpc_version_is_the_schema_version() {
        let schema: serde_json::Value =
            serde_json::from_str(plur1bus_rpc::SCHEMA_JSON).expect("the RPC schema parses");
        assert_eq!(
            super::host_facts().rpc_version,
            schema["x-rpc-version"].as_str().unwrap()
        );
        assert_eq!(plur1bus_rpc::RPC_VERSION, "1.5.0");
    }
}

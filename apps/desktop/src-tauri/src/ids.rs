//! Stable public identifiers shared by desktop integrations.
/// Operating-system application identifier.
pub const BUNDLE_ID: &str = "app.plur1bus.desktop";
/// Service namespace reserved for native keychain storage.
pub const KEYCHAIN_SERVICE: &str = BUNDLE_ID;
/// User-visible product name.
pub const PRODUCT: &str = "PLUR1BUS";
/// Managed harness container name.
pub const CONTAINER: &str = "plur1bus-harness";
/// Namespace for managed container labels.
pub const LABEL_PREFIX: &str = "app.plur1bus";
/// Registered application URL scheme.
pub const SCHEME: &str = "plur1bus";

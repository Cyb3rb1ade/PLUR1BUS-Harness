//! P4-10: the listener on `run/core.sock` (directory 0700, socket 0600, stale-socket probe) or the Windows pipe with an
//! explicit SDDL, the NDJSON framing, and the dispatch through `plur1bus_rpc::server::dispatch_core`. P4-03 provides the
//! validators.

use plur1bus_rpc::server::Validators;

/// The params and result validators of every `x-server: "core"` method, compiled from pruned schema roots. Build them
/// once at start: an error is a schema bug and fails the start.
pub fn validators() -> Result<Validators, String> {
    Validators::for_server("core")
}

//! `packages/core/src/attestation/` (P4-K K2, plan P4-21): OS-backed attestation (issue #192, option C). One human
//! confirmation by the operating system lifts ONE approval from the unattested local level (T1) to T2. The core asks, the
//! core reads the answer; a confirmation is valid for exactly the approval it was asked for (nonce and action hash bound),
//! once, for at most 60 s. The helper itself is `crates/plur1bus-attest`; this module is the core's side of the protocol.
//!
//! **Nothing here runs in the product.** No RPC method and no approval flow reaches this module; the flip wires it. What it
//! needs comes in as a trait (R-K-2): [`HelperHost`] (verify the pinned binary, run it once with a deadline: the process
//! and file work of `helper.ts`), [`FileProbe`] (the `lstat` and user id behind `helperPinned`), [`AttestAudit`] (the
//! policy audit writer), the clock and the nonce source. The orchestration around them ([`run_helper`]: verify before,
//! run, verify after and drop an answer from a file that changed) is ported here.
//!
//! Not ported: the process spawn, the descriptor-bound SHA-256 of the binary and the `codesign` / Authenticode checks of
//! `verifyHelper`. They are the production [`HelperHost`] the flip supplies (with the process rules of K10).
pub mod helper;
pub mod service;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod vectors;

pub use helper::{
    helper_from_env, helper_pinned, run_helper, FileProbe, FileStat, HelperHost, HelperOutcome,
    HelperPin, HelperSpec,
};
pub use service::{
    AttestAudit, AttestFailure, AttestInput, AttestProbe, AttestResult, AttestationService,
    MAX_ATTEST_TTL_MS,
};

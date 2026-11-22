//! ADR-009 dreaming libraries. Runtime scheduling and engine work use host ports.

pub mod candidates;
pub mod learn;
pub mod lifecycle;
pub mod promotion;
pub mod runner;
pub mod scheduler;
pub mod store;
pub mod types;

fn can_run_jobs(who: &crate::rbac::types::Principal, now: i64) -> bool {
    use crate::rbac::{
        authorize::authorize,
        types::{AuthorizeContext, Resource},
    };
    authorize(
        Some(who),
        "jobs.run",
        &Resource::System,
        &AuthorizeContext {
            now: Some(now as f64),
        },
    )
    .is_allow()
}

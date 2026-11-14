//! `identity/recall.ts`: the recall scope provider (reads take the union, writes always take one canonical principal) over the
//! little the identity service has to answer for it.
use super::error::{IdentityError, IdentityErrorCode};
use super::principals::is_user_principal;

/// What the provider reads from the identity service: `IdentityService.resolvePrincipals`. A v2 principal, then the v1
/// principals of every currently linked handle; `not-found` for an unknown harness principal.
pub trait PrincipalResolver {
    /// The v2 principal followed by the linked v1 principals.
    fn resolve_principals(&self, user_v2: &str) -> Result<Vec<String>, IdentityError>;
}

/// `RecallScopeProvider`: the engine integration port.
pub trait RecallScopeProvider {
    /// The principals a read covers.
    fn resolve_principals(&self, user_v2: &str) -> Result<Vec<String>, IdentityError>;
    /// The one principal a write is stored under.
    fn capture_principal(&self, user_v2: &str) -> Result<String, IdentityError>;
}

/// The provider over a service.
#[derive(Clone, Debug)]
pub struct ServiceRecallScopeProvider<S> {
    service: S,
}

/// `createRecallScopeProvider(service)`.
pub fn create_recall_scope_provider<S: PrincipalResolver>(
    service: S,
) -> ServiceRecallScopeProvider<S> {
    ServiceRecallScopeProvider { service }
}

impl<S: PrincipalResolver> RecallScopeProvider for ServiceRecallScopeProvider<S> {
    fn resolve_principals(&self, user_v2: &str) -> Result<Vec<String>, IdentityError> {
        self.service.resolve_principals(user_v2)
    }

    fn capture_principal(&self, user_v2: &str) -> Result<String, IdentityError> {
        if !is_user_principal(user_v2) || !user_v2.starts_with("user:v2:") {
            return Err(IdentityError::new(
                IdentityErrorCode::InvalidParams,
                "expected v2 principal",
            ));
        }
        self.service.resolve_principals(user_v2)?; // require a known harness user
        Ok(user_v2.to_owned())
    }
}

//! Guarded outbound HTTP with host policy and resolve-then-pin address checks.

mod cancel;
pub mod guarded;
pub mod resolve;
pub mod target;

pub use crate::contract::{Scheme, Target};
pub(crate) use guarded::DeliveryFailure;
pub use guarded::{GuardedClient, HttpRequest, HttpResponse, ResponseBodyFailure, TransportError};
pub use resolve::{Resolver, SystemResolver};

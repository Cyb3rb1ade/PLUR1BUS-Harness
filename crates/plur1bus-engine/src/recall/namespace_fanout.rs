//! Lease all private routes and settle bounded batches before returning any failure.

use crate::contract::StoreError;
use crate::store::routes::IdentifiedStore;
use crate::store::StoreRoutes;

use super::merge::NamespaceResult;
use super::namespace_query::RequestQueries;
use super::namespaces::{CanonicalSource, NamespaceError, NamespaceRequest};

// Bound OS threads while retaining Node's settle-all and configured error order.
const MAX_NAMESPACE_WORKERS: usize = 8;

pub(crate) struct Lease {
    namespace: Option<String>,
    store: Result<Option<IdentifiedStore>, StoreError>,
}

pub(crate) fn lease(routes: &dyn StoreRoutes, agent: &str) -> Result<Vec<Lease>, NamespaceError> {
    let leases = routes
        .read_routes()
        .map_err(NamespaceError::Store)?
        .into_iter()
        .map(|route| {
            let store = route.lease_identified(agent);
            Lease {
                namespace: route.namespace,
                store,
            }
        })
        .collect::<Vec<_>>();
    // Production initializes all required sources before any child pipeline starts.
    // A known lease/identity error cannot turn into a partial provider invocation.
    for lease in &leases {
        if let Err(error) = &lease.store {
            return Err(NamespaceError::Store(error.clone()));
        }
    }
    Ok(leases)
}

pub(crate) fn query_scope(
    query: &str,
    leases: &[Lease],
    limits: Option<super::namespace_trace::TraceLimits>,
) -> Result<RequestQueries, NamespaceError> {
    let identities = leases
        .iter()
        .filter_map(|lease| {
            let store = lease.store.as_ref().ok()?.as_ref()?;
            Some((lease.namespace.clone(), store.identity.clone()))
        })
        .collect();
    RequestQueries::for_identities(query, identities, limits).map_err(NamespaceError::Store)
}

pub(crate) fn settle(
    request: &NamespaceRequest<'_>,
    leases: &[Lease],
    queries: &RequestQueries,
) -> Result<Vec<NamespaceResult>, NamespaceError> {
    let mut outcomes = Vec::with_capacity(leases.len());
    for (batch, chunk) in leases.chunks(MAX_NAMESPACE_WORKERS).enumerate() {
        outcomes.extend(settle_batch(
            request,
            chunk,
            queries,
            batch * MAX_NAMESPACE_WORKERS,
        ));
    }
    let mut children = Vec::new();
    let mut failure = None;
    for outcome in outcomes {
        match outcome {
            Ok(Some(child)) => children.push(child),
            Ok(None) => {}
            Err(error) if failure.is_none() => failure = Some(error),
            Err(_) => {}
        }
    }
    failure.map_or(Ok(children), Err)
}

fn settle_batch(
    request: &NamespaceRequest<'_>,
    leases: &[Lease],
    queries: &RequestQueries,
    offset: usize,
) -> Vec<Result<Option<NamespaceResult>, NamespaceError>> {
    std::thread::scope(|scope| {
        let handles = leases
            .iter()
            .enumerate()
            .map(|(index, lease)| {
                std::thread::Builder::new().spawn_scoped(scope, move || {
                    let store = lease
                        .store
                        .as_ref()
                        .map_err(|e| NamespaceError::Store(e.clone()))?;
                    let Some(store) = store else {
                        return Ok(None);
                    };
                    let canonical = if offset + index == 0 {
                        CanonicalSource::Read
                    } else {
                        CanonicalSource::Skip
                    };
                    request
                        .pipeline
                        .recall(lease.namespace.as_deref(), &store.store, canonical, queries)
                        .map(Some)
                })
            })
            .collect::<Vec<_>>();
        handles
            .into_iter()
            .map(|handle| match handle {
                Ok(handle) => handle.join().unwrap_or(Err(NamespaceError::WorkerFailed)),
                Err(_) => Err(NamespaceError::WorkerFailed),
            })
            .collect()
    })
}

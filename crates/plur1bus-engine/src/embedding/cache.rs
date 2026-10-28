//! Node v2 cache keys and a bounded memory tier over RE-02 persistence.

use super::{batch::validate_vectors, Cancel, EmbedKind, EmbeddingProvider};
use crate::{
    contract::EngineError,
    store::sqlite::{CacheKey, EmbeddingCache},
    text::js::{js_to_lower_case, js_trim, JsString},
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

/// Construct Node's complete cache key, replacing cut surrogates at the UTF-8 boundary.
#[allow(clippy::too_many_arguments)] // The arguments are the seven Node key components plus embedding purpose.
pub fn cache_key(
    provider: &str,
    model: &str,
    dimensions: usize,
    scope_id: &str,
    identity_hash: &str,
    kind: EmbedKind,
    text: &JsString,
) -> CacheKey {
    let model = if provider == "local-transformers" {
        format!("{model}:{kind}")
    } else {
        model.to_owned()
    };
    let text = text.to_utf8_lossy();
    let normalized = js_to_lower_case(js_trim(&text));
    CacheKey {
        provider: provider.into(),
        model,
        dimensions,
        scope_id: scope_id.into(),
        identity_hash: identity_hash.into(),
        text_hash: format!("{:x}", Sha256::digest(normalized.as_bytes())),
    }
}

#[derive(Clone)]
struct Cached {
    vector: Vec<f32>,
    expires_at: i64,
}
struct Entry {
    value: Cached,
    access: u64,
}
struct Flight {
    result: Mutex<Option<Result<Cached, super::EmbedError>>>,
    changed: std::sync::Condvar,
}
impl Flight {
    fn new() -> Self {
        Self {
            result: Mutex::new(None),
            changed: std::sync::Condvar::new(),
        }
    }
    fn snapshot(&self) -> Option<Result<Cached, super::EmbedError>> {
        self.result
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
    fn wait_for_change(&self, cancel: &Cancel) -> Result<(), EngineError> {
        cancel.check()?;
        let result = self
            .result
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if result.is_none() {
            let duration = cancel
                .remaining()
                .unwrap_or(Duration::from_millis(5))
                .min(Duration::from_millis(5));
            drop(
                self.changed
                    .wait_timeout(result, duration)
                    .unwrap_or_else(std::sync::PoisonError::into_inner),
            );
        }
        Ok(())
    }
    fn complete(&self, value: Result<Cached, super::EmbedError>) {
        let mut result = self
            .result
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if result.is_none() {
            *result = Some(value);
        }
    }
}
struct Claim {
    hash: String,
    key: CacheKey,
    text: String,
    flight: Arc<Flight>,
}
struct Memory {
    entries: HashMap<String, Entry>,
    inflight: HashMap<String, Arc<Flight>>,
    access: u64,
}

pub(crate) struct Cache {
    persistent: Option<EmbeddingCache>,
    memory: Mutex<Memory>,
    enabled: bool,
    max_entries: usize,
    ttl_ms: i64,
    scope_id: String,
}

// A provider panic or an early return must never leave other callers waiting on abandoned claims.
struct Publication {
    cache: Arc<Cache>,
    claims: Vec<Claim>,
    finished: bool,
}
impl Drop for Publication {
    fn drop(&mut self) {
        if !self.finished {
            self.cache
                .publish(&self.claims, &Err(super::EmbedError::Unavailable), 0);
        }
    }
}

impl Cache {
    pub(crate) fn new(
        persistent: Option<EmbeddingCache>,
        enabled: bool,
        max_entries: usize,
        ttl_ms: i64,
        scope_id: String,
    ) -> Self {
        Self {
            persistent,
            memory: Mutex::new(Memory {
                entries: HashMap::new(),
                inflight: HashMap::new(),
                access: 0,
            }),
            enabled,
            max_entries,
            ttl_ms,
            scope_id,
        }
    }

    fn lock(&self, cancel: &Cancel) -> Result<MutexGuard<'_, Memory>, EngineError> {
        loop {
            cancel.check()?;
            match self.memory.try_lock() {
                Ok(lock) => return Ok(lock),
                Err(std::sync::TryLockError::Poisoned(error)) => return Ok(error.into_inner()),
                Err(std::sync::TryLockError::WouldBlock) => {
                    std::thread::sleep(Duration::from_millis(2))
                }
            }
        }
    }

    fn remember(&self, memory: &mut Memory, hash: String, value: Cached) {
        memory.access = memory.access.wrapping_add(1);
        memory.entries.insert(
            hash,
            Entry {
                value,
                access: memory.access,
            },
        );
        while memory.entries.len() > self.max_entries {
            let oldest = memory
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.access)
                .map(|(hash, _)| hash.clone());
            if let Some(hash) = oldest {
                memory.entries.remove(&hash);
            } else {
                break;
            }
        }
    }

    fn publish(
        &self,
        claims: &[Claim],
        computed: &Result<Vec<Vec<f32>>, super::EmbedError>,
        completed_at: i64,
    ) {
        let mut memory = self
            .memory
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Ok(vectors) = computed {
            for (claim, vector) in claims.iter().zip(vectors) {
                self.remember(
                    &mut memory,
                    claim.hash.clone(),
                    Cached {
                        vector: vector.clone(),
                        expires_at: completed_at.saturating_add(self.ttl_ms),
                    },
                );
            }
        }
        drop(memory);
        // Node exposes warm memory entries immediately, then settles the flight after its best-effort write.
        if let (Some(cache), Ok(vectors)) = (&self.persistent, computed) {
            let expires_at = completed_at.saturating_add(self.ttl_ms);
            for (claim, vector) in claims.iter().zip(vectors) {
                let _ = cache.put_at(&claim.key, vector, expires_at, completed_at);
            }
        }
        let mut memory = self
            .memory
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for (index, claim) in claims.iter().enumerate() {
            let value = match computed {
                Ok(vectors) => Ok(Cached {
                    vector: vectors[index].clone(),
                    expires_at: completed_at.saturating_add(self.ttl_ms),
                }),
                Err(error) => Err(error.clone()),
            };
            claim.flight.complete(value);
            if memory
                .inflight
                .get(&claim.hash)
                .is_some_and(|flight| Arc::ptr_eq(flight, &claim.flight))
            {
                memory.inflight.remove(&claim.hash);
            }
        }
        drop(memory);
        for claim in claims {
            claim.flight.changed.notify_all();
        }
    }

    #[allow(clippy::too_many_arguments)] // Caller identity, host clock and cancellation are explicit at this boundary.
    pub(crate) fn embed(
        self: &Arc<Self>,
        provider: Arc<dyn EmbeddingProvider>,
        texts: &[String],
        kind: EmbedKind,
        identity_hash: &str,
        width: usize,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EngineError> {
        cancel.check()?;
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        if !self.enabled {
            let result = provider.embed(texts, kind, cancel)?;
            validate_vectors(&result, texts.len(), width)?;
            cancel.check()?;
            return Ok(result);
        }
        let identity = provider.identity();
        let model = if identity.provider == "local-transformers"
            && identity.model == "google/embeddinggemma-2"
        {
            format!("{}@{}", identity.model, identity.dtype)
        } else {
            identity.model.clone()
        };
        let keys: Vec<_> = texts
            .iter()
            .map(|text| {
                cache_key(
                    &identity.provider,
                    &model,
                    width,
                    &self.scope_id,
                    identity_hash,
                    kind,
                    &JsString::from_utf8_str(text),
                )
            })
            .collect();
        let mut result = vec![None; texts.len()];
        let mut waiting = Vec::new();
        let mut claims = Vec::new();
        {
            let mut memory = self.lock(cancel)?;
            let now = clock();
            for (index, key) in keys.iter().enumerate() {
                let hash = key.key_hash();
                memory.access = memory.access.wrapping_add(1);
                let access = memory.access;
                let value = memory
                    .entries
                    .get_mut(&hash)
                    .filter(|entry| entry.value.expires_at > now)
                    .map(|entry| {
                        entry.access = access;
                        entry.value.clone()
                    });
                let value = value.or_else(|| {
                    self.persistent
                        .as_ref()
                        .and_then(|cache| cache.get_at(key, now).ok().flatten())
                        .filter(|entry| {
                            validate_vectors(std::slice::from_ref(&entry.vector), 1, width).is_ok()
                        })
                        .map(|entry| Cached {
                            vector: entry.vector,
                            expires_at: entry.expires_at,
                        })
                });
                if let Some(value) = value {
                    self.remember(&mut memory, hash, value.clone());
                    result[index] = Some(value.vector);
                    continue;
                }
                let flight = if let Some(flight) = memory.inflight.get(&hash) {
                    flight.clone()
                } else {
                    let flight = Arc::new(Flight::new());
                    memory.inflight.insert(hash.clone(), flight.clone());
                    claims.push(Claim {
                        hash,
                        key: key.clone(),
                        text: texts[index].clone(),
                        flight: flight.clone(),
                    });
                    flight
                };
                waiting.push((index, flight));
            }
        }
        if !claims.is_empty() {
            // The computation belongs to the shared flight, not to whichever caller claimed it.
            // Moving publication into the closure also cleans up claims if spawning fails.
            let publication = Publication {
                cache: self.clone(),
                claims,
                finished: false,
            };
            std::thread::Builder::new()
                .name("embedding-cache".into())
                .spawn(move || {
                    let mut publication = publication;
                    let missing: Vec<_> = publication
                        .claims
                        .iter()
                        .map(|claim| claim.text.clone())
                        .collect();
                    let computed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        let vectors = provider.embed(&missing, kind, &Cancel::never())?;
                        validate_vectors(&vectors, missing.len(), width)?;
                        Ok(vectors)
                    }))
                    .unwrap_or(Err(super::EmbedError::ProviderFailed { status: None }));
                    publication
                        .cache
                        .publish(&publication.claims, &computed, clock());
                    publication.finished = true;
                })
                .map_err(|_| super::EmbedError::Unavailable)?;
        }
        // Workers compute owned claims without waiting on foreign flights, so overlapping batches cannot form a cycle.
        // Observe every completed error on each bounded wait; an earlier pending key cannot mask a later failure.
        while !waiting.is_empty() {
            cancel.check()?;
            let mut pending = Vec::new();
            for (index, flight) in waiting {
                match flight.snapshot() {
                    Some(Ok(value)) => result[index] = Some(value.vector),
                    Some(Err(error)) => return Err(error.into()),
                    None => pending.push((index, flight)),
                }
            }
            if let Some((_, flight)) = pending.first() {
                flight.wait_for_change(cancel)?;
            }
            waiting = pending;
        }
        result
            .into_iter()
            .map(|value| value.ok_or_else(|| super::EmbedError::InvalidVector.into()))
            .collect()
    }
}

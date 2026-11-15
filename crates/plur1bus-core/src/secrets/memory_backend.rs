//! `secrets/memory-backend.ts`: the in-memory test backend (ADR-005 action 5). `available` can be flipped by a test.
//!
//! Behaviour kept as it is: `put` stores the description as given (it only *checks* it), `describe` stores the trimmed text;
//! `describe` keeps the old `updatedBy` when none is given, `put` does not; an empty `updatedBy` counts as none; `list` sorts
//! by [`compare_names`] (stable, so a tie keeps insertion order) and `dump` is in insertion order; the replaced value is
//! handed to `register` before the second description check.
use super::backend::{compare_names, iso_timestamp, SecretBackend};
use super::error::SecretError;
use super::types::{check_description, next_description, BackendKind, BackendProbe, SecretMeta};

#[derive(Clone)]
struct Entry {
    value: String,
    created_at: String,
    updated_at: String,
    updated_by: Option<String>,
    description: Option<String>,
}

impl Entry {
    fn meta(&self, name: &str) -> SecretMeta {
        SecretMeta {
            name: name.to_owned(),
            backend: BackendKind::Memory,
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            updated_by: self.updated_by.clone(),
            description: self.description.clone(),
        }
    }
}

/// `createMemoryBackend({ available })`.
pub struct MemoryBackend {
    /// While false every operation but `probe` raises `backend-unavailable`.
    pub available: bool,
    /// Insertion order, as a JavaScript `Map` keeps it.
    entries: Vec<(String, Entry)>,
}

impl Default for MemoryBackend {
    fn default() -> MemoryBackend {
        MemoryBackend::new(true)
    }
}

/// An empty `updatedBy` is as good as none (`updatedBy ? ... : {}`).
fn given_by(updated_by: Option<&str>) -> Option<String> {
    updated_by.filter(|s| !s.is_empty()).map(str::to_owned)
}

impl MemoryBackend {
    /// An empty backend.
    pub fn new(available: bool) -> MemoryBackend {
        MemoryBackend {
            available,
            entries: Vec::new(),
        }
    }

    /// `dump()`: name and value of every entry, in insertion order.
    pub fn dump(&self) -> Vec<(String, String)> {
        self.entries
            .iter()
            .map(|(name, e)| (name.clone(), e.value.clone()))
            .collect()
    }

    fn guard(&self) -> Result<(), SecretError> {
        if self.available {
            Ok(())
        } else {
            Err(SecretError::memory_backend_off())
        }
    }

    fn position(&self, name: &str) -> Option<usize> {
        self.entries.iter().position(|(n, _)| n == name)
    }

    fn store(&mut self, name: &str, entry: Entry) {
        match self.position(name) {
            Some(at) => self.entries[at].1 = entry,
            None => self.entries.push((name.to_owned(), entry)),
        }
    }
}

impl SecretBackend for MemoryBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Memory
    }

    fn probe(&mut self) -> Result<BackendProbe, SecretError> {
        Ok(if self.available {
            BackendProbe {
                available: true,
                reason: None,
            }
        } else {
            BackendProbe {
                available: false,
                reason: Some("memory-backend-off".to_owned()),
            }
        })
    }

    fn get(&mut self, name: &str) -> Result<Option<String>, SecretError> {
        self.guard()?;
        Ok(self
            .position(name)
            .map(|at| self.entries[at].1.value.clone()))
    }

    fn put(
        &mut self,
        name: &str,
        value: &str,
        now_ms: i64,
        updated_by: Option<&str>,
        description: Option<&str>,
        mut register: Option<&mut dyn FnMut(&str)>,
    ) -> Result<SecretMeta, SecretError> {
        self.guard()?;
        let at = iso_timestamp(now_ms)?;
        let old = self.position(name).map(|i| self.entries[i].1.clone());
        let kept = next_description(
            old.as_ref().and_then(|e| e.description.as_deref()),
            description,
        );
        check_description(kept.as_deref(), Some(value))?;
        if let Some(old) = &old {
            if let Some(register) = register.as_mut() {
                register(&old.value);
            }
            check_description(kept.as_deref(), Some(&old.value))?;
        }
        let by = given_by(updated_by);
        let entry = Entry {
            value: value.to_owned(),
            created_at: old.map_or_else(|| at.clone(), |e| e.created_at),
            updated_at: at,
            updated_by: by,
            description: kept.filter(|d| !d.is_empty()),
        };
        let meta = entry.meta(name);
        self.store(name, entry);
        Ok(meta)
    }

    fn describe(
        &mut self,
        name: &str,
        description: &str,
        now_ms: i64,
        updated_by: Option<&str>,
        mut register: Option<&mut dyn FnMut(&str)>,
    ) -> Result<SecretMeta, SecretError> {
        self.guard()?;
        let Some(old) = self.position(name).map(|i| self.entries[i].1.clone()) else {
            return Err(SecretError::not_found());
        };
        if let Some(register) = register.as_mut() {
            register(&old.value);
        }
        let text = check_description(Some(description), Some(&old.value))?;
        let updated_at = iso_timestamp(now_ms)?;
        let mut next = old;
        next.updated_at = updated_at;
        if let Some(by) = given_by(updated_by) {
            next.updated_by = Some(by);
        }
        next.description = text.filter(|t| !t.is_empty());
        let meta = next.meta(name);
        self.store(name, next);
        Ok(meta)
    }

    fn delete(&mut self, name: &str, _tombstone_at_ms: Option<i64>) -> Result<bool, SecretError> {
        self.guard()?;
        Ok(match self.position(name) {
            Some(at) => {
                self.entries.remove(at);
                true
            }
            None => false,
        })
    }

    fn list(&mut self) -> Result<Vec<SecretMeta>, SecretError> {
        self.guard()?;
        let mut metas: Vec<SecretMeta> = self.entries.iter().map(|(n, e)| e.meta(n)).collect();
        metas.sort_by(|a, b| compare_names(&a.name, &b.name));
        Ok(metas)
    }
}

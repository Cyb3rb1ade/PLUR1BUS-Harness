//! Per-host crawl reservations with host-owned time and interruptible waits.

use std::{collections::HashMap, sync::Mutex};

const MAX_PACED_HOSTS: usize = 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Cancelled,
    Unavailable,
}

pub trait Clock {
    fn now_ms(&self) -> u64;
    fn sleep_ms(&self, ms: u64, cancelled: &dyn Fn() -> bool) -> Result<(), Error>;
}

#[derive(Clone, Copy, Eq, PartialEq)]
struct Slot {
    until: u64,
    id: u64,
}

#[derive(Default)]
struct Reservations {
    sequence: u64,
    slots: HashMap<String, Slot>,
}

pub struct Pacer {
    minimum: u64,
    next: Mutex<Reservations>,
}

impl Pacer {
    pub fn new(minimum_ms: u64) -> Self {
        Self {
            minimum: minimum_ms,
            next: Mutex::default(),
        }
    }

    pub fn len(&self) -> Result<usize, Error> {
        Ok(self
            .next
            .lock()
            .map_err(|_| Error::Unavailable)?
            .slots
            .len())
    }

    pub fn is_empty(&self) -> Result<bool, Error> {
        self.len().map(|count| count == 0)
    }

    pub fn wait(
        &self,
        host: &str,
        delay_ms: u64,
        clock: &dyn Clock,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<(), Error> {
        if cancelled() {
            return Err(Error::Cancelled);
        }
        let (at, previous, current) = {
            let mut state = self.next.lock().map_err(|_| Error::Unavailable)?;
            let previous = state.slots.get(host).copied();
            let at = clock.now_ms().max(previous.map_or(0, |slot| slot.until));
            state.sequence = state.sequence.checked_add(1).ok_or(Error::Unavailable)?;
            let current = Slot {
                until: at.saturating_add(delay_ms.max(self.minimum)),
                id: state.sequence,
            };
            state.slots.insert(host.into(), current);
            if state.slots.len() > MAX_PACED_HOSTS {
                let now = clock.now_ms();
                state.slots.retain(|_, slot| slot.until > now);
                if state.slots.len() > MAX_PACED_HOSTS {
                    let oldest = state
                        .slots
                        .values()
                        .map(|slot| slot.id)
                        .min()
                        .ok_or(Error::Unavailable)?;
                    state.slots.retain(|_, slot| slot.id != oldest);
                }
            }
            (at, previous, current)
        };
        let wait = at.saturating_sub(clock.now_ms());
        if wait == 0 {
            return Ok(());
        }
        if let Err(error) = clock.sleep_ms(wait, cancelled) {
            let mut state = self.next.lock().map_err(|_| Error::Unavailable)?;
            if state.slots.get(host) == Some(&current) {
                if let Some(previous) = previous {
                    state.slots.insert(host.into(), previous);
                } else {
                    state.slots.remove(host);
                }
            }
            return Err(error);
        }
        Ok(())
    }
}

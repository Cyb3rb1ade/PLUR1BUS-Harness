use std::collections::{BTreeMap, BTreeSet};

pub(super) struct Buckets {
    rate: u32,
    values: BTreeMap<String, Bucket>,
    order: BTreeSet<(u64, String)>,
    serial: u64,
}

struct Bucket {
    tokens: f64,
    at: u64,
    serial: u64,
}

impl Buckets {
    pub(super) fn new(rate: u32) -> Self {
        Self {
            rate,
            values: BTreeMap::new(),
            order: BTreeSet::new(),
            serial: 0,
        }
    }

    fn tokens(&self, key: &str, now: u64) -> f64 {
        let rate = f64::from(self.rate);
        self.values.get(key).map_or(rate, |bucket| {
            (bucket.tokens + now.saturating_sub(bucket.at) as f64 / 60_000.0 * rate).min(rate)
        })
    }

    pub(super) fn has(&self, key: &str, now: u64) -> bool {
        self.tokens(key, now) >= 1.0
    }

    pub(super) fn take(&mut self, key: &str, now: u64) -> Result<(), u32> {
        let tokens = self.tokens(key, now);
        let at = if let Some(old) = self.values.remove(key) {
            self.order.remove(&(old.serial, key.to_owned()));
            now.max(old.at)
        } else {
            now
        };
        if self.values.len() >= 10_000 {
            if let Some((_, oldest)) = self.order.pop_first() {
                self.values.remove(&oldest);
            }
        }
        self.serial = self.serial.wrapping_add(1);
        self.order.insert((self.serial, key.to_owned()));
        self.values.insert(
            key.to_owned(),
            Bucket {
                tokens: if tokens >= 1.0 { tokens - 1.0 } else { tokens },
                at,
                serial: self.serial,
            },
        );
        if tokens >= 1.0 {
            Ok(())
        } else {
            Err(((1.0 - tokens) * 60.0 / f64::from(self.rate))
                .ceil()
                .max(1.0) as u32)
        }
    }
}

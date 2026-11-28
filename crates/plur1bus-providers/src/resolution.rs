//! Bounded host address lookups. Workers only return an admission decision.
use std::{
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, Instant},
};

pub type Resolver<T, R> = Arc<dyn Fn(&T, Instant, &AtomicBool) -> R + Send + Sync>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResolutionError {
    Aborted,
    Deadline,
    Busy,
    Unavailable,
}

const LIMIT: usize = 16;
const SLICE: Duration = Duration::from_millis(20);
static ACTIVE: AtomicUsize = AtomicUsize::new(0);

struct Slot(&'static AtomicUsize);
impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

pub fn resolve<T: Send + 'static, R: Send + 'static>(
    resolver: Resolver<T, R>,
    target: T,
    deadline: Instant,
    cancelled: &dyn Fn() -> bool,
) -> Result<R, ResolutionError> {
    resolve_bounded(resolver, target, deadline, cancelled, &ACTIVE, LIMIT)
}

fn resolve_bounded<T: Send + 'static, R: Send + 'static>(
    resolver: Resolver<T, R>,
    target: T,
    deadline: Instant,
    cancelled: &dyn Fn() -> bool,
    active: &'static AtomicUsize,
    limit: usize,
) -> Result<R, ResolutionError> {
    let stop_reason = || {
        if cancelled() {
            Some(ResolutionError::Aborted)
        } else if Instant::now() >= deadline {
            Some(ResolutionError::Deadline)
        } else {
            None
        }
    };
    if let Some(reason) = stop_reason() {
        return Err(reason);
    }
    active
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
            (n < limit).then_some(n + 1)
        })
        .map_err(|_| stop_reason().unwrap_or(ResolutionError::Busy))?;
    let slot = Slot(active);
    let stop = Arc::new(AtomicBool::new(false));
    let worker_stop = Arc::clone(&stop);
    let (tx, rx) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("address-admission".into())
        .spawn(move || {
            if !worker_stop.load(Ordering::Acquire) && Instant::now() < deadline {
                let result = resolver(&target, deadline, &worker_stop);
                drop(slot);
                let _ = tx.send(result);
            }
        })
        .map_err(|_| stop_reason().unwrap_or(ResolutionError::Unavailable))?;
    loop {
        if let Some(reason) = stop_reason() {
            stop.store(true, Ordering::Release);
            return Err(reason);
        }
        match rx.recv_timeout(SLICE.min(deadline.saturating_duration_since(Instant::now()))) {
            Ok(value) => return stop_reason().map_or(Ok(value), Err),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(stop_reason().unwrap_or(ResolutionError::Unavailable))
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn abandoned_worker_keeps_its_slot_until_the_resolver_finishes() {
        static COUNT: AtomicUsize = AtomicUsize::new(0);
        let (entered, rx) = mpsc::channel();
        let (release, finish) = mpsc::channel();
        let finish = std::sync::Mutex::new(finish);
        let deadline = Instant::now() + Duration::from_secs(5);
        let stop = AtomicBool::new(false);
        thread::scope(|scope| {
            let flag = &stop;
            scope.spawn(move || {
                if rx.recv_timeout(Duration::from_secs(2)).is_ok() {
                    flag.store(true, Ordering::Release);
                }
            });
            let result = resolve_bounded(
                Arc::new(move |_: &(), d, signal| {
                    assert_eq!(d, deadline);
                    let _ = entered.send(());
                    if let Ok(receiver) = finish.lock() {
                        let _ = receiver.recv_timeout(Duration::from_secs(3));
                    }
                    assert!(signal.load(Ordering::Acquire));
                }),
                (),
                deadline,
                &|| stop.load(Ordering::Acquire),
                &COUNT,
                1,
            );
            assert_eq!(result, Err(ResolutionError::Aborted));
        });
        assert_eq!(
            resolve_bounded(
                Arc::new(|_: &(), _, _| ()),
                (),
                deadline,
                &|| false,
                &COUNT,
                1
            ),
            Err(ResolutionError::Busy)
        );
        assert!(release.send(()).is_ok());
        while COUNT.load(Ordering::Acquire) > 0 && Instant::now() < deadline {
            thread::yield_now();
        }
        assert_eq!(
            resolve_bounded(
                Arc::new(|_: &(), _, _| ()),
                (),
                deadline,
                &|| false,
                &COUNT,
                1
            ),
            Ok(())
        );
    }
}

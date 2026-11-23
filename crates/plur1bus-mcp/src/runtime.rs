//! The SDK can log untrusted messages at WARN and INFO. Keep its tasks on a
//! current-thread runtime with a local dispatcher that emits no SDK events.
use std::{future::Future, io, time::Duration};

pub(crate) fn quiet<F: Future>(run: impl FnOnce() -> F, drain: Duration) -> io::Result<F::Output> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()?;
    let result =
        tracing::dispatcher::with_default(&tracing::Dispatch::none(), || runtime.block_on(run()));
    runtime.shutdown_timeout(drain);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use std::{
        fmt::Debug,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::Duration,
    };

    use tracing::{
        field::{Field, Visit},
        span, Event, Metadata, Subscriber,
    };

    const MARKER: &str = "ordinary-sdk-private-marker";

    struct Receiver(Arc<AtomicUsize>);
    impl Subscriber for Receiver {
        fn enabled(&self, _: &Metadata<'_>) -> bool {
            true
        }
        fn new_span(&self, _: &span::Attributes<'_>) -> span::Id {
            span::Id::from_u64(1)
        }
        fn record(&self, _: &span::Id, _: &span::Record<'_>) {}
        fn record_follows_from(&self, _: &span::Id, _: &span::Id) {}
        fn enter(&self, _: &span::Id) {}
        fn exit(&self, _: &span::Id) {}
        fn event(&self, event: &Event<'_>) {
            let mut marker = Marker(false);
            event.record(&mut marker);
            if marker.0 {
                self.0.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
    struct Marker(bool);
    impl Visit for Marker {
        fn record_debug(&mut self, _: &Field, value: &dyn Debug) {
            self.0 |= format!("{value:?}").contains(MARKER);
        }
    }

    #[test]
    fn scoped_dispatcher_filters_peer_markers_even_at_warn_and_in_spawned_tasks() {
        let count = Arc::new(AtomicUsize::new(0));
        tracing::subscriber::with_default(Receiver(count.clone()), || {
            tracing::warn!(ordinary = MARKER, "baseline event");
            assert_eq!(count.load(Ordering::Relaxed), 1);
            let result = super::quiet(
                || async {
                    tracing::warn!(peer = MARKER, "direct SDK event");
                    tokio::spawn(async {
                        tracing::info!(peer = MARKER, "spawned SDK event");
                    })
                    .await
                },
                Duration::from_millis(100),
            );
            assert!(matches!(result, Ok(Ok(()))));
            assert_eq!(count.load(Ordering::Relaxed), 1);
            tracing::warn!(ordinary = MARKER, "host event after SDK");
            assert_eq!(count.load(Ordering::Relaxed), 2);
        });
    }
}

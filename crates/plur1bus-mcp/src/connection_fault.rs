use tokio::sync::watch;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Cause {
    Backpressure,
    ReconnectLimit,
}

#[derive(Clone)]
pub(crate) struct Fault(watch::Sender<Option<Cause>>);

impl Fault {
    pub(crate) fn new() -> Self {
        Self(watch::channel(None).0)
    }

    pub(crate) fn current(&self) -> Option<Cause> {
        *self.0.borrow()
    }

    pub(crate) async fn wait(&self) -> Cause {
        let mut observer = self.0.subscribe();
        loop {
            let cause = *observer.borrow_and_update();
            if let Some(cause) = cause {
                return cause;
            }
            // self retains the sender for the lifetime of the waiter.
            let _ = observer.changed().await;
        }
    }

    pub(crate) fn trip(&self, cause: Cause) {
        self.0.send_if_modified(|stored| {
            if stored.is_some() {
                return false;
            }
            *stored = Some(cause);
            true
        });
    }
}

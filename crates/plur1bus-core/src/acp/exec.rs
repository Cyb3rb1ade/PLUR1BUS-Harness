//! A tiny single-threaded executor and the few primitives the ACP server needs (design D1 of K8).
//!
//! The TypeScript server is written with `async`/`await` over Node's event loop. This library has no async runtime (tokio is a
//! dev-dependency of the front door's test server only), and a thread per concern would make the order of the frames written
//! depend on the scheduler. So the port keeps the shape of the original with plain `std::future`:
//!
//! - [`Exec::spawn`] polls a task once at once (as a JavaScript async function runs its synchronous prefix when called) and
//!   queues it when it is not done;
//! - [`Exec::run_until_stalled`] polls the queued tasks in rounds, in the order they were spawned, until a whole round makes no
//!   progress (a task finished, a value was sent, a [`yield_now`] was taken, a [`Signal`] fired). It never blocks and never
//!   sleeps: what a task waits for (input, a permission answer, a deadline) is delivered from outside, by the caller;
//! - [`yield_now`] is one tick of the microtask queue, which is what an `await` of an already settled value costs.
//!
//! Everything is `!Send` on purpose: one connection is served by one thread.
use std::cell::{Cell, RefCell};
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll, Waker};

thread_local! {
    static PROGRESS: Cell<u64> = const { Cell::new(0) };
}

fn bump() {
    PROGRESS.with(|p| p.set(p.get().wrapping_add(1)));
}

/// Tells the executor that something it may be waiting for happened (a gate opened, a value arrived).
pub fn notify() {
    bump();
}

fn progress() -> u64 {
    PROGRESS.with(Cell::get)
}

type Task = Pin<Box<dyn Future<Output = ()>>>;

/// The executor: a queue of tasks that are waiting for something.
#[derive(Default)]
pub struct Exec {
    tasks: RefCell<Vec<Option<Task>>>,
}

impl Exec {
    /// A new, empty executor.
    pub fn new() -> Rc<Exec> {
        Rc::new(Exec::default())
    }

    /// Starts a task: its synchronous prefix runs now.
    pub fn spawn(&self, fut: impl Future<Output = ()> + 'static) {
        let mut task: Task = Box::pin(fut);
        if !poll_task(&mut task) {
            self.tasks.borrow_mut().push(Some(task));
        }
    }

    /// Polls the waiting tasks until none of them can go on without something from outside.
    pub fn run_until_stalled(&self) {
        loop {
            let before = progress();
            let n = self.tasks.borrow().len();
            for i in 0..n {
                let taken = self.tasks.borrow_mut()[i].take();
                if let Some(mut task) = taken {
                    if !poll_task(&mut task) {
                        self.tasks.borrow_mut()[i] = Some(task);
                    }
                }
            }
            self.tasks.borrow_mut().retain(Option::is_some);
            if progress() == before {
                return;
            }
        }
    }

    /// How many tasks are still waiting.
    pub fn waiting(&self) -> usize {
        self.tasks.borrow().iter().filter(|t| t.is_some()).count()
    }
}

fn poll_task(task: &mut Task) -> bool {
    let mut cx = Context::from_waker(Waker::noop());
    match task.as_mut().poll(&mut cx) {
        Poll::Ready(()) => {
            bump();
            true
        }
        Poll::Pending => false,
    }
}

/// One tick: the task goes to the back of the queue and continues in the next round.
pub fn yield_now() -> YieldNow {
    YieldNow(false)
}

/// The future of [`yield_now`].
pub struct YieldNow(bool);

impl Future for YieldNow {
    type Output = ();
    fn poll(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<()> {
        if self.0 {
            Poll::Ready(())
        } else {
            self.0 = true;
            bump();
            Poll::Pending
        }
    }
}

/// The sending half of a one-shot channel.
pub struct Sender<T>(Rc<RefCell<Option<T>>>);
/// The receiving half of a one-shot channel; awaiting it waits for the value.
pub struct Receiver<T>(Rc<RefCell<Option<T>>>);

/// A one-shot channel.
pub fn oneshot<T>() -> (Sender<T>, Receiver<T>) {
    let slot = Rc::new(RefCell::new(None));
    (Sender(slot.clone()), Receiver(slot))
}

impl<T> Sender<T> {
    /// Delivers the value.
    pub fn send(self, value: T) {
        *self.0.borrow_mut() = Some(value);
        bump();
    }
}

impl<T> Future for Receiver<T> {
    type Output = T;
    fn poll(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<T> {
        match self.0.borrow_mut().take() {
            Some(v) => Poll::Ready(v),
            None => Poll::Pending,
        }
    }
}

type Listener = (u64, Box<dyn FnOnce()>);

struct SignalState {
    aborted: Cell<bool>,
    next: Cell<u64>,
    listeners: RefCell<Vec<Listener>>,
}

/// An `AbortSignal`: aborted once, listeners run at that moment.
#[derive(Clone)]
pub struct Signal(Rc<SignalState>);

impl Default for Signal {
    fn default() -> Signal {
        Signal::new()
    }
}

impl Signal {
    /// A signal that is not aborted.
    pub fn new() -> Signal {
        Signal(Rc::new(SignalState {
            aborted: Cell::new(false),
            next: Cell::new(0),
            listeners: RefCell::new(Vec::new()),
        }))
    }

    /// Whether it was aborted.
    pub fn aborted(&self) -> bool {
        self.0.aborted.get()
    }

    /// Aborts it (once) and runs the listeners in the order they were added.
    pub fn abort(&self) {
        if self.0.aborted.replace(true) {
            return;
        }
        bump();
        let listeners = std::mem::take(&mut *self.0.listeners.borrow_mut());
        for (_, f) in listeners {
            f();
        }
    }

    /// Adds a listener; a signal that is aborted already does not call it (as `addEventListener` on an aborted signal).
    pub fn on_abort(&self, f: impl FnOnce() + 'static) -> u64 {
        let id = self.0.next.get();
        self.0.next.set(id + 1);
        if !self.0.aborted.get() {
            self.0.listeners.borrow_mut().push((id, Box::new(f)));
        }
        id
    }

    /// Removes a listener.
    pub fn off(&self, id: u64) {
        self.0.listeners.borrow_mut().retain(|(i, _)| *i != id);
    }

    /// `AbortSignal.any([a, b])`: aborted when either is (already aborted counts at once).
    pub fn any(a: &Signal, b: &Signal) -> Signal {
        let out = Signal::new();
        if a.aborted() || b.aborted() {
            out.aborted_now();
            return out;
        }
        for s in [a, b] {
            let o = out.clone();
            s.on_abort(move || o.abort());
        }
        out
    }

    fn aborted_now(&self) {
        self.0.aborted.set(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_task_runs_its_prefix_at_once_and_resumes_in_later_rounds() {
        let exec = Exec::new();
        let log = Rc::new(RefCell::new(Vec::new()));
        let (l1, l2) = (log.clone(), log.clone());
        exec.spawn(async move {
            l1.borrow_mut().push("a1");
            yield_now().await;
            l1.borrow_mut().push("a2");
        });
        exec.spawn(async move {
            l2.borrow_mut().push("b1");
            yield_now().await;
            l2.borrow_mut().push("b2");
        });
        assert_eq!(*log.borrow(), vec!["a1", "b1"]);
        exec.run_until_stalled();
        assert_eq!(*log.borrow(), vec!["a1", "b1", "a2", "b2"]);
        assert_eq!(exec.waiting(), 0);
    }

    #[test]
    fn a_task_waits_for_a_value_from_outside_and_the_executor_stalls_without_it() {
        let exec = Exec::new();
        let (tx, rx) = oneshot::<u32>();
        let seen = Rc::new(Cell::new(0));
        let s = seen.clone();
        exec.spawn(async move { s.set(rx.await) });
        exec.run_until_stalled();
        assert_eq!((seen.get(), exec.waiting()), (0, 1));
        tx.send(7);
        exec.run_until_stalled();
        assert_eq!((seen.get(), exec.waiting()), (7, 0));
    }

    #[test]
    fn signals_fire_listeners_once_and_any_follows_both() {
        let (a, b) = (Signal::new(), Signal::new());
        let any = Signal::any(&a, &b);
        let hits = Rc::new(Cell::new(0));
        let h = hits.clone();
        let id = any.on_abort(move || h.set(h.get() + 1));
        let h2 = hits.clone();
        any.on_abort(move || h2.set(h2.get() + 10));
        any.off(id);
        b.abort();
        b.abort();
        assert!(any.aborted() && !a.aborted());
        assert_eq!(hits.get(), 10);
        assert!(Signal::any(&a, &b).aborted());
    }
}

//! `trace.ts`: W3C trace context for log records. The current trace is a thread-local scope ([`with_trace`]), the
//! counterpart of the TypeScript `AsyncLocalStorage`; only an authenticated, trusted caller can adopt a carrier
//! ([`from_rpc_meta`]). No outbound vendor carrier is provided.
use serde_json::Value;
use std::cell::RefCell;

/// A trace context: the ids a record carries, the `traceparent` they came from, and the foreign trace an untrusted
/// carrier named (`link_trace_id`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TraceContext {
    /// 32 lower-case hex digits, not all zero.
    pub trace_id: String,
    /// 16 lower-case hex digits, not all zero.
    pub span_id: String,
    /// `00-<trace_id>-<span_id>-<flags>`.
    pub traceparent: String,
    /// The trace id of an untrusted carrier, kept as a link instead of being adopted.
    pub link_trace_id: Option<String>,
}

thread_local! {
    static CURRENT: RefCell<Vec<TraceContext>> = const { RefCell::new(Vec::new()) };
}

fn all_zero(s: &str) -> bool {
    s.bytes().all(|b| b == b'0')
}

fn lower_hex(s: &str) -> bool {
    s.bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `parseTraceparent` for a string: `00-<32 hex>-<16 hex>-<2 hex>`, lower case, neither id all zero.
pub fn parse_traceparent(value: &str) -> Option<TraceContext> {
    let parts: Vec<&str> = value.split('-').collect();
    let [version, trace, span, flags] = parts.as_slice() else {
        return None;
    };
    let shaped = *version == "00"
        && trace.len() == 32
        && span.len() == 16
        && flags.len() == 2
        && lower_hex(trace)
        && lower_hex(span)
        && lower_hex(flags);
    if !shaped || all_zero(trace) || all_zero(span) {
        return None;
    }
    Some(TraceContext {
        trace_id: (*trace).to_string(),
        span_id: (*span).to_string(),
        traceparent: value.to_string(),
        link_trace_id: None,
    })
}

/// `parseTraceparent` for a JSON value (anything that is not a string is no carrier).
pub fn parse_traceparent_value(value: &Value) -> Option<TraceContext> {
    value.as_str().and_then(parse_traceparent)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A fresh trace from the caller's random bytes (the random source is a parameter, like the clock).
pub fn new_trace_from(trace: [u8; 16], span: [u8; 8]) -> TraceContext {
    let trace_id = hex(&trace);
    let span_id = hex(&span);
    TraceContext {
        traceparent: format!("00-{trace_id}-{span_id}-01"),
        trace_id,
        span_id,
        link_trace_id: None,
    }
}

/// A fresh trace from the operating system's entropy. When there is none the ids are derived from the clock, so a record
/// still carries distinct, non-zero ids.
pub fn new_trace() -> TraceContext {
    let mut trace = [0u8; 16];
    let mut span = [0u8; 8];
    if getrandom::fill(&mut trace).is_err() || getrandom::fill(&mut span).is_err() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(1);
        trace = nanos.to_be_bytes();
        span.copy_from_slice(&nanos.to_be_bytes()[8..]);
    }
    if all_zero(&hex(&trace)) {
        trace[15] = 1;
    }
    if all_zero(&hex(&span)) {
        span[7] = 1;
    }
    new_trace_from(trace, span)
}

/// The trace the calling thread runs in, if any.
pub fn current_trace() -> Option<TraceContext> {
    CURRENT.with(|stack| stack.borrow().last().cloned())
}

struct Scope;

impl Drop for Scope {
    fn drop(&mut self) {
        CURRENT.with(|stack| {
            stack.borrow_mut().pop();
        });
    }
}

/// Runs `f` with `context` as the current trace of this thread; the scope ends when `f` returns or unwinds.
pub fn with_trace<T>(context: TraceContext, f: impl FnOnce() -> T) -> T {
    CURRENT.with(|stack| stack.borrow_mut().push(context));
    let _scope = Scope;
    f()
}

/// `fromRpcMeta` with the fresh trace given: an authenticated, trusted caller's valid `_meta.traceparent` is adopted;
/// otherwise a fresh trace is used, and a valid carrier of an untrusted caller is linked, not adopted.
pub fn from_rpc_meta_with(
    meta: &Value,
    trusted: bool,
    fresh: impl FnOnce() -> TraceContext,
) -> TraceContext {
    let parsed = meta.get("traceparent").and_then(parse_traceparent_value);
    if trusted {
        if let Some(parsed) = parsed {
            return parsed;
        }
    }
    let mut context = fresh();
    if let Some(parsed) = parsed {
        context.link_trace_id = Some(parsed.trace_id);
    }
    context
}

/// `fromRpcMeta(meta, trusted)`.
pub fn from_rpc_meta(meta: &Value, trusted: bool) -> TraceContext {
    from_rpc_meta_with(meta, trusted, new_trace)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_new_trace_parses_back_and_rejects_zero_ids() {
        let a = new_trace();
        let b = new_trace();
        assert_ne!(a.trace_id, b.trace_id);
        assert_eq!(
            parse_traceparent(&a.traceparent).unwrap().trace_id,
            a.trace_id
        );
        let zero = format!("00-{}-{}-01", "0".repeat(32), "1".repeat(16));
        assert!(parse_traceparent(&zero).is_none());
        let zero_span = format!("00-{}-{}-01", "1".repeat(32), "0".repeat(16));
        assert!(parse_traceparent(&zero_span).is_none());
    }

    #[test]
    fn only_a_trusted_caller_adopts_a_carrier() {
        let a = new_trace();
        let meta = json!({ "traceparent": a.traceparent });
        assert_ne!(from_rpc_meta(&meta, false).trace_id, a.trace_id);
        assert_eq!(
            from_rpc_meta(&meta, false).link_trace_id,
            Some(a.trace_id.clone())
        );
        assert_eq!(from_rpc_meta(&meta, true).trace_id, a.trace_id);
        assert_eq!(
            from_rpc_meta(&json!({"traceparent": "nope"}), true).link_trace_id,
            None
        );
        assert_eq!(from_rpc_meta(&Value::Null, true).link_trace_id, None);
    }

    #[test]
    fn the_scope_is_per_thread_nested_and_ends_on_unwind() {
        assert!(current_trace().is_none());
        let (a, b) = (new_trace(), new_trace());
        with_trace(a.clone(), || {
            assert_eq!(current_trace(), Some(a.clone()));
            with_trace(b.clone(), || assert_eq!(current_trace(), Some(b.clone())));
            assert_eq!(current_trace(), Some(a.clone()));
            std::thread::scope(|s| {
                s.spawn(|| assert!(current_trace().is_none()))
                    .join()
                    .unwrap();
            });
        });
        assert!(current_trace().is_none());
        let unwound = std::panic::catch_unwind(|| with_trace(new_trace(), || panic!("fixture")));
        assert!(unwound.is_err());
        assert!(current_trace().is_none());
    }
}

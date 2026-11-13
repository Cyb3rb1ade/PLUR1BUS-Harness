//! `metrics/registry.ts`: a minimal metrics registry for the Prometheus text exposition format 0.0.4.
//!
//! Cardinality is bounded by construction: every label has a closed enumeration of allowed values, a value outside it is
//! folded into `other` (never stored as given), and a metric whose label space could exceed [`MAX_SERIES_PER_METRIC`] is
//! refused when it is declared. So no caller-supplied string (agent name, user, path, error text) can ever become a label
//! value or grow the number of series.
//!
//! The exposition text is byte-identical to the TypeScript registry's for the same sequence of operations:
//! - numbers are written as JavaScript's `String(number)` does ([`js_number_to_string`]: no `.0`, exponents past `1e21`
//!   and below `1e-6`), with `+Inf`, `-Inf` and `NaN` as [`fmt`] writes them;
//! - series are sorted by `localeCompare` of their joined label values ([`locale_compare`], ICU's root order for ASCII).
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fmt as stdfmt;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

/// The label space (series count) one metric may declare without an explicit bound.
pub const MAX_SERIES_PER_METRIC: u64 = 1024;
/// Hard ceiling even for a metric that declares its own bound ([`CounterOptions::max_series`]).
pub const MAX_SERIES_HARD_LIMIT: u64 = 16384;
const OTHER: &str = "other";

/// A declaration the registry refuses; the text is the TypeScript error message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegistryError(pub String);

impl stdfmt::Display for RegistryError {
    fn fmt(&self, f: &mut stdfmt::Formatter<'_>) -> stdfmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for RegistryError {}

/// Label name to its closed enumeration of values, in declaration order. `other` is always allowed (the fold target).
pub type LabelSpec = Vec<(String, Vec<String>)>;
/// The label values of one observation, by label name. A name that is missing, or a value outside its enumeration, is
/// folded into `other`.
pub type LabelValues<'a> = &'a [(&'a str, &'a str)];

/// A [`LabelSpec`] from literals.
pub fn spec(labels: &[(&str, &[&str])]) -> LabelSpec {
    labels
        .iter()
        .map(|(name, values)| {
            (
                (*name).to_owned(),
                values.iter().map(|v| (*v).to_owned()).collect(),
            )
        })
        .collect()
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn json_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

/// JavaScript's `String(n)` for a finite number (the algorithm of ECMAScript `Number::toString`); `-0` is `0`.
pub fn js_number_to_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_owned();
    }
    if n == 0.0 {
        return "0".to_owned();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    let sign = if n < 0.0 { "-" } else { "" };
    // The shortest digits that round-trip, as `d.ddde<exp>`.
    let sci = format!("{:e}", n.abs());
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let exp: i32 = exp.parse().unwrap_or(0);
    let k = i32::try_from(digits.len()).unwrap_or(i32::MAX);
    let point = exp + 1; // the value is 0.<digits> * 10^point
    let body = if k <= point && point <= 21 {
        format!(
            "{digits}{}",
            "0".repeat(usize::try_from(point - k).unwrap_or(0))
        )
    } else if 0 < point && point <= 21 {
        let at = usize::try_from(point).unwrap_or(0);
        format!("{}.{}", &digits[..at], &digits[at..])
    } else if -6 < point && point <= 0 {
        format!(
            "0.{}{digits}",
            "0".repeat(usize::try_from(-point).unwrap_or(0))
        )
    } else {
        let e = point - 1;
        let e_text = format!("{}{}", if e < 0 { "-" } else { "+" }, e.abs());
        if k == 1 {
            format!("{digits}e{e_text}")
        } else {
            format!("{}.{}e{e_text}", &digits[..1], &digits[1..])
        }
    };
    format!("{sign}{body}")
}

/// `fmt(n)` of the registry: a sample value, `+Inf`, `-Inf` and `NaN` written the Prometheus way.
pub fn fmt(n: f64) -> String {
    if n == f64::INFINITY {
        "+Inf".to_owned()
    } else if n == f64::NEG_INFINITY {
        "-Inf".to_owned()
    } else if n.is_nan() {
        "NaN".to_owned()
    } else {
        js_number_to_string(n)
    }
}

fn escape_help(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\n', "\\n")
}

fn escape_label(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

fn metric_name_ok(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_' || c == ':')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == ':')
}

fn label_name_ok(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The collation weights of a string under ICU's root collation (what `localeCompare` uses under `en-US`), for the
/// characters a label value holds: ignorable controls, then white space, punctuation and symbols in the CLDR order,
/// digits, letters (case ignored at the first level, lower case before upper case at the third). A character outside
/// ASCII sorts after the letters by code point.
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
struct CollationKey {
    primary: Vec<u32>,
    tertiary: Vec<u8>,
}

/// White space and ASCII punctuation in the order ICU gives them (before digits and letters).
const PUNCTUATION: &str = "\t\n\u{b}\u{c}\r _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";

fn collation_key(s: &str) -> CollationKey {
    let mut key = CollationKey {
        primary: Vec::with_capacity(s.len()),
        tertiary: Vec::with_capacity(s.len()),
    };
    for c in s.chars() {
        let (primary, tertiary) = match c {
            // Completely ignorable: `a\0b` compares as `ab`.
            '\u{0}'..='\u{8}' | '\u{e}'..='\u{1f}' | '\u{7f}' => continue,
            '0'..='9' => (100 + u32::from(c) - u32::from('0'), 0),
            'a'..='z' => (200 + u32::from(c) - u32::from('a'), 0),
            'A'..='Z' => (200 + u32::from(c) - u32::from('A'), 1),
            _ => match PUNCTUATION.find(c) {
                Some(at) => (u32::try_from(at).unwrap_or(0), 0),
                None => (1000 + u32::from(c), 0),
            },
        };
        key.primary.push(primary);
        key.tertiary.push(tertiary);
    }
    key
}

/// `a.localeCompare(b)` for label keys (see [`CollationKey`]).
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    collation_key(a).cmp(&collation_key(b))
}

/// Series of one metric in the order they were first seen; the key is the label values joined by a NUL.
struct Store<T> {
    index: HashMap<String, usize>,
    items: Vec<(Vec<String>, T)>,
}

impl<T> Store<T> {
    fn new() -> Self {
        Store {
            index: HashMap::new(),
            items: Vec::new(),
        }
    }

    fn entry(&mut self, values: Vec<String>, init: impl FnOnce() -> T) -> &mut T {
        let key = values.join("\u{0}");
        let at = match self.index.get(&key) {
            Some(at) => *at,
            None => {
                self.items.push((values, init()));
                self.index.insert(key, self.items.len() - 1);
                self.items.len() - 1
            }
        };
        &mut self.items[at].1
    }

    /// The series sorted by `localeCompare` of their keys (a stable sort, as `Array.prototype.sort`).
    fn sorted(&self) -> Vec<&(Vec<String>, T)> {
        let mut keyed: Vec<(CollationKey, usize)> = self
            .items
            .iter()
            .enumerate()
            .map(|(at, (values, _))| (collation_key(&values.join("\u{0}")), at))
            .collect();
        keyed.sort_by(|a, b| a.0.cmp(&b.0));
        keyed.into_iter().map(|(_, at)| &self.items[at]).collect()
    }
}

struct Allowed {
    ordered: Vec<String>,
    set: HashSet<String>,
}

struct Labels {
    names: Vec<String>,
    allowed: Vec<Allowed>,
}

impl Labels {
    fn new(
        spec: &LabelSpec,
        extra_series_factor: u64,
        metric: &str,
        cap: u64,
    ) -> Result<Labels, RegistryError> {
        let mut names = Vec::new();
        let mut allowed = Vec::new();
        for (name, values) in spec {
            if !label_name_ok(name) || name.starts_with("__") || name == "le" {
                return Err(RegistryError(format!(
                    "invalid label name {} on {metric}",
                    json_string(name)
                )));
            }
            let mut ordered = Vec::new();
            let mut set = HashSet::new();
            for v in values
                .iter()
                .map(String::as_str)
                .chain(std::iter::once(OTHER))
            {
                if set.insert(v.to_owned()) {
                    ordered.push(v.to_owned());
                }
            }
            names.push(name.clone());
            allowed.push(Allowed { ordered, set });
        }
        let combos = allowed.iter().fold(1u64, |a, s| {
            a.saturating_mul(u64::try_from(s.ordered.len()).unwrap_or(u64::MAX))
        });
        let total = combos.saturating_mul(extra_series_factor);
        if total > cap {
            return Err(RegistryError(format!(
                "{metric}: label space of {total} series exceeds the cap of {cap}"
            )));
        }
        Ok(Labels { names, allowed })
    }

    /// The normalised values in declaration order.
    fn values(&self, given: LabelValues<'_>) -> Vec<String> {
        self.names
            .iter()
            .zip(&self.allowed)
            .map(|(name, allowed)| {
                given
                    .iter()
                    .find(|(n, _)| n == name)
                    .map(|(_, v)| *v)
                    .filter(|v| allowed.set.contains(*v))
                    .unwrap_or(OTHER)
                    .to_owned()
            })
            .collect()
    }

    fn render(&self, values: &[String], extra: Option<(&str, &str)>) -> String {
        let mut parts: Vec<String> = self
            .names
            .iter()
            .zip(values)
            .map(|(n, v)| format!("{n}=\"{}\"", escape_label(v)))
            .collect();
        if let Some((name, value)) = extra {
            parts.push(format!("{name}=\"{}\"", escape_label(value)));
        }
        if parts.is_empty() {
            String::new()
        } else {
            format!("{{{}}}", parts.join(","))
        }
    }

    /// Every combination of allowed values, the first label varying slowest.
    fn all(&self) -> Vec<Vec<String>> {
        let mut out: Vec<Vec<String>> = vec![Vec::new()];
        for allowed in &self.allowed {
            let mut next = Vec::with_capacity(out.len() * allowed.ordered.len());
            for prefix in &out {
                for v in &allowed.ordered {
                    let mut combo = prefix.clone();
                    combo.push(v.clone());
                    next.push(combo);
                }
            }
            out = next;
        }
        out
    }
}

/// Options of [`Registry::counter`].
#[derive(Clone, Copy, Debug, Default)]
pub struct CounterOptions {
    /// An explicit series bound for a metric whose label enumerations are closed sets derived from a generated source
    /// (the RPC method list), so the bound grows with the schema instead of silently breaking core start. At most
    /// [`MAX_SERIES_HARD_LIMIT`]; the metric is still refused at declaration if its label space exceeds it. `None` for
    /// hand-written enumerations (cap [`MAX_SERIES_PER_METRIC`]).
    pub max_series: Option<u64>,
}

/// A monotonically increasing counter.
#[derive(Clone)]
pub struct Counter {
    labels: Arc<Labels>,
    store: Arc<Mutex<Store<f64>>>,
}

impl Counter {
    /// `inc(labels)`: one more.
    pub fn inc(&self, given: LabelValues<'_>) {
        self.inc_by(given, 1.0);
    }

    /// `inc(labels, by)`: a negative or non-finite `by` is ignored.
    pub fn inc_by(&self, given: LabelValues<'_>, by: f64) {
        if !by.is_finite() || by < 0.0 {
            return;
        }
        let values = self.labels.values(given);
        *lock(&self.store).entry(values, || 0.0) += by;
    }

    /// Creates every series with 0.
    pub fn init_all(&self) {
        let mut store = lock(&self.store);
        for values in self.labels.all() {
            *store.entry(values, || 0.0) += 0.0;
        }
    }
}

/// A gauge set from outside.
#[derive(Clone)]
pub struct Gauge {
    labels: Arc<Labels>,
    store: Arc<Mutex<Store<f64>>>,
}

impl Gauge {
    /// `set(labels, value)`: a non-finite value is ignored.
    pub fn set(&self, given: LabelValues<'_>, value: f64) {
        if !value.is_finite() {
            return;
        }
        let values = self.labels.values(given);
        *lock(&self.store).entry(values, || 0.0) = value;
    }
}

struct HistogramSeries {
    counts: Vec<u64>,
    sum: f64,
    count: u64,
}

/// A histogram with fixed, cumulative buckets.
#[derive(Clone)]
pub struct Histogram {
    labels: Arc<Labels>,
    buckets: Arc<Vec<f64>>,
    store: Arc<Mutex<Store<HistogramSeries>>>,
}

impl Histogram {
    fn fresh(&self) -> HistogramSeries {
        HistogramSeries {
            counts: vec![0; self.buckets.len()],
            sum: 0.0,
            count: 0,
        }
    }

    /// `observe(labels, value)`: a negative or non-finite value is ignored.
    pub fn observe(&self, given: LabelValues<'_>, value: f64) {
        if !value.is_finite() || value < 0.0 {
            return;
        }
        let values = self.labels.values(given);
        let mut store = lock(&self.store);
        let series = store.entry(values, || self.fresh());
        series.count += 1;
        series.sum += value;
        for (count, bound) in series.counts.iter_mut().zip(self.buckets.iter()) {
            if value <= *bound {
                *count += 1; // cumulative buckets
            }
        }
    }

    /// Creates every series empty.
    pub fn init_all(&self) {
        let mut store = lock(&self.store);
        for values in self.labels.all() {
            store.entry(values, || self.fresh());
        }
    }
}

type Lines = Arc<dyn Fn() -> Vec<String> + Send + Sync>;

#[derive(Clone)]
struct Family {
    name: String,
    help: String,
    kind: &'static str,
    lines: Lines,
}

#[derive(Default)]
struct State {
    families: Vec<Family>,
    /// Every sample name in use: a histogram `x` also exposes `x_bucket`, `x_sum` and `x_count`, which must not be
    /// another metric's name.
    taken: HashSet<String>,
}

/// The registry: declares metrics and renders the exposition. Cloning shares it.
#[derive(Clone, Default)]
pub struct Registry {
    state: Arc<Mutex<State>>,
}

impl Registry {
    /// `createRegistry()`.
    pub fn new() -> Registry {
        Registry::default()
    }

    fn declare(
        &self,
        name: &str,
        help: &str,
        kind: &'static str,
        lines: Lines,
    ) -> Result<(), RegistryError> {
        if !metric_name_ok(name) {
            return Err(RegistryError(format!(
                "invalid metric name {}",
                json_string(name)
            )));
        }
        let names: Vec<String> = if kind == "histogram" {
            vec![
                name.to_owned(),
                format!("{name}_bucket"),
                format!("{name}_sum"),
                format!("{name}_count"),
            ]
        } else {
            vec![name.to_owned()]
        };
        let mut state = lock(&self.state);
        for n in &names {
            if state.taken.contains(n) {
                return Err(RegistryError(format!(
                    "metric {name} is already registered ({n} is in use)"
                )));
            }
        }
        state.taken.extend(names);
        state.families.push(Family {
            name: name.to_owned(),
            help: help.to_owned(),
            kind,
            lines,
        });
        Ok(())
    }

    /// `counter(name, help, labels, options)`.
    pub fn counter(
        &self,
        name: &str,
        help: &str,
        labels: &LabelSpec,
        options: CounterOptions,
    ) -> Result<Counter, RegistryError> {
        if let Some(max) = options.max_series {
            if !(1..=MAX_SERIES_HARD_LIMIT).contains(&max) {
                return Err(RegistryError(format!(
                    "{name}: maxSeries must be an integer in 1..{MAX_SERIES_HARD_LIMIT}"
                )));
            }
        }
        let labels = Arc::new(Labels::new(
            labels,
            1,
            name,
            options.max_series.unwrap_or(MAX_SERIES_PER_METRIC),
        )?);
        let store = Arc::new(Mutex::new(Store::<f64>::new()));
        let (l, s, n) = (labels.clone(), store.clone(), name.to_owned());
        self.declare(
            name,
            help,
            "counter",
            Arc::new(move || sample_lines(&n, &l, &s)),
        )?;
        Ok(Counter { labels, store })
    }

    /// `gauge(name, help, labels)`.
    pub fn gauge(
        &self,
        name: &str,
        help: &str,
        labels: &LabelSpec,
    ) -> Result<Gauge, RegistryError> {
        let labels = Arc::new(Labels::new(labels, 1, name, MAX_SERIES_PER_METRIC)?);
        let store = Arc::new(Mutex::new(Store::<f64>::new()));
        let (l, s, n) = (labels.clone(), store.clone(), name.to_owned());
        self.declare(
            name,
            help,
            "gauge",
            Arc::new(move || sample_lines(&n, &l, &s)),
        )?;
        Ok(Gauge { labels, store })
    }

    /// `gaugeFn(name, help, fn)`: an unlabelled gauge computed at render time; a panicking or non-finite callback is
    /// skipped.
    pub fn gauge_fn(
        &self,
        name: &str,
        help: &str,
        f: impl Fn() -> f64 + Send + Sync + 'static,
    ) -> Result<(), RegistryError> {
        let n = name.to_owned();
        self.declare(
            name,
            help,
            "gauge",
            Arc::new(move || match catch_unwind(AssertUnwindSafe(&f)) {
                Ok(v) if v.is_finite() => vec![format!("{n} {}", fmt(v))],
                _ => Vec::new(),
            }),
        )
    }

    /// `histogram(name, help, labels, buckets)`.
    pub fn histogram(
        &self,
        name: &str,
        help: &str,
        labels: &LabelSpec,
        buckets: &[f64],
    ) -> Result<Histogram, RegistryError> {
        let ascending = buckets.windows(2).all(|w| w[1] > w[0]);
        if buckets.is_empty() || buckets.iter().any(|b| !b.is_finite()) || !ascending {
            return Err(RegistryError(format!(
                "{name}: buckets must be finite and strictly ascending"
            )));
        }
        let labels = Arc::new(Labels::new(
            labels,
            u64::try_from(buckets.len()).unwrap_or(u64::MAX) + 3,
            name,
            MAX_SERIES_PER_METRIC,
        )?);
        let buckets = Arc::new(buckets.to_vec());
        let store = Arc::new(Mutex::new(Store::<HistogramSeries>::new()));
        let (l, b, s, n) = (
            labels.clone(),
            buckets.clone(),
            store.clone(),
            name.to_owned(),
        );
        self.declare(
            name,
            help,
            "histogram",
            Arc::new(move || {
                let store = lock(&s);
                let mut out = Vec::new();
                for (values, series) in store.sorted() {
                    for (bound, count) in b.iter().zip(&series.counts) {
                        out.push(format!(
                            "{n}_bucket{} {}",
                            l.render(values, Some(("le", &fmt(*bound)))),
                            count
                        ));
                    }
                    out.push(format!(
                        "{n}_bucket{} {}",
                        l.render(values, Some(("le", "+Inf"))),
                        series.count
                    ));
                    out.push(format!(
                        "{n}_sum{} {}",
                        l.render(values, None),
                        fmt(series.sum)
                    ));
                    out.push(format!(
                        "{n}_count{} {}",
                        l.render(values, None),
                        series.count
                    ));
                }
                out
            }),
        )?;
        Ok(Histogram {
            labels,
            buckets,
            store,
        })
    }

    /// The exposition: every family in declaration order with its HELP and TYPE lines; empty when nothing is declared.
    pub fn render(&self) -> String {
        // The callbacks run outside the registry's lock.
        let families = lock(&self.state).families.clone();
        let mut out: Vec<String> = Vec::new();
        for f in &families {
            out.push(format!("# HELP {} {}", f.name, escape_help(&f.help)));
            out.push(format!("# TYPE {} {}", f.name, f.kind));
            out.extend((f.lines)());
        }
        if out.is_empty() {
            String::new()
        } else {
            format!("{}\n", out.join("\n"))
        }
    }
}

fn sample_lines(name: &str, labels: &Labels, store: &Mutex<Store<f64>>) -> Vec<String> {
    lock(store)
        .sorted()
        .into_iter()
        .map(|(values, n)| format!("{name}{} {}", labels.render(values, None), fmt(*n)))
        .collect()
}

/// A strict parser for the Prometheus text exposition format 0.0.4, used only by the metrics tests (the port of
/// `test/metrics/exposition-parser.ts`): it fails on anything a scraper would reject.
#[cfg(test)]
pub(crate) mod exposition {
    use std::collections::{HashMap, HashSet};

    pub struct Sample {
        pub name: String,
        pub labels: HashMap<String, String>,
        pub value: f64,
    }

    pub struct Family {
        pub name: String,
        pub help: String,
        pub kind: String,
        pub samples: Vec<Sample>,
    }

    impl Family {
        pub fn find(&self, f: impl Fn(&Sample) -> bool) -> Option<&Sample> {
            self.samples.iter().find(|s| f(s))
        }
    }

    pub fn family<'a>(families: &'a [Family], name: &str) -> &'a Family {
        families.iter().find(|f| f.name == name).unwrap()
    }

    fn name_ok(s: &str, colon: bool) -> bool {
        let mut chars = s.chars();
        matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_' || (colon && c == ':'))
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || (colon && c == ':'))
    }

    fn parse_labels(src: &[char], line: &str) -> Result<(HashMap<String, String>, usize), String> {
        let mut labels = HashMap::new();
        let mut i = 1; // after "{"
        loop {
            if src.get(i) == Some(&'}') {
                i += 1;
                break;
            }
            let eq = src[i..]
                .iter()
                .position(|c| *c == '=')
                .map(|p| p + i)
                .ok_or_else(|| format!("bad labels: {line}"))?;
            let k: String = src[i..eq].iter().collect();
            if !name_ok(&k, false) {
                return Err(format!("bad label name {k}: {line}"));
            }
            if src.get(eq + 1) != Some(&'"') {
                return Err(format!("label value not quoted: {line}"));
            }
            let mut j = eq + 2;
            let mut v = String::new();
            loop {
                match src.get(j) {
                    None => return Err(format!("unterminated label value: {line}")),
                    Some('\\') => {
                        j += 1;
                        match src.get(j) {
                            Some('n') => v.push('\n'),
                            Some('\\') => v.push('\\'),
                            Some('"') => v.push('"'),
                            _ => return Err(format!("bad escape: {line}")),
                        }
                    }
                    Some('"') => break,
                    Some(c) => v.push(*c),
                }
                j += 1;
            }
            if labels.insert(k.clone(), v).is_some() {
                return Err(format!("duplicate label {k}: {line}"));
            }
            i = j + 1;
            if src.get(i) == Some(&',') {
                i += 1;
            }
        }
        Ok((labels, i))
    }

    fn value_ok(s: &str) -> bool {
        if matches!(s, "+Inf" | "-Inf" | "NaN") {
            return true;
        }
        let s = s.strip_prefix('-').unwrap_or(s);
        let (mantissa, exp) = match s.find(['e', 'E']) {
            Some(at) => (&s[..at], Some(&s[at + 1..])),
            None => (s, None),
        };
        let digits = |t: &str| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit());
        let (int, frac) = match mantissa.split_once('.') {
            Some((i, f)) => (i, Some(f)),
            None => (mantissa, None),
        };
        digits(int)
            && frac.is_none_or(digits)
            && exp.is_none_or(|e| digits(e.strip_prefix(['+', '-']).unwrap_or(e)))
    }

    pub fn parse(text: &str) -> Result<Vec<Family>, String> {
        if !text.ends_with('\n') {
            return Err("exposition must end with a newline".into());
        }
        let mut families: Vec<Family> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let mut current: Option<usize> = None;
        for line in text[..text.len() - 1].split('\n') {
            if line.is_empty() {
                return Err("empty line".into());
            }
            if line.starts_with("# HELP ") {
                let mut parts = line.split(' ').skip(2);
                let name = parts.next().unwrap_or("");
                if name.is_empty() || !name_ok(name, true) {
                    return Err(format!("bad HELP: {line}"));
                }
                if families.iter().any(|f| f.name == name) {
                    return Err(format!("family {name} repeated"));
                }
                let help: Vec<&str> = parts.collect();
                families.push(Family {
                    name: name.into(),
                    help: help.join(" "),
                    kind: String::new(),
                    samples: Vec::new(),
                });
                current = Some(families.len() - 1);
                continue;
            }
            if line.starts_with("# TYPE ") {
                let fields: Vec<&str> = line.split(' ').collect();
                let (name, kind) = (
                    fields.get(2).copied().unwrap_or(""),
                    fields.get(3).copied().unwrap_or(""),
                );
                let ok = fields.len() == 4
                    && !name.is_empty()
                    && name_ok(name, true)
                    && current
                        .is_some_and(|c| families[c].name == name && families[c].kind.is_empty());
                if !ok {
                    return Err(format!("TYPE without HELP or repeated TYPE: {line}"));
                }
                if !["counter", "gauge", "histogram", "summary", "untyped"].contains(&kind) {
                    return Err(format!("bad type: {line}"));
                }
                if kind == "counter" && !name.ends_with("_total") {
                    return Err(format!("counter name must end with _total: {line}"));
                }
                if let Some(c) = current {
                    families[c].kind = kind.into();
                }
                continue;
            }
            if line.starts_with('#') {
                continue;
            }
            let end = line
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == ':'))
                .unwrap_or(line.len());
            let name = &line[..end];
            let c = current.filter(|c| !families[*c].kind.is_empty());
            let (Some(c), true) = (c, name_ok(name, true)) else {
                return Err(format!("bad sample or missing TYPE: {line}"));
            };
            let chars: Vec<char> = line[end..].chars().collect();
            let (labels, used) = if chars.first() == Some(&'{') {
                parse_labels(&chars, line)?
            } else {
                (HashMap::new(), 0)
            };
            let rest: String = chars[used..].iter().collect();
            let parts: Vec<&str> = rest.trim().split(' ').collect();
            if parts.len() != 1 || !value_ok(parts[0]) {
                return Err(format!("bad value: {line}"));
            }
            let family = &mut families[c];
            let base = if family.kind == "histogram" {
                ["_bucket", "_sum", "_count"]
                    .iter()
                    .find_map(|s| name.strip_suffix(s))
                    .unwrap_or(name)
            } else {
                name
            };
            if base != family.name {
                return Err(format!("sample {name} outside its family {}", family.name));
            }
            let mut sorted: Vec<(&String, &String)> = labels.iter().collect();
            sorted.sort();
            let key = format!("{name}{sorted:?}");
            if !seen.insert(key.clone()) {
                return Err(format!("duplicate series {key}"));
            }
            let value = match parts[0] {
                "+Inf" => f64::INFINITY,
                "-Inf" => f64::NEG_INFINITY,
                "NaN" => f64::NAN,
                other => other.parse::<f64>().map_err(|e| e.to_string())?,
            };
            family.samples.push(Sample {
                name: name.into(),
                labels,
                value,
            });
        }
        for f in &families {
            if f.kind.is_empty() {
                return Err(format!("family {} is missing TYPE", f.name));
            }
        }
        Ok(families)
    }
}

#[cfg(test)]
mod tests {
    use super::exposition::{family, parse};
    use super::*;

    fn sp(labels: &[(&str, &[&str])]) -> LabelSpec {
        spec(labels)
    }

    #[test]
    fn renders_counters_gauges_and_histograms_in_a_format_a_strict_parser_accepts() {
        let r = Registry::new();
        let c = r
            .counter(
                "t_calls_total",
                "Calls.",
                &sp(&[("result", &["ok", "error"])]),
                CounterOptions::default(),
            )
            .unwrap();
        c.inc(&[("result", "ok")]);
        c.inc_by(&[("result", "ok")], 2.0);
        c.inc(&[("result", "error")]);
        let g = r.gauge("t_open", "Open things.", &sp(&[])).unwrap();
        g.set(&[], 4.0);
        r.gauge_fn("t_live", "Computed.", || 7.0).unwrap();
        let h = r
            .histogram(
                "t_seconds",
                "Durations.",
                &sp(&[("outcome", &["ok"])]),
                &[0.1, 1.0],
            )
            .unwrap();
        for v in [0.05, 0.5, 5.0] {
            h.observe(&[("outcome", "ok")], v);
        }
        let fams = parse(&r.render()).unwrap();
        let calls = family(&fams, "t_calls_total");
        assert_eq!(calls.kind, "counter");
        assert_eq!(
            calls.find(|s| s.labels["result"] == "ok").unwrap().value,
            3.0
        );
        assert_eq!(family(&fams, "t_open").samples[0].value, 4.0);
        assert_eq!(family(&fams, "t_live").samples[0].value, 7.0);
        let hs = &family(&fams, "t_seconds").samples;
        let buckets: Vec<(String, f64)> = hs
            .iter()
            .filter(|s| s.name == "t_seconds_bucket")
            .map(|s| (s.labels["le"].clone(), s.value))
            .collect();
        assert_eq!(
            buckets,
            vec![
                ("0.1".to_owned(), 1.0),
                ("1".to_owned(), 2.0),
                ("+Inf".to_owned(), 3.0)
            ]
        );
        assert_eq!(
            hs.iter()
                .find(|s| s.name == "t_seconds_count")
                .unwrap()
                .value,
            3.0
        );
        assert_eq!(
            hs.iter().find(|s| s.name == "t_seconds_sum").unwrap().value,
            5.55
        );
    }

    #[test]
    fn folds_a_label_value_outside_its_enumeration_into_other() {
        let r = Registry::new();
        let c = r
            .counter(
                "t_x_total",
                "X.",
                &sp(&[("who", &["a", "b"])]),
                CounterOptions::default(),
            )
            .unwrap();
        for i in 0..1000 {
            let who = format!("user-{i}");
            c.inc(&[("who", who.as_str())]);
        }
        let fams = parse(&r.render()).unwrap();
        assert_eq!(fams[0].samples.len(), 1);
        assert_eq!(fams[0].samples[0].labels["who"], "other");
        assert_eq!(fams[0].samples[0].value, 1000.0);
    }

    fn values(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("v{i}")).collect()
    }

    fn one(name: &str, vals: Vec<String>) -> LabelSpec {
        vec![(name.to_owned(), vals)]
    }

    #[test]
    fn refuses_a_metric_whose_label_space_could_exceed_the_series_cap() {
        let r = Registry::new();
        let big = values(33); // (33 + other)^2 = 1156 > 1024
        let e = r
            .counter(
                "t_big_total",
                "Big.",
                &vec![("a".into(), big.clone()), ("b".into(), big)],
                CounterOptions::default(),
            )
            .err()
            .unwrap();
        assert!(e.0.contains("series"), "{e}");
    }

    #[test]
    fn a_larger_label_space_needs_an_explicit_max_series_and_stays_bounded() {
        let r = Registry::new();
        let vals = values(1024); // n + other = 1025 series
        let e = r
            .counter(
                "t_open_total",
                "x",
                &one("a", vals.clone()),
                CounterOptions::default(),
            )
            .err()
            .unwrap();
        assert!(e.0.contains("exceeds the cap of 1024"), "{e}");
        let with = |max| CounterOptions {
            max_series: Some(max),
        };
        r.counter("t_closed_total", "x", &one("a", vals.clone()), with(1025))
            .unwrap();
        let tight = r
            .counter("t_tight_total", "x", &one("a", vals), with(1024))
            .err()
            .unwrap();
        assert!(tight.0.contains("exceeds the cap"), "{tight}");
        let huge = values(16384);
        let over = r
            .counter("t_huge_total", "x", &one("a", huge.clone()), with(16385))
            .err()
            .unwrap();
        assert!(over.0.contains("maxSeries"), "{over}");
        assert_eq!(
            over.0,
            "t_huge_total: maxSeries must be an integer in 1..16384"
        );
        let zero = r
            .counter("t_zero_total", "x", &sp(&[]), with(0))
            .err()
            .unwrap();
        assert!(zero.0.contains("maxSeries"));
        let beyond = r
            .counter("t_huge2_total", "x", &one("a", huge), with(16384))
            .err()
            .unwrap();
        assert!(beyond.0.contains("exceeds the cap"), "{beyond}");
    }

    #[test]
    fn refuses_invalid_names_and_duplicate_registration() {
        let r = Registry::new();
        let none = CounterOptions::default();
        assert!(r.counter("bad name", "x", &sp(&[]), none).is_err());
        assert_eq!(
            r.counter("bad name", "x", &sp(&[]), none).err().unwrap().0,
            "invalid metric name \"bad name\""
        );
        assert_eq!(
            r.counter("t_ok_total", "x", &sp(&[("bad-label", &["a"])]), none)
                .err()
                .unwrap()
                .0,
            "invalid label name \"bad-label\" on t_ok_total"
        );
        assert!(r
            .counter("t_ok_total", "x", &sp(&[("le", &["a"])]), none)
            .is_err());
        assert!(r
            .counter("t_ok_total", "x", &sp(&[("__x", &["a"])]), none)
            .is_err());
        r.counter("t_dup_total", "x", &sp(&[]), none).unwrap();
        assert_eq!(
            r.counter("t_dup_total", "x", &sp(&[]), none)
                .err()
                .unwrap()
                .0,
            "metric t_dup_total is already registered (t_dup_total is in use)"
        );
    }

    #[test]
    fn escapes_label_values_and_help_text() {
        let r = Registry::new();
        let v = "a\"b\\c\nd";
        r.counter(
            "t_esc_total",
            "Line1\nLine2 \\ end.",
            &sp(&[("v", &[v])]),
            CounterOptions::default(),
        )
        .unwrap()
        .inc(&[("v", v)]);
        let text = r.render();
        assert_eq!(
            text,
            "# HELP t_esc_total Line1\\nLine2 \\\\ end.\n# TYPE t_esc_total counter\nt_esc_total{v=\"a\\\"b\\\\c\\nd\"} 1\n"
        );
        let fams = parse(&text).unwrap();
        assert_eq!(fams[0].samples[0].labels["v"], v);
        assert_eq!(fams[0].help, "Line1\\nLine2 \\\\ end.");
    }

    #[test]
    fn ignores_negative_counter_increments_and_non_finite_observations() {
        let r = Registry::new();
        let c = r
            .counter("t_n_total", "N.", &sp(&[]), CounterOptions::default())
            .unwrap();
        c.inc_by(&[], -5.0);
        c.inc_by(&[], f64::NAN);
        c.inc_by(&[], f64::INFINITY);
        c.inc(&[]);
        let h = r.histogram("t_h_seconds", "H.", &sp(&[]), &[1.0]).unwrap();
        h.init_all();
        h.observe(&[], f64::NAN);
        h.observe(&[], -1.0);
        let fams = parse(&r.render()).unwrap();
        assert_eq!(fams[0].samples[0].value, 1.0);
        assert_eq!(
            fams[1]
                .samples
                .iter()
                .find(|s| s.name == "t_h_seconds_count")
                .unwrap()
                .value,
            0.0
        );
    }

    #[test]
    fn a_metric_named_like_a_histograms_own_series_is_refused_both_ways() {
        for suffix in ["_bucket", "_sum", "_count"] {
            let r = Registry::new();
            r.histogram("job_seconds", "h", &sp(&[]), &[1.0, 2.0])
                .unwrap();
            let e = r
                .counter(
                    &format!("job_seconds{suffix}"),
                    "c",
                    &sp(&[]),
                    CounterOptions::default(),
                )
                .err()
                .unwrap();
            assert!(e.0.contains("already"), "{e}");
            let r = Registry::new();
            r.counter(
                &format!("job_seconds{suffix}"),
                "c",
                &sp(&[]),
                CounterOptions::default(),
            )
            .unwrap();
            let e = r
                .histogram("job_seconds", "h", &sp(&[]), &[1.0, 2.0])
                .err()
                .unwrap();
            assert!(e.0.contains("already"), "{e}");
        }
    }

    #[test]
    fn buckets_must_be_finite_and_strictly_ascending() {
        let r = Registry::new();
        for bad in [
            &[][..],
            &[1.0, 1.0][..],
            &[2.0, 1.0][..],
            &[f64::NAN][..],
            &[1.0, f64::INFINITY][..],
        ] {
            assert_eq!(
                r.histogram("t_b_seconds", "h", &sp(&[]), bad)
                    .err()
                    .unwrap()
                    .0,
                "t_b_seconds: buckets must be finite and strictly ascending"
            );
        }
    }

    #[test]
    fn a_panicking_or_non_finite_gauge_fn_is_skipped() {
        let r = Registry::new();
        r.gauge_fn("t_panics", "p", || panic!("boom")).unwrap();
        r.gauge_fn("t_nan", "n", || f64::NAN).unwrap();
        r.gauge_fn("t_inf", "i", || f64::INFINITY).unwrap();
        r.gauge_fn("t_ok", "o", || 2.5).unwrap();
        let text = r.render();
        assert!(
            text.contains("# TYPE t_panics gauge\n# HELP t_nan"),
            "{text}"
        );
        assert!(text.ends_with("t_ok 2.5\n"), "{text}");
        assert_eq!(Registry::new().render(), "");
    }

    #[test]
    fn js_number_formatting() {
        let cases: &[(f64, &str)] = &[
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.0, "-1"),
            (1.5, "1.5"),
            (100.0, "100"),
            (0.1 + 0.2, "0.30000000000000004"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (123456789012345680000.0, "123456789012345680000"),
            (0.000001, "0.000001"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (5e-324, "5e-324"),
            (f64::MAX, "1.7976931348623157e+308"),
            (-1e21, "-1e+21"),
            (4503599627370496.0, "4503599627370496"),
            (0.5, "0.5"),
            (12345.678, "12345.678"),
        ];
        for (n, want) in cases {
            assert_eq!(js_number_to_string(*n), *want, "{n:e}");
        }
        assert_eq!(fmt(f64::INFINITY), "+Inf");
        assert_eq!(fmt(f64::NEG_INFINITY), "-Inf");
        assert_eq!(fmt(f64::NAN), "NaN");
    }

    #[test]
    fn series_are_sorted_like_icu_locale_compare() {
        assert_eq!(locale_compare("a", "A"), Ordering::Less);
        assert_eq!(locale_compare("a", "B"), Ordering::Less);
        assert_eq!(locale_compare("_", "-"), Ordering::Less);
        assert_eq!(locale_compare("-", "0"), Ordering::Less);
        assert_eq!(locale_compare("9", "a"), Ordering::Less);
        assert_eq!(locale_compare("ab", "a\u{0}b"), Ordering::Equal);
        assert_eq!(locale_compare("a\u{0}c", "ab"), Ordering::Greater);
        assert_eq!(
            locale_compare("openai", "openai_compatible"),
            Ordering::Less
        );
    }
}

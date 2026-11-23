//! Discord Gateway v10 frames, session recovery, and heartbeat scheduling.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

pub const FATAL_CLOSE_CODES: &[u16] = &[4004, 4010, 4011, 4012, 4013, 4014];
const HELLO_TIMEOUT_MS: u64 = 20_000;
const MAX_FRAME_UNITS: usize = 4 * 1024 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub session_id: String,
    pub seq: u64,
    pub resume_gateway_url: String,
    pub bot_id: String,
}

pub enum Event {
    Send(String),
    Dispatch(String, Value),
    Ready {
        session_id: String,
        bot_id: String,
        application_id: Option<String>,
        resumed: bool,
    },
    Close {
        code: u16,
        reason: &'static str,
    },
    Persist,
}

pub enum Recovery {
    Fatal(u16),
    Retry { wait_ms: u64, session_changed: bool },
}

pub struct Gateway<'a> {
    token: &'a str,
    intents: u64,
    host_os: &'a str,
    bot_id: &'a str,
    session: Option<Session>,
    sequence: Option<u64>,
    started: u64,
    hello: Option<Heartbeat>,
    ready: bool,
    failures: u32,
}

struct Heartbeat {
    interval: u64,
    next: u64,
    acked: bool,
}

#[derive(Serialize)]
struct Wire<T> {
    op: u8,
    d: T,
}

#[derive(Serialize)]
struct Identify<'a> {
    token: &'a str,
    intents: u64,
    properties: Properties<'a>,
}

#[derive(Serialize)]
struct Properties<'a> {
    os: &'a str,
    browser: &'static str,
    device: &'static str,
}

#[derive(Serialize)]
struct Resume<'a> {
    token: &'a str,
    session_id: &'a str,
    seq: u64,
}

impl<'a> Gateway<'a> {
    pub fn new(
        token: &'a str,
        intents: u64,
        host_os: &'a str,
        bot_id: &'a str,
        session: Option<Session>,
    ) -> Self {
        let sequence = session.as_ref().map(|s| s.seq);
        Self {
            token,
            intents,
            host_os,
            bot_id,
            session,
            sequence,
            started: 0,
            hello: None,
            ready: false,
            failures: 0,
        }
    }

    pub fn open(&mut self, now: u64) {
        self.started = now;
        self.hello = None;
        self.ready = false;
    }

    pub fn endpoint(&self, base: &Url) -> Option<Url> {
        let resume = self
            .session
            .as_ref()
            .and_then(|session| resume_candidate(&session.resume_gateway_url));
        let target = resume.as_ref().unwrap_or(base);
        Url::parse(&format!(
            "{}/?v=10&encoding=json",
            target.as_str().trim_end_matches('/')
        ))
        .ok()
    }

    pub fn session(&self) -> Option<Session> {
        self.session.clone().map(|mut session| {
            session.seq = self.sequence.unwrap_or(session.seq);
            session
        })
    }

    pub fn next_deadline(&self) -> u64 {
        self.hello.as_ref().map_or_else(
            || self.started.saturating_add(HELLO_TIMEOUT_MS),
            |state| state.next,
        )
    }

    pub fn tick(&mut self, now: u64) -> Option<Event> {
        if now < self.next_deadline() {
            return None;
        }
        let Some(heartbeat) = &mut self.hello else {
            return Some(close("hello-timeout"));
        };
        if !heartbeat.acked {
            return Some(close("zombie"));
        }
        heartbeat.next = now.saturating_add(heartbeat.interval);
        heartbeat.acked = false;
        wire(1, self.sequence)
    }

    pub fn receive(&mut self, raw: &str, now: u64, random: f64, base: &Url) -> Vec<Event> {
        if raw.encode_utf16().take(MAX_FRAME_UNITS + 1).count() > MAX_FRAME_UNITS {
            return Vec::new();
        }
        let Ok(frame) = serde_json::from_str::<Value>(raw) else {
            return Vec::new();
        };
        if let Some(seq) = frame["s"].as_u64() {
            self.sequence = Some(seq);
        }
        match frame["op"].as_u64() {
            Some(10) => self.hello(&frame["d"], now, random).into_iter().collect(),
            Some(11) => {
                if let Some(heartbeat) = &mut self.hello {
                    heartbeat.acked = true;
                }
                Vec::new()
            }
            Some(1) => wire(1, self.sequence).into_iter().collect(),
            Some(7) => vec![close("reconnect")],
            Some(9) if frame["d"] != true => {
                self.session = None;
                self.sequence = None;
                vec![Event::Persist, close("invalid-session")]
            }
            Some(9) => vec![close("invalid-session")],
            Some(0) => self.dispatch(&frame, base),
            _ => Vec::new(),
        }
    }

    pub fn closed(
        &mut self,
        code: u16,
        reason: &str,
        now: u64,
        random: f64,
        max_wait_ms: u64,
    ) -> Recovery {
        if FATAL_CLOSE_CODES.contains(&code) {
            self.session = None;
            self.sequence = None;
            return Recovery::Fatal(code);
        }
        let session_changed = matches!(code, 4007 | 4009);
        if session_changed {
            self.session = None;
            self.sequence = None;
        }
        let stable = self.ready && now.saturating_sub(self.started) >= 5000;
        self.failures = if stable {
            0
        } else {
            self.failures.saturating_add(1)
        };
        let random = random.clamp(0., 1.);
        let wait_ms = if reason == "invalid-session" {
            1000 + (random * 4000.).floor() as u64
        } else if stable && matches!(reason, "reconnect" | "zombie") {
            0
        } else {
            let base = max_wait_ms.min(1000u64 << self.failures.saturating_sub(1).min(10));
            let jittered = (base as f64 * (0.75 + random * 0.5)).round() as u64;
            if code == 4008 {
                jittered.max(5000)
            } else {
                jittered
            }
        };
        Recovery::Retry {
            wait_ms,
            session_changed,
        }
    }

    fn hello(&mut self, data: &Value, now: u64, random: f64) -> Option<Event> {
        let interval = data["heartbeat_interval"]
            .as_f64()
            .filter(|ms| (1000. ..=600_000.).contains(ms));
        let Some(ms) = interval.filter(|_| self.hello.is_none()) else {
            return Some(close("close"));
        };
        self.hello = Some(Heartbeat {
            interval: ms as u64,
            acked: true,
            next: now.saturating_add((ms * random.clamp(0., 1.)).floor() as u64),
        });
        if let Some(session) = &self.session {
            wire(
                6,
                Resume {
                    token: self.token,
                    session_id: &session.session_id,
                    seq: self.sequence.unwrap_or(session.seq),
                },
            )
        } else {
            wire(
                2,
                Identify {
                    token: self.token,
                    intents: self.intents,
                    properties: Properties {
                        os: self.host_os,
                        browser: "plur1bus",
                        device: "plur1bus",
                    },
                },
            )
        }
    }

    fn dispatch(&mut self, frame: &Value, base: &Url) -> Vec<Event> {
        let d = &frame["d"];
        match frame["t"].as_str() {
            Some("READY") => {
                let Some((bot_id, session_id)) =
                    d["user"]["id"].as_str().zip(d["session_id"].as_str())
                else {
                    return Vec::new();
                };
                let resume_gateway_url = d["resume_gateway_url"]
                    .as_str()
                    .filter(|raw| resume_candidate(raw).is_some())
                    .unwrap_or(base.as_str())
                    .to_owned();
                self.session = Some(Session {
                    bot_id: bot_id.to_owned(),
                    session_id: session_id.to_owned(),
                    resume_gateway_url,
                    seq: self.sequence.unwrap_or_default(),
                });
                self.ready = true;
                vec![
                    Event::Persist,
                    Event::Ready {
                        session_id: session_id.to_owned(),
                        bot_id: bot_id.to_owned(),
                        application_id: d["application"]["id"].as_str().map(str::to_owned),
                        resumed: false,
                    },
                ]
            }
            Some("RESUMED") => {
                self.ready = true;
                let (bot_id, session_id) = self
                    .session
                    .as_ref()
                    .map_or((self.bot_id, ""), |s| (&*s.bot_id, &*s.session_id));
                let mut events = vec![Event::Ready {
                    session_id: session_id.to_owned(),
                    bot_id: bot_id.to_owned(),
                    application_id: None,
                    resumed: true,
                }];
                if self.session.is_some() {
                    events.push(Event::Persist);
                }
                events
            }
            Some(event) => {
                let mut events = Vec::with_capacity(2);
                if self.session.is_some() && self.sequence.is_some_and(|seq| seq % 50 == 0) {
                    events.push(Event::Persist);
                }
                let bot_id = self
                    .session
                    .as_ref()
                    .map_or(self.bot_id, |session| &session.bot_id);
                if event != "MESSAGE_CREATE" || eligible_message(d, bot_id) {
                    events.push(Event::Dispatch(event.to_owned(), d.clone()));
                }
                events
            }
            None => Vec::new(),
        }
    }
}

fn eligible_message(message: &Value, bot_id: &str) -> bool {
    let author = &message["author"];
    author["id"].as_str().is_some_and(|id| id != bot_id)
        && author["bot"] != true
        && matches!(message["type"].as_u64(), Some(0 | 19))
}

fn resume_candidate(raw: &str) -> Option<Url> {
    if raw.encode_utf16().take(257).count() > 256 {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    let host = url.host_str()?;
    (url.scheme() == "wss"
        && url.username().is_empty()
        && url.password().is_none()
        && ["discord.gg", "discord.media"].iter().any(|domain| {
            host == *domain
                || host
                    .strip_suffix(domain)
                    .is_some_and(|prefix| prefix.ends_with('.'))
        }))
    .then_some(url)
}

fn wire(disc: u8, data: impl Serialize) -> Option<Event> {
    serde_json::to_string(&Wire { op: disc, d: data })
        .ok()
        .map(Event::Send)
}

fn close(reason: &'static str) -> Event {
    Event::Close { code: 4000, reason }
}

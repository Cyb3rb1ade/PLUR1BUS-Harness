//! Sequential IMAP commands, literals, UID and IDLE handling.
use super::wire::Wire;
use super::{Error, Kind, Options, Ports, Security};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::collections::BTreeSet;
use std::time::{Duration, Instant};

const MAX_LITERAL: usize = 50 * 1024 * 1024;
const MAX_LOGICAL: usize = 64 * 1024 * 1024;
const MAX_RESPONSES: usize = 8192;
const IDLE_MAX: Duration = Duration::from_secs(25 * 60);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Status {
    Ok,
    No,
    Bad,
}

struct Response {
    text: String,
    literals: Vec<Vec<u8>>,
}

struct Tagged {
    status: Status,
    untagged: Vec<Response>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub uid_validity: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uid_next: Option<u64>,
    pub exists: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Idle {
    Event,
    Timeout,
}

pub struct Connection {
    wire: Wire,
    tag: u64,
}

pub type Capabilities = BTreeSet<String>;

fn quote(value: &str) -> Result<String, Error> {
    if value.contains(['\r', '\n', '\0']) {
        return Err(Error::new(
            Kind::Protocol,
            "invalid character in IMAP argument",
        ));
    }
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    for ch in value.chars() {
        if matches!(ch, '"' | '\\') {
            quoted.push('\\');
        }
        quoted.push(ch);
    }
    quoted.push('"');
    Ok(quoted)
}

fn strip_prefix_case<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    line.get(..prefix.len())
        .filter(|p| p.eq_ignore_ascii_case(prefix))
        .and_then(|_| line.get(prefix.len()..))
}

fn bye(line: &str) -> bool {
    strip_prefix_case(line, "* BYE").is_some()
}

fn status(line: &str, tag: &str) -> Result<Option<Status>, Error> {
    let Some(rest) = line.strip_prefix(tag).and_then(|s| s.strip_prefix(' ')) else {
        return Ok(None);
    };
    match rest
        .split_ascii_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase()
        .as_str()
    {
        "OK" => Ok(Some(Status::Ok)),
        "NO" => Ok(Some(Status::No)),
        "BAD" => Ok(Some(Status::Bad)),
        _ => Err(Error::new(Kind::Protocol, "malformed IMAP status")),
    }
}

pub fn open(
    ports: &dyn Ports,
    opt: &Options<'_>,
    folder: &str,
) -> Result<(Connection, Capabilities, Selection), Error> {
    let mut conn = Connection {
        wire: Wire::open(ports, opt, "IMAP connection failed")?,
        tag: 0,
    };
    let greeting = conn.response()?;
    if bye(&greeting.text) {
        return Err(Error::new(Kind::Network, "server refused connection"));
    }
    let greet = greeting.text.split_ascii_whitespace().nth(1);
    if !greeting.text.starts_with("* ")
        || !greet.is_some_and(|s| s.eq_ignore_ascii_case("OK") || s.eq_ignore_ascii_case("PREAUTH"))
    {
        return Err(Error::new(Kind::Protocol, "unexpected IMAP greeting"));
    }
    if matches!(opt.security, Security::StartTls) {
        if !conn.capabilities()?.contains("STARTTLS") {
            return Err(Error::new(
                Kind::Tls,
                "server does not offer STARTTLS; credentials not sent",
            ));
        }
        if conn.command("STARTTLS", None)?.status != Status::Ok {
            return Err(Error::new(Kind::Tls, "STARTTLS refused"));
        }
        conn = Connection {
            wire: conn.wire.upgrade(ports, opt.host)?,
            tag: conn.tag,
        };
    }
    let caps = conn.capabilities()?;
    conn.authenticate(opt.user, opt.password, &caps)?;
    let caps = conn.capabilities()?;
    let selection = conn.select(folder)?;
    Ok((conn, caps, selection))
}

impl Connection {
    fn response(&mut self) -> Result<Response, Error> {
        let mut text = String::new();
        let mut literals = Vec::new();
        let mut total: usize = 0;
        loop {
            let line = self.wire.line(65_536)?;
            let literal = line
                .strip_suffix('}')
                .and_then(|line| line.rsplit_once('{'))
                .filter(|(_, size)| {
                    (1..=9).contains(&size.len()) && size.bytes().all(|b| b.is_ascii_digit())
                });
            let Some((prefix, size)) = literal else {
                text.push_str(&line);
                break;
            };
            let size = size
                .parse::<usize>()
                .map_err(|_| Error::new(Kind::Protocol, "IMAP literal too large"))?;
            total = total.saturating_add(size).saturating_add(prefix.len());
            if size > MAX_LITERAL || total > MAX_LOGICAL || literals.len() >= MAX_RESPONSES {
                return Err(Error::new(Kind::Protocol, "IMAP literal too large"));
            }
            text.push_str(prefix);
            text.push_str(&format!("{{#{}}}", literals.len()));
            literals.push(self.wire.bytes(size)?);
        }
        Ok(Response { text, literals })
    }

    fn begin(&mut self, command: &str) -> Result<String, Error> {
        self.tag = self
            .tag
            .checked_add(1)
            .ok_or_else(|| Error::new(Kind::State, "IMAP tag space exhausted"))?;
        let tag = format!("A{:04}", self.tag);
        self.wire.reset_deadline();
        self.wire.write_line(&format!("{tag} {command}"))?;
        Ok(tag)
    }

    fn command(&mut self, command: &str, mut continuation: Option<&str>) -> Result<Tagged, Error> {
        let tag = self.begin(command)?;
        let mut untagged = Vec::new();
        let mut total = 0usize;
        loop {
            let response = self.response()?;
            if response.text.starts_with('+') {
                let answer = continuation
                    .take()
                    .ok_or_else(|| Error::new(Kind::Protocol, "unexpected IMAP continuation"))?;
                self.wire.write_line(answer)?;
            } else if response.text.starts_with("* ") {
                if bye(&response.text) {
                    return Err(Error::new(Kind::Network, "server closed the connection"));
                }
                total = total
                    .saturating_add(response.text.len())
                    .saturating_add(response.literals.iter().map(Vec::len).sum());
                if total > MAX_LOGICAL || untagged.len() >= MAX_RESPONSES {
                    return Err(Error::new(Kind::Protocol, "IMAP response too large"));
                }
                untagged.push(response);
            } else if let Some(status) = status(&response.text, &tag)? {
                return Ok(Tagged { status, untagged });
            } else {
                return Err(Error::new(Kind::Protocol, "unexpected IMAP response"));
            }
        }
    }

    fn authenticate(
        &mut self,
        user: &str,
        password: &str,
        caps: &Capabilities,
    ) -> Result<(), Error> {
        let result = if caps.contains("AUTH=PLAIN") {
            let answer = STANDARD.encode(format!("\0{user}\0{password}"));
            self.command("AUTHENTICATE PLAIN", Some(&answer))?
        } else if !caps.contains("LOGINDISABLED") {
            self.command(
                &format!("LOGIN {} {}", quote(user)?, quote(password)?),
                None,
            )?
        } else {
            return Err(Error::new(
                Kind::Auth,
                "no usable IMAP authentication mechanism",
            ));
        };
        if result.status != Status::Ok {
            return Err(Error::new(Kind::Auth, "IMAP authentication failed"));
        }
        Ok(())
    }

    pub fn capabilities(&mut self) -> Result<Capabilities, Error> {
        let result = self.ok("CAPABILITY", "CAPABILITY failed")?;
        Ok(result
            .untagged
            .iter()
            .filter_map(|r| strip_prefix_case(&r.text, "* CAPABILITY "))
            .flat_map(str::split_ascii_whitespace)
            .map(str::to_ascii_uppercase)
            .collect())
    }

    pub fn select(&mut self, folder: &str) -> Result<Selection, Error> {
        let result = self.command(&format!("SELECT {}", quote(folder)?), None)?;
        if result.status != Status::Ok {
            return Err(Error::new(Kind::Unavailable, "mailbox unavailable"));
        }
        let mut uid_validity: Option<u64> = None;
        let mut uid_next = None;
        let mut exists = 0;
        for r in result.untagged {
            let text = r.text.to_ascii_uppercase();
            if let Some(prefix) = text.strip_prefix("* ") {
                if let Some((n, _)) = prefix.split_once(" EXISTS") {
                    exists = n.parse().unwrap_or(exists);
                }
            }
            if let Some((_, rest)) = text.split_once("[UIDVALIDITY ") {
                uid_validity = rest.split_once(']').and_then(|(n, _)| n.parse().ok());
            }
            if let Some((_, rest)) = text.split_once("[UIDNEXT ") {
                uid_next = rest.split_once(']').and_then(|(n, _)| n.parse().ok());
            }
        }
        let uid_validity = uid_validity
            .filter(|value| *value < (1u64 << 53))
            .ok_or_else(|| Error::new(Kind::Protocol, "mailbox has no UIDVALIDITY"))?;
        Ok(Selection {
            uid_validity,
            uid_next,
            exists,
        })
    }

    pub fn uids_above(&mut self, uid: u64) -> Result<Vec<u64>, Error> {
        let start = uid
            .checked_add(1)
            .ok_or_else(|| Error::new(Kind::Protocol, "invalid UID"))?;
        let mut uids: Vec<_> = self
            .ok(&format!("UID SEARCH UID {start}:*"), "UID SEARCH failed")?
            .untagged
            .iter()
            .filter_map(|r| strip_prefix_case(&r.text, "* SEARCH"))
            .flat_map(str::split_ascii_whitespace)
            .filter_map(|item| item.parse::<u64>().ok())
            .filter(|number| *number > uid && *number < (1u64 << 53))
            .collect();
        uids.sort_unstable();
        Ok(uids)
    }

    pub fn fetch_size(&mut self, uid: u64) -> Result<u64, Error> {
        let result = self.ok(
            &format!("UID FETCH {uid} (RFC822.SIZE)"),
            "UID FETCH failed",
        )?;
        result
            .untagged
            .into_iter()
            .find_map(|r| {
                let text = r.text.to_ascii_uppercase();
                let (_, tail) = text.split_once("RFC822.SIZE ")?;
                tail.split(|c: char| !c.is_ascii_digit())
                    .next()?
                    .parse()
                    .ok()
            })
            .ok_or_else(|| Error::new(Kind::Protocol, "message size unavailable"))
    }

    pub fn fetch_raw(&mut self, uid: u64) -> Result<Vec<u8>, Error> {
        let result = self.ok(
            &format!("UID FETCH {uid} (BODY.PEEK[])"),
            "UID FETCH failed",
        )?;
        result
            .untagged
            .into_iter()
            .find(|r| r.literals.len() == 1 && r.text.to_ascii_uppercase().contains("BODY[]"))
            .and_then(|mut r| r.literals.pop())
            .ok_or_else(|| Error::new(Kind::Protocol, "message body unavailable"))
    }

    pub fn mark_seen(&mut self, uid: u64) -> Result<(), Error> {
        self.ok(
            &format!("UID STORE {uid} +FLAGS.SILENT (\\Seen)"),
            "UID STORE failed",
        )
        .map(|_| ())
    }

    pub fn idle(&mut self, budget: Duration) -> Result<Idle, Error> {
        let tag = self.begin("IDLE")?;
        loop {
            let frame = self.response()?;
            if frame.text.starts_with('+') {
                break;
            }
            if status(&frame.text, &tag)?.is_some() {
                return Err(Error::new(Kind::Protocol, "IDLE refused"));
            }
            if bye(&frame.text) {
                return Err(Error::new(Kind::Network, "server closed the connection"));
            }
        }
        self.wire.deadline_at(Instant::now() + budget.min(IDLE_MAX));
        let reason = loop {
            match self.response() {
                Ok(frame) => {
                    if let Some(status) = status(&frame.text, &tag)? {
                        return idle_result(status, Idle::Timeout);
                    }
                    if bye(&frame.text) {
                        return Err(Error::new(Kind::Network, "server closed the connection"));
                    }
                    let mut fields = frame.text.split_ascii_whitespace();
                    if fields.next() == Some("*")
                        && fields.next().is_some_and(|s| s.parse::<u64>().is_ok())
                        && fields.next().is_some_and(|s| {
                            matches!(
                                s.to_ascii_uppercase().as_str(),
                                "EXISTS" | "EXPUNGE" | "RECENT"
                            )
                        })
                    {
                        break Idle::Event;
                    }
                }
                Err(error) if error.kind == Kind::Timeout => break Idle::Timeout,
                Err(error) => return Err(error),
            }
        };
        self.wire.reset_deadline();
        self.wire.write_line("DONE")?;
        loop {
            let frame = self.response()?;
            if let Some(status) = status(&frame.text, &tag)? {
                return idle_result(status, reason);
            }
            if bye(&frame.text) {
                return Err(Error::new(Kind::Network, "server closed the connection"));
            }
        }
    }

    fn ok(&mut self, command: &str, failure: &'static str) -> Result<Tagged, Error> {
        let result = self.command(command, None)?;
        if result.status == Status::Ok {
            Ok(result)
        } else {
            Err(Error::new(Kind::Protocol, failure))
        }
    }
}

fn idle_result(status: Status, reason: Idle) -> Result<Idle, Error> {
    if status == Status::Ok {
        Ok(reason)
    } else {
        Err(Error::new(Kind::Protocol, "IDLE failed"))
    }
}

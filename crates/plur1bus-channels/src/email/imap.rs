//! Sequential IMAP commands, literals, UID and IDLE handling.
use super::wire::Wire;
use super::{Error, Kind, Options, Ports, Security};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::collections::BTreeSet;
use std::time::{Duration, Instant};

const MAX_LITERAL: usize = 50 * 1024 * 1024;
const MAX_LOGICAL: usize = 64 * 1024 * 1024;
const MAX_METADATA: usize = 1024 * 1024;
const MAX_RESPONSES: usize = 8192;
// 4,096 decimal 32-bit UIDs plus separators fit on a 64-KiB SEARCH line.
const UID_PAGE: u64 = 4096;
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
    limited: bool,
    untagged: Vec<Response>,
}

#[derive(Clone, Copy)]
struct ResponseBudget {
    metadata: usize,
    logical: usize,
}

impl Default for ResponseBudget {
    fn default() -> Self {
        Self {
            metadata: MAX_METADATA,
            logical: MAX_LOGICAL,
        }
    }
}

impl ResponseBudget {
    fn line_limit(&self) -> usize {
        self.metadata.min(self.logical).min(65_536)
    }

    fn add_metadata(&mut self, bytes: usize) -> Result<(), Error> {
        let large = || Error::new(Kind::Protocol, "IMAP response too large");
        self.metadata = self.metadata.checked_sub(bytes).ok_or_else(large)?;
        self.logical = self.logical.checked_sub(bytes).ok_or_else(large)?;
        Ok(())
    }

    fn add_literal(&mut self, bytes: usize, count: usize) -> Result<(), Error> {
        if bytes > MAX_LITERAL || bytes > self.logical || count >= MAX_RESPONSES {
            return Err(Error::new(Kind::Protocol, "IMAP literal too large"));
        }
        self.logical -= bytes;
        Ok(())
    }
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

#[derive(Default)]
struct Mailbox {
    exists: u64,
    generation: u64,
    // (last delivered UID, sequence number of its successor)
    continuation: Option<(u64, u64)>,
    scanned: bool,
}

impl Mailbox {
    fn observe(&mut self, line: &str) {
        let Some((number, event)) = line.strip_prefix("* ").and_then(|s| s.split_once(' ')) else {
            return;
        };
        let Ok(number) = number.parse::<u32>() else {
            return;
        };
        if event.eq_ignore_ascii_case("EXISTS") {
            self.exists = number.into();
        } else if event.eq_ignore_ascii_case("EXPUNGE") {
            self.exists = self.exists.saturating_sub(1);
            self.invalidate();
        }
    }

    fn invalidate(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.continuation = None;
    }
}

pub struct Connection {
    wire: Wire,
    tag: u64,
    mailbox: Mailbox,
    response_budget: ResponseBudget,
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
        mailbox: Mailbox::default(),
        response_budget: ResponseBudget::default(),
    };
    let greeting = conn.response(&mut ResponseBudget::default())?;
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
            mailbox: Mailbox::default(),
            response_budget: ResponseBudget::default(),
        };
    }
    let caps = conn.capabilities()?;
    conn.authenticate(opt.user, opt.password, &caps)?;
    let caps = conn.capabilities()?;
    let selection = conn.select(folder)?;
    Ok((conn, caps, selection))
}

impl Connection {
    fn response(&mut self, budget: &mut ResponseBudget) -> Result<Response, Error> {
        let mut text = String::new();
        let mut literals = Vec::new();
        loop {
            let line = self.wire.line(budget.line_limit()).inspect_err(|_| {
                if !literals.is_empty() {
                    self.wire.close();
                }
            })?;
            budget.add_metadata(line.len())?;
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
            budget.add_literal(size, literals.len())?;
            text.push_str(prefix);
            text.push_str(&format!("{{#{}}}", literals.len()));
            literals.push(self.wire.bytes(size)?);
        }
        self.mailbox.observe(&text);
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
        let mut budget = self.response_budget;
        loop {
            let response = self.response(&mut budget)?;
            if response.text.starts_with('+') {
                let answer = continuation
                    .take()
                    .ok_or_else(|| Error::new(Kind::Protocol, "unexpected IMAP continuation"))?;
                self.wire.write_line(answer)?;
            } else if response.text.starts_with("* ") {
                if bye(&response.text) {
                    return Err(Error::new(Kind::Network, "server closed the connection"));
                }
                check_untagged_count(untagged.len())?;
                untagged.push(response);
            } else if let Some(status) = status(&response.text, &tag)? {
                let limited = response
                    .text
                    .split_ascii_whitespace()
                    .nth(2)
                    .is_some_and(|code| code.eq_ignore_ascii_case("[LIMIT]"));
                return Ok(Tagged {
                    status,
                    limited,
                    untagged,
                });
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
        self.mailbox.exists = u32::try_from(exists)
            .map_err(|_| Error::new(Kind::Protocol, "invalid mailbox size"))?
            .into();
        self.mailbox.invalidate();
        self.mailbox.scanned = false;
        Ok(Selection {
            uid_validity,
            uid_next,
            exists,
        })
    }

    pub fn uids_above(&mut self, uid: u64) -> Result<Vec<u64>, Error> {
        let mut result = Vec::new();
        let mut cursor = uid;
        self.for_each_uid_page(&mut cursor, |_, page| {
            result.extend_from_slice(page);
            Ok(())
        })?;
        Ok(result)
    }

    /// Deliver at most 4,096 messages per call. Resume with the last committed UID.
    pub fn for_each_uid_page(
        &mut self,
        cursor: &mut u64,
        mut process: impl FnMut(&mut Self, &[u64]) -> Result<(), Error>,
    ) -> Result<(), Error> {
        if *cursor > u64::from(u32::MAX) {
            return Err(Error::new(Kind::Protocol, "invalid UID"));
        }
        let cached = self.mailbox.continuation.filter(|(uid, _)| uid == cursor);
        if self.mailbox.scanned && cached.is_none_or(|(_, seq)| seq > self.mailbox.exists) {
            self.ok("NOOP", "mailbox refresh failed")?;
        }
        self.mailbox.scanned = true;
        let upper = self.mailbox.exists;
        let mut first = match self.mailbox.continuation {
            Some((uid, seq)) if uid == *cursor => seq,
            _ => self.first_sequence_after(*cursor, upper)?,
        };
        let stop = upper.min(first + UID_PAGE - 1);
        let mut width = UID_PAGE;
        while first <= stop {
            let last = stop.min(first + width - 1);
            let Some(ids) = self.sequence_page(first, last)? else {
                width = (last - first + 1).div_ceil(2);
                continue;
            };
            let newest = *ids
                .last()
                .ok_or_else(|| Error::new(Kind::Protocol, "missing UID"))?;
            if ids[0] <= *cursor {
                return Err(Error::new(Kind::Protocol, "unexpected UID order"));
            }
            let generation = self.mailbox.generation;
            process(self, &ids)?;
            *cursor = newest;
            if self.mailbox.generation != generation {
                return Ok(());
            }
            first = last + 1;
            self.mailbox.continuation = Some((newest, first));
        }
        Ok(())
    }

    // UIDs increase with sequence number. Locate a persisted cursor even if its
    // message was expunged. Subsequent pages on this selection use the cached sequence.
    fn first_sequence_after(&mut self, cursor: u64, upper: u64) -> Result<u64, Error> {
        if upper == 0 || cursor == 0 || self.sequence_uid(1)? > cursor {
            return Ok(1);
        }
        let mut low = 2;
        let mut high = upper + 1;
        while low < high {
            let mid = low + (high - low) / 2;
            if self.sequence_uid(mid)? > cursor {
                high = mid;
            } else {
                low = mid + 1;
            }
        }
        Ok(low)
    }

    fn sequence_uid(&mut self, sequence: u64) -> Result<u64, Error> {
        self.sequence_page(sequence, sequence)?
            .and_then(|ids| ids.first().copied())
            .ok_or_else(|| Error::new(Kind::Protocol, "missing UID"))
    }

    fn sequence_page(&mut self, first: u64, last: u64) -> Result<Option<Vec<u64>>, Error> {
        let generation = self.mailbox.generation;
        let reply = self.command(&format!("UID SEARCH {first}:{last}"), None)?;
        if self.mailbox.generation != generation {
            return Err(Error::new(Kind::State, "mailbox changed during search"));
        }
        if reply.status != Status::Ok {
            if reply.limited && last > first {
                return Ok(None);
            }
            return Err(Error::new(Kind::Protocol, "UID SEARCH failed"));
        }
        let ids = search_uids(&reply)?;
        if ids.len() as u64 != last - first + 1 {
            return Err(Error::new(Kind::Protocol, "unexpected UID count"));
        }
        Ok(Some(ids))
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
            .find(|r| r.literals.len() == 1 && fetch_body_uid(&r.text) == Some(uid))
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
        let mut received = self.response_budget;
        loop {
            let frame = self.response(&mut received)?;
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
            match self.response(&mut received) {
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
                Err(error) if error.kind == Kind::Timeout && self.wire.is_open() => {
                    break Idle::Timeout;
                }
                Err(error) => return Err(error),
            }
        };
        self.wire.reset_deadline();
        self.wire.write_line("DONE")?;
        loop {
            let frame = self.response(&mut received)?;
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

// Recognize the top-level FETCH attributes, skipping quoted and parenthesized
// arguments such as FLAGS. A BODY[] value is the first and only captured literal.
fn fetch_body_uid(response: &str) -> Option<u64> {
    let (seq, attrs) = response.strip_prefix("* ")?.split_once(' ')?;
    seq.parse::<u64>().ok()?;
    let attrs = strip_prefix_case(attrs, "FETCH ")?.trim();
    let attrs = attrs.strip_prefix('(')?.strip_suffix(')')?;
    let mut remaining = attrs.trim_start();
    let mut uid = None;
    let mut body = false;
    while !remaining.is_empty() {
        let (name, tail) = remaining.split_once(char::is_whitespace)?;
        let (value, tail) = fetch_value(tail.trim_start())?;
        if name.eq_ignore_ascii_case("UID") {
            if uid.is_some() {
                return None;
            }
            uid = Some(value.parse().ok()?);
        } else if name.eq_ignore_ascii_case("BODY[]") {
            if body || value != "{#0}" {
                return None;
            }
            body = true;
        }
        remaining = tail.trim_start();
    }
    body.then_some(uid).flatten()
}

fn fetch_value(input: &str) -> Option<(&str, &str)> {
    if input.is_empty() {
        return None;
    }
    let mut depth = 0u32;
    let mut quoted = false;
    let mut escaped = false;
    for (i, byte) in input.bytes().enumerate() {
        if quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
            }
        } else {
            match byte {
                b'"' => quoted = true,
                b'(' => depth += 1,
                b')' => depth = depth.checked_sub(1)?,
                byte if byte.is_ascii_whitespace() && depth == 0 => return Some(input.split_at(i)),
                _ => {}
            }
        }
    }
    (!quoted && depth == 0).then_some((input, ""))
}

fn search_uids(reply: &Tagged) -> Result<Vec<u64>, Error> {
    let mut uids = Vec::new();
    for response in &reply.untagged {
        let mut words = response.text.split_ascii_whitespace();
        if words.next() != Some("*")
            || !words
                .next()
                .is_some_and(|word| word.eq_ignore_ascii_case("SEARCH"))
        {
            continue;
        }
        for word in words {
            let uid = word
                .parse::<u32>()
                .ok()
                .filter(|uid| *uid > 0)
                .ok_or_else(|| Error::new(Kind::Protocol, "invalid UID in SEARCH response"))?;
            uids.push(u64::from(uid));
        }
    }
    uids.sort_unstable();
    uids.dedup();
    Ok(uids)
}

fn check_untagged_count(count: usize) -> Result<(), Error> {
    if count >= MAX_RESPONSES {
        return Err(Error::new(Kind::Protocol, "IMAP response too large"));
    }
    Ok(())
}

fn idle_result(status: Status, reason: Idle) -> Result<Idle, Error> {
    if status == Status::Ok {
        Ok(reason)
    } else {
        Err(Error::new(Kind::Protocol, "IDLE failed"))
    }
}

#[cfg(test)]
mod budget_tests {
    use super::*;

    #[test]
    fn search_returns_twenty_thousand_uids_from_bounded_pages() -> Result<(), Error> {
        let start = 1_000_001;
        let expected: Vec<u64> = (start..start + 20_000).collect();
        let mut replies = String::new();
        for (index, page) in expected.chunks(4096).enumerate() {
            replies.push_str("* SEARCH");
            for uid in page {
                replies.push(' ');
                replies.push_str(&uid.to_string());
            }
            replies.push_str(&format!("\r\nA{:04} OK searched\r\n", index + 1));
        }
        let wire = super::super::wire::test_stream::wire(
            replies.as_bytes(),
            std::io::ErrorKind::UnexpectedEof,
        );
        let mut connection = Connection {
            wire,
            tag: 0,
            mailbox: Mailbox::default(),
            response_budget: ResponseBudget::default(),
        };
        connection.mailbox.exists = 20_000;
        let mut cursor = 0;
        for expected_page in expected.chunks(4096) {
            let actual = connection.uids_above(cursor)?;
            assert_eq!(actual, expected_page);
            cursor = actual[actual.len() - 1];
        }
        Ok(())
    }

    #[test]
    fn fetch_selects_the_requested_uid_when_another_message_is_reported() -> Result<(), Error> {
        let input = b"* 3 FETCH (UID 2 BODY[] {5}\r\nFirst)\r\n* 4 FETCH (BODY[] {6}\r\nReport UID 7)\r\nA0001 OK fetch complete\r\n";
        let wire = super::super::wire::test_stream::wire(
            input.as_slice(),
            std::io::ErrorKind::UnexpectedEof,
        );
        let mut connection = Connection {
            wire,
            tag: 0,
            mailbox: Mailbox::default(),
            response_budget: ResponseBudget::default(),
        };
        assert_eq!(connection.fetch_raw(7)?, b"Report");
        Ok(())
    }

    #[test]
    fn idle_cannot_complete_after_a_timeout_during_a_literal() {
        let input = b"+ idling\r\n* 4 FETCH (UID 7 BODY[] {6}\r\nRep";
        let wire =
            super::super::wire::test_stream::wire(input.as_slice(), std::io::ErrorKind::TimedOut);
        let mut connection = Connection {
            wire,
            tag: 0,
            mailbox: Mailbox::default(),
            response_budget: ResponseBudget::default(),
        };
        assert_eq!(
            connection
                .idle(Duration::from_millis(25))
                .err()
                .map(|error| error.kind),
            Some(Kind::Timeout)
        );
        assert_eq!(
            connection.capabilities().err().map(|error| error.kind),
            Some(Kind::Network)
        );
    }

    fn responding(input: &[u8], metadata: usize, logical: usize) -> Connection {
        Connection {
            wire: super::super::wire::test_stream::wire(input, std::io::ErrorKind::TimedOut),
            tag: 0,
            mailbox: Mailbox::default(),
            response_budget: ResponseBudget { metadata, logical },
        }
    }

    #[test]
    fn commands_charge_their_reply_count_metadata_and_literals() {
        let mut input = "* OK\r\n".repeat(8193);
        input.push_str("A0001 OK done\r\n");
        assert_eq!(
            responding(input.as_bytes(), MAX_METADATA, MAX_LOGICAL)
                .capabilities()
                .err()
                .map(|e| e.message),
            Some("IMAP response too large")
        );

        let mut cap = responding(b"* OK first\r\n* OK second\r\nA0001 OK\r\n", 17, 128);
        assert_eq!(
            cap.capabilities().err().map(|e| e.message),
            Some("line too long")
        );

        let body = b"* 1 FETCH (UID 7 BODY[] {12}\r\nLocal report)\r\nA0001 OK\r\n";
        let mut conn = responding(body, 1024, 30);
        assert_eq!(
            conn.fetch_raw(7).err().map(|e| e.message),
            Some("IMAP literal too large")
        );
    }

    #[test]
    fn timeout_after_a_complete_literal_closes_the_connection() {
        let mut conn = responding(
            b"* 1 FETCH (UID 7 BODY[] {6}\r\nReport",
            MAX_METADATA,
            MAX_LOGICAL,
        );
        assert_eq!(conn.fetch_raw(7).err().map(|e| e.kind), Some(Kind::Timeout));
        assert_eq!(
            conn.capabilities().err().map(|e| e.kind),
            Some(Kind::Network)
        );
    }

    #[test]
    fn reply_count_and_literal_count_fit_in_their_budgets() {
        assert!(check_untagged_count(MAX_RESPONSES - 1).is_ok());
        assert!(check_untagged_count(MAX_RESPONSES).is_err());
        let mut budget = ResponseBudget::default();
        assert!(budget.add_literal(0, MAX_RESPONSES - 1).is_ok());
        assert!(budget.add_literal(0, MAX_RESPONSES).is_err());
    }

    #[test]
    fn structured_reply_metadata_shares_one_mebibyte() {
        let mut budget = ResponseBudget::default();
        assert_eq!(budget.line_limit(), 65_536);
        assert!(budget.add_metadata(MAX_METADATA - 8).is_ok());
        assert_eq!(budget.line_limit(), 8);
        assert!(budget.add_metadata(8).is_ok());
        assert_eq!(budget.line_limit(), 0);
        assert_eq!(
            budget.add_metadata(1).err().map(|e| e.kind),
            Some(Kind::Protocol)
        );
    }

    #[test]
    fn mail_payload_keeps_its_literal_ceiling_and_shares_the_total() {
        let mut budget = ResponseBudget::default();
        assert_eq!(
            budget.add_literal(MAX_LITERAL + 1, 0).err().map(|e| e.kind),
            Some(Kind::Protocol)
        );
        assert!(budget.add_metadata(4).is_ok());
        assert!(budget.add_literal(MAX_LITERAL, 0).is_ok());
        assert_eq!(budget.metadata, MAX_METADATA - 4);
        let remaining = MAX_LOGICAL - MAX_LITERAL - 4;
        assert!(budget.add_literal(remaining, 0).is_ok());
        assert_eq!(
            budget.add_literal(1, 0).err().map(|e| e.kind),
            Some(Kind::Protocol)
        );
    }
}

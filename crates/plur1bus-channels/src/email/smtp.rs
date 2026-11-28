//! SMTP greeting, STARTTLS, SASL authentication and DATA.
use super::wire::Wire;
use super::{Error, Kind, Options, Ports, Security};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::collections::BTreeSet;

struct Reply {
    code: u16,
    lines: Vec<String>,
}

impl Reply {
    fn expect(
        &self,
        codes: &[u16],
        rejected: &'static str,
        deferred: &'static str,
    ) -> Result<(), Error> {
        if codes.contains(&self.code) {
            Ok(())
        } else if self.code >= 500 {
            Err(Error::new(Kind::Permanent, rejected))
        } else {
            Err(Error::new(Kind::Temporary, deferred))
        }
    }
}

fn reply(wire: &mut Wire) -> Result<Reply, Error> {
    let mut lines = Vec::new();
    while lines.len() < 128 {
        let line = wire.line(4096)?;
        let code = line.get(..3).and_then(|s| s.parse().ok());
        let separator = line.as_bytes().get(3);
        let text = line.get(4..).unwrap_or_default();
        let Some((code, sep)) = code.zip(separator) else {
            return Err(Error::new(Kind::Protocol, "malformed SMTP reply"));
        };
        lines.push(text.to_owned());
        match sep {
            b' ' => return Ok(Reply { code, lines }),
            b'-' => {}
            _ => return Err(Error::new(Kind::Protocol, "malformed SMTP reply")),
        }
    }
    Err(Error::new(Kind::Protocol, "SMTP reply too large"))
}

fn command(wire: &mut Wire, line: &str) -> Result<Reply, Error> {
    wire.reset_deadline();
    if line.contains(['\r', '\n', '\0']) {
        return Err(Error::new(Kind::Protocol, "invalid SMTP command"));
    }
    wire.write_line(line)?;
    reply(wire)
}

fn capabilities(reply: &Reply) -> (BTreeSet<String>, BTreeSet<String>) {
    let mut caps = BTreeSet::new();
    let mut auth = BTreeSet::new();
    for line in reply.lines.iter().skip(1) {
        let mut parts = line.split_ascii_whitespace();
        if let Some(name) = parts.next() {
            let key = name.to_ascii_uppercase();
            if key == "AUTH" {
                auth.extend(parts.map(str::to_ascii_uppercase));
            }
            caps.insert(key);
        }
    }
    (caps, auth)
}

fn authenticate(wire: &mut Wire, opt: &Options<'_>, auth: &BTreeSet<String>) -> Result<(), Error> {
    let denied = || Error::new(Kind::Auth, "SMTP authentication failed");
    if auth.contains("PLAIN") {
        let value = STANDARD.encode(format!("\0{}\0{}", opt.user, opt.password));
        if command(wire, &format!("AUTH PLAIN {value}"))?.code == 235 {
            return Ok(());
        }
    } else if auth.contains("LOGIN") {
        if command(wire, "AUTH LOGIN")?.code == 334
            && command(wire, &STANDARD.encode(opt.user))?.code == 334
            && command(wire, &STANDARD.encode(opt.password))?.code == 235
        {
            return Ok(());
        }
    } else {
        return Err(Error::new(
            Kind::Auth,
            "no usable SMTP authentication mechanism",
        ));
    }
    Err(denied())
}

fn with_smtp(
    ports: &dyn Ports,
    opt: &Options<'_>,
    ehlo_name: &str,
    use_wire: impl FnOnce(&mut Wire) -> Result<(), Error>,
) -> Result<(), Error> {
    let mut wire = Some(Wire::open(ports, opt, "SMTP connection failed")?);
    let result = (|| {
        let connection = wire
            .as_mut()
            .ok_or_else(|| Error::new(Kind::Network, "SMTP session failed"))?;
        reply(connection)?.expect(&[220], "SMTP greeting rejected", "SMTP greeting deferred")?;
        let ehlo_line = format!("EHLO {ehlo_name}");
        let mut ehlo = command(connection, &ehlo_line)?;
        ehlo.expect(&[250], "SMTP EHLO rejected", "SMTP EHLO deferred")?;
        if matches!(opt.security, Security::StartTls) {
            if !capabilities(&ehlo).0.contains("STARTTLS") {
                return Err(Error::new(
                    Kind::Tls,
                    "server does not offer STARTTLS; credentials not sent",
                ));
            }
            command(connection, "STARTTLS")?.expect(
                &[220],
                "SMTP STARTTLS rejected",
                "SMTP STARTTLS deferred",
            )?;
            let raw = wire
                .take()
                .ok_or_else(|| Error::new(Kind::Network, "SMTP session failed"))?;
            let mut upgraded = raw.upgrade(ports, opt.host)?;
            ehlo = command(&mut upgraded, &ehlo_line)?;
            wire = Some(upgraded);
            ehlo.expect(&[250], "SMTP EHLO rejected", "SMTP EHLO deferred")?;
        }
        let session = wire
            .as_mut()
            .ok_or_else(|| Error::new(Kind::Network, "SMTP session failed"))?;
        authenticate(session, opt, &capabilities(&ehlo).1)?;
        use_wire(session)
    })();
    if let Some(wire) = &mut wire {
        let _ = command(wire, "QUIT");
    }
    result
}

pub fn check_address(address: &str) -> Result<(), Error> {
    let valid = |part: &str| {
        !part.is_empty()
            && !part
                .chars()
                .any(|c| c.is_whitespace() || matches!(c, '<' | '>' | '@' | '"' | '\\' | '\0'))
    };
    if address
        .split_once('@')
        .is_some_and(|(local, domain)| valid(local) && valid(domain))
    {
        Ok(())
    } else {
        Err(Error::new(Kind::Protocol, "invalid mail address"))
    }
}

pub fn dot_stuff(data: &[u8]) -> Vec<u8> {
    let mut result = Vec::with_capacity(data.len().saturating_add(5));
    for line in data.split_inclusive(|b| *b == b'\n') {
        let line = line
            .strip_suffix(b"\n")
            .map(|l| l.strip_suffix(b"\r").unwrap_or(l))
            .unwrap_or(line);
        if line.first() == Some(&b'.') {
            result.push(b'.');
        }
        result.extend_from_slice(line);
        result.extend_from_slice(b"\r\n");
    }
    if data.is_empty() {
        result.extend_from_slice(b"\r\n");
    }
    result.extend_from_slice(b".\r\n");
    result
}

pub fn send(
    ports: &dyn Ports,
    opt: &Options<'_>,
    ehlo_name: &str,
    from: &str,
    to: &str,
    data: &[u8],
) -> Result<(), Error> {
    check_address(from)?;
    check_address(to)?;
    let data = dot_stuff(data);
    with_smtp(ports, opt, ehlo_name, |wire| {
        command(wire, &format!("MAIL FROM:<{from}>"))?.expect(
            &[250],
            "SMTP MAIL FROM rejected",
            "SMTP MAIL FROM deferred",
        )?;
        command(wire, &format!("RCPT TO:<{to}>"))?.expect(
            &[250, 251],
            "SMTP RCPT TO rejected",
            "SMTP RCPT TO deferred",
        )?;
        command(wire, "DATA")?.expect(&[354], "SMTP DATA rejected", "SMTP DATA deferred")?;
        wire.reset_deadline();
        wire.write(&data)?;
        reply(wire)?.expect(&[250], "SMTP message rejected", "SMTP message deferred")
    })
}

pub fn noop(ports: &dyn Ports, opt: &Options<'_>, ehlo_name: &str) -> Result<(), Error> {
    with_smtp(ports, opt, ehlo_name, |wire| {
        command(wire, "NOOP")?.expect(&[250], "SMTP NOOP rejected", "SMTP NOOP deferred")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    #[test]
    fn rejects_control_characters_before_sending_an_smtp_command() {
        for line in ["NOOP\r", "NOOP\n", "NOOP\0"] {
            let mut wire = crate::email::wire::test_stream::wire(
                b"250 accepted\r\n".as_slice(),
                io::ErrorKind::UnexpectedEof,
            );
            assert_eq!(
                command(&mut wire, line).err().map(|e| e.kind),
                Some(Kind::Protocol)
            );
        }
    }

    #[test]
    fn envelope_addresses_require_a_local_part_and_domain() {
        assert!(check_address("user@example.invalid").is_ok());
        for address in [
            "user",
            "@example.invalid",
            "user@",
            "two words@example.invalid",
        ] {
            assert_eq!(
                check_address(address).err().map(|e| e.kind),
                Some(Kind::Protocol)
            );
        }
    }
}

//! A WHATWG-style URL reader for the few facts the configuration policy needs from an endpoint string (`new URL(raw)` in
//! the TypeScript core): the scheme, the credentials, the host as `URL.hostname` spells it, the port and the origin.
//!
//! The core has no `url` dependency, so this is a small parser, not a full one. It follows the URL Standard for the cases an
//! endpoint takes: tab/newline stripping, scheme case, slashes and backslashes after a special scheme, userinfo up to the
//! last `@`, bracketed IPv6 (printed in the standard's compressed form), IPv4 in decimal, hexadecimal and octal parts with
//! 1 to 4 numbers, the default port dropped, percent-decoded and lowercased domains with the forbidden code points refused.
//! Not done: IDNA (a non-ASCII domain is kept in Unicode, lowercased, where `URL` prints Punycode), path/query/fragment
//! (never read), host validation of non-special schemes beyond the forbidden host code points.
use std::net::Ipv6Addr;

/// The parts of a parsed URL the policy reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Url {
    /// Lower-case scheme without the colon.
    pub scheme: String,
    /// Percent-encoded user name (`URL.username`), empty when there is none.
    pub username: String,
    /// Percent-encoded password (`URL.password`), empty when there is none.
    pub password: String,
    /// `URL.hostname`: an IPv6 address stays in brackets.
    pub hostname: String,
    /// The port, `None` when absent or the scheme's default.
    pub port: Option<u16>,
}

fn special_port(scheme: &str) -> Option<Option<u16>> {
    match scheme {
        "http" | "ws" => Some(Some(80)),
        "https" | "wss" => Some(Some(443)),
        "ftp" => Some(Some(21)),
        "file" => Some(None),
        _ => None,
    }
}

impl Url {
    /// `URL.protocol`.
    pub fn protocol(&self) -> String {
        format!("{}:", self.scheme)
    }

    /// `URL.host`: the host name plus `:port` when the port is not the default.
    pub fn host(&self) -> String {
        match self.port {
            Some(port) => format!("{}:{port}", self.hostname),
            None => self.hostname.clone(),
        }
    }

    /// `URL.origin`: `scheme://host` for a special scheme, `"null"` for the others.
    pub fn origin(&self) -> String {
        if special_port(&self.scheme).is_some() && self.scheme != "file" {
            format!("{}://{}", self.scheme, self.host())
        } else {
            "null".to_owned()
        }
    }

    /// Whether the scheme is `http` or `https`.
    pub fn is_http(&self) -> bool {
        matches!(self.scheme.as_str(), "http" | "https")
    }

    /// `new URL(raw)` for an absolute URL, or `None` where the constructor would throw.
    pub fn parse(raw: &str) -> Option<Url> {
        let text: String = raw
            .trim_matches(|c: char| c <= '\u{20}')
            .chars()
            .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
            .collect();
        let colon = text.find(':')?;
        let scheme = &text[..colon];
        let mut chars = scheme.chars();
        if !chars.next()?.is_ascii_alphabetic()
            || !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        {
            return None;
        }
        let scheme = scheme.to_ascii_lowercase();
        let rest = &text[colon + 1..];
        let special = special_port(&scheme);
        let slash = |c: char| c == '/' || (special.is_some() && c == '\\');
        let after = if special.is_some() && scheme != "file" {
            rest.trim_start_matches(['/', '\\'])
        } else {
            let mut it = rest.chars();
            match (it.next(), it.next()) {
                (Some(a), Some(b)) if slash(a) && slash(b) => &rest[2..],
                _ => {
                    return (scheme != "file" && special.is_none()).then(|| Url {
                        scheme,
                        username: String::new(),
                        password: String::new(),
                        hostname: String::new(),
                        port: None,
                    });
                }
            }
        };
        let end = after
            .find(|c: char| c == '/' || c == '?' || c == '#' || (special.is_some() && c == '\\'))
            .unwrap_or(after.len());
        let authority = &after[..end];
        let (userinfo, hostport) = match authority.rfind('@') {
            Some(at) => (Some(&authority[..at]), &authority[at + 1..]),
            None => (None, authority),
        };
        let (host_text, port_text) = split_host_port(hostport)?;
        let hostname = if special.is_some() {
            if host_text.is_empty() && scheme != "file" {
                return None;
            }
            parse_special_host(host_text)?
        } else {
            parse_opaque_host(host_text)?
        };
        let port = match port_text {
            None | Some("") => None,
            Some(digits) => {
                if !digits.bytes().all(|b| b.is_ascii_digit()) {
                    return None;
                }
                let value: u32 = digits.parse().ok()?;
                let value = u16::try_from(value).ok()?;
                (special.flatten() != Some(value)).then_some(value)
            }
        };
        let (username, password) = match userinfo {
            Some(info) => match info.split_once(':') {
                Some((user, pass)) => (user.to_owned(), pass.to_owned()),
                None => (info.to_owned(), String::new()),
            },
            None => (String::new(), String::new()),
        };
        Some(Url {
            scheme,
            username,
            password,
            hostname,
            port,
        })
    }
}

fn split_host_port(hostport: &str) -> Option<(&str, Option<&str>)> {
    if hostport.starts_with('[') {
        let close = hostport.find(']')?;
        let rest = &hostport[close + 1..];
        return match rest.strip_prefix(':') {
            Some(port) => Some((&hostport[..=close], Some(port))),
            None if rest.is_empty() => Some((&hostport[..=close], None)),
            None => None,
        };
    }
    Some(match hostport.find(':') {
        Some(at) => (&hostport[..at], Some(&hostport[at + 1..])),
        None => (hostport, None),
    })
}

fn forbidden_host(c: char) -> bool {
    matches!(
        c,
        '\0' | '\t'
            | '\n'
            | '\r'
            | ' '
            | '#'
            | '/'
            | ':'
            | '<'
            | '>'
            | '?'
            | '@'
            | '['
            | '\\'
            | ']'
            | '^'
            | '|'
    )
}

fn parse_opaque_host(text: &str) -> Option<String> {
    if text.starts_with('[') {
        return parse_ipv6(text);
    }
    (!text.chars().any(forbidden_host)).then(|| text.to_owned())
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| (b as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn parse_special_host(text: &str) -> Option<String> {
    if text.starts_with('[') {
        return parse_ipv6(text);
    }
    let decoded = percent_decode(text);
    let domain = decoded.to_lowercase();
    if domain.is_empty() && text.is_empty() {
        return Some(String::new()); // file://
    }
    if domain.is_empty()
        || domain
            .chars()
            .any(|c| forbidden_host(c) || c <= '\u{1f}' || c == '%' || c == '\u{7f}')
    {
        return None;
    }
    if ends_in_number(&domain) {
        return parse_ipv4(&domain);
    }
    Some(domain)
}

fn ends_in_number(domain: &str) -> bool {
    let mut parts: Vec<&str> = domain.split('.').collect();
    if parts.last() == Some(&"") {
        if parts.len() == 1 {
            return false;
        }
        parts.pop();
    }
    let Some(last) = parts.last() else {
        return false;
    };
    if !last.is_empty() && last.bytes().all(|b| b.is_ascii_digit()) {
        return true;
    }
    last.strip_prefix("0x")
        .is_some_and(|hex| hex.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn ipv4_number(part: &str) -> Option<u64> {
    if part.is_empty() {
        return None;
    }
    let (digits, radix) =
        if let Some(hex) = part.strip_prefix("0x").or_else(|| part.strip_prefix("0X")) {
            (hex, 16)
        } else if part.len() >= 2 && part.starts_with('0') {
            (&part[1..], 8)
        } else {
            (part, 10)
        };
    if digits.is_empty() {
        return Some(0);
    }
    u64::from_str_radix(digits, radix).ok()
}

fn parse_ipv4(domain: &str) -> Option<String> {
    let mut parts: Vec<&str> = domain.split('.').collect();
    if parts.last() == Some(&"") && parts.len() > 1 {
        parts.pop();
    }
    if parts.len() > 4 {
        return None;
    }
    let numbers: Vec<u64> = parts
        .iter()
        .map(|p| ipv4_number(p))
        .collect::<Option<_>>()?;
    let (last, head) = numbers.split_last()?;
    if head.iter().any(|n| *n > 255) || *last >= 256u64.pow(5 - numbers.len() as u32) {
        return None;
    }
    let mut value = *last;
    for (index, n) in head.iter().enumerate() {
        value += n * 256u64.pow(3 - index as u32);
    }
    Some(format!(
        "{}.{}.{}.{}",
        value >> 24,
        (value >> 16) & 255,
        (value >> 8) & 255,
        value & 255
    ))
}

fn parse_ipv6(text: &str) -> Option<String> {
    let inner = text.strip_prefix('[')?.strip_suffix(']')?;
    let address: Ipv6Addr = inner.parse().ok()?;
    let pieces = address.segments();
    // Compress the first longest run of at least two zero pieces, as the URL Standard's serializer does.
    let (mut best, mut best_len, mut at) = (None, 0, 0);
    while at < 8 {
        if pieces[at] == 0 {
            let start = at;
            while at < 8 && pieces[at] == 0 {
                at += 1;
            }
            if at - start > best_len && at - start >= 2 {
                best = Some(start);
                best_len = at - start;
            }
        } else {
            at += 1;
        }
    }
    let mut out = String::from("[");
    let mut index = 0;
    while index < 8 {
        if best == Some(index) {
            out.push_str(if index == 0 { "::" } else { ":" });
            index += best_len;
            continue;
        }
        out.push_str(&format!("{:x}", pieces[index]));
        if index != 7 {
            out.push(':');
        }
        index += 1;
    }
    out.push(']');
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(raw: &str) -> Option<String> {
        Url::parse(raw).map(|u| u.host())
    }

    #[test]
    fn reads_the_parts_an_endpoint_policy_needs() {
        let u = Url::parse("HTTPS://User:pw@Example.COM:443/a?b#c").unwrap();
        assert_eq!(u.scheme, "https");
        assert_eq!((u.username.as_str(), u.password.as_str()), ("User", "pw"));
        assert_eq!(u.host(), "example.com");
        assert_eq!(u.origin(), "https://example.com");
        assert_eq!(
            host("http://localhost:8080/v1").as_deref(),
            Some("localhost:8080")
        );
        assert_eq!(host("http://127.1/").as_deref(), Some("127.0.0.1"));
        assert_eq!(host("http://0x7f.1/").as_deref(), Some("127.0.0.1"));
        assert_eq!(host("http://2130706433/").as_deref(), Some("127.0.0.1"));
        assert_eq!(
            host("http://[0:0:0:0:0:0:0:1]:80/").as_deref(),
            Some("[::1]")
        );
        assert_eq!(
            host("http://[2001:db8:0:0:1:0:0:1]/").as_deref(),
            Some("[2001:db8::1:0:0:1]")
        );
        assert_eq!(host("http:\\\\a.example\\b").as_deref(), Some("a.example"));
        assert_eq!(host("http:example.com").as_deref(), Some("example.com"));
    }

    #[test]
    fn refuses_what_the_constructor_refuses() {
        for bad in [
            "not a url",
            "",
            "http://",
            "http://exa mple.com",
            "http://a.example:99999",
            "http://a.example:x",
            "http://256.1.1.1",
            "http://1.2.3.4.5",
            "http://[::1",
            "http://a<b",
        ] {
            assert!(Url::parse(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn other_schemes_parse_without_being_http() {
        let ftp = Url::parse("ftp://example.com/x").unwrap();
        assert!(!ftp.is_http());
        assert_eq!(ftp.origin(), "ftp://example.com");
        let custom = Url::parse("custom://Host:5/x").unwrap();
        assert_eq!(
            (custom.host().as_str(), custom.origin().as_str()),
            ("Host:5", "null")
        );
        assert_eq!(Url::parse("mailto:a@b").unwrap().host(), "");
    }
}

use std::{
    io::Read,
    net::{IpAddr, SocketAddr},
    time::Instant,
};

use plur1bus_providers::{http_read_timed_out, HttpCancellation};
use ureq::http::{header, Request, Response};
use url::{Host, Url};

use super::{Authorization, Error};
use crate::endpoint::Window;

pub(crate) fn check(window: Window<'_>) -> Result<(), Error> {
    if (window.canceled)() {
        return Err(Error::Aborted);
    }
    if window
        .deadline
        .saturating_duration_since(Instant::now())
        .as_millis()
        == 0
    {
        return Err(Error::Deadline);
    }
    Ok(())
}

pub(crate) fn pin_matches(target: &Url, pin: SocketAddr) -> bool {
    let ip = match target.host() {
        Some(Host::Ipv4(ip)) => Some(IpAddr::V4(ip)),
        Some(Host::Ipv6(ip)) => Some(IpAddr::V6(ip)),
        _ => None,
    };
    target.port_or_known_default() == Some(pin.port())
        && ip.is_none_or(|ip| ip.to_canonical() == pin.ip().to_canonical())
}

pub(super) fn local_address(address: IpAddr) -> bool {
    if address.is_loopback() {
        return true;
    }
    match address.to_canonical() {
        IpAddr::V4(ip) => {
            let [a, b, _, _] = ip.octets();
            ip.is_loopback()
                || (a == 100 && (64..=127).contains(&b) && ip.octets() != [100, 100, 100, 200])
        }
        IpAddr::V6(ip) => ip.segments()[..3] == [0xfd7a, 0x115c, 0xa1e0],
    }
}

pub(super) fn send(
    target: &Url,
    body: Option<&[u8]>,
    streaming: bool,
    window: Window<'_>,
    grant: &mut dyn Authorization,
    token: Option<&str>,
) -> Result<(Response<ureq::Body>, HttpCancellation), Error> {
    let pin = grant.pin();
    if !pin_matches(target, pin) {
        return Err(Error::Denied);
    }
    let method = if body.is_some() { "POST" } else { "GET" };
    let mut request = Request::builder()
        .method(method)
        .uri(target.as_str())
        .header(
            header::ACCEPT,
            if streaming {
                "text/event-stream"
            } else {
                "application/json"
            },
        )
        .header(header::ACCEPT_ENCODING, "identity")
        .header(header::CONNECTION, "close")
        .header("a2a-version", "1.0");
    if body.is_some() {
        request = request.header(header::CONTENT_TYPE, "application/json");
    }
    if let Some(token) = token {
        let (data, padding) = token.split_once('=').unwrap_or((token, ""));
        if token.len() > 4096
            || data.is_empty()
            || !data
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._~+/-".contains(&b))
            || !padding.bytes().all(|b| b == b'=')
        {
            return Err(Error::Denied);
        }
        let mut field =
            header::HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| Error::Denied)?;
        field.set_sensitive(true);
        request = request.header(header::AUTHORIZATION, field);
    }
    let request = request
        .body(body.unwrap_or_default())
        .map_err(|_| Error::InvalidRequest)?;
    check(window)?;
    // From here the write may reach the peer even when there is no reply.
    grant.mark_attempted();
    let (response, signal) = run(pin, window, request, None)?;
    if response
        .headers()
        .get_all(header::CONTENT_ENCODING)
        .iter()
        .any(|coding| !coding.as_bytes().eq_ignore_ascii_case(b"identity"))
    {
        return Err(Error::RequestFailed);
    }
    Ok((response, signal))
}

pub(crate) fn run(
    pin: SocketAddr,
    window: Window<'_>,
    request: Request<&[u8]>,
    body_timeout: Option<std::time::Duration>,
) -> Result<(Response<ureq::Body>, HttpCancellation), Error> {
    let transport_deadline = window.deadline;
    let config = ureq::config::Config::builder()
        .proxy(None)
        .max_redirects(0)
        .max_idle_connections(0)
        .timeout_recv_body(body_timeout)
        .max_response_header_size(16 * 1024)
        .http_status_as_error(false)
        .timeout_global(Some(
            transport_deadline.saturating_duration_since(Instant::now()),
        ))
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                .build(),
        )
        .build();
    let signal = HttpCancellation::default();
    let agent = signal.pinned_agent(config, pin, transport_deadline);
    let response = signal.run(window.canceled, move || agent.run(request));
    check(window)?;
    let response = response
        .map_err(|_| Error::RequestFailed)?
        .map_err(|error| match error {
            ureq::Error::Timeout(_) => Error::Deadline,
            _ => Error::RequestFailed,
        })?;
    Ok((response, signal))
}

pub(super) fn check_media(
    response: &Response<impl Sized>,
    stream: bool,
    cap: usize,
) -> Result<(), Error> {
    if response.status().as_u16() != 200 {
        return Err(Error::RequestFailed);
    }
    let fields = response.headers();
    let mut types = fields.get_all(header::CONTENT_TYPE).iter();
    let media = types
        .next()
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let json = media == "application/json"
        || media
            .strip_prefix("application/")
            .and_then(|v| v.strip_suffix("+json"))
            .is_some_and(|v| {
                !v.is_empty()
                    && v.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b".+-".contains(&b))
            });
    if types.next().is_some()
        || (if stream {
            media != "text/event-stream"
        } else {
            !json
        })
    {
        return Err(Error::RequestFailed);
    }
    if let Some(raw) = fields.get(header::CONTENT_LENGTH) {
        let expected = raw
            .to_str()
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .ok_or(Error::RequestFailed)?;
        if expected > cap {
            return Err(Error::TooLarge);
        }
    }
    Ok(())
}

pub(crate) fn read_json(
    body: ureq::Body,
    signal: &HttpCancellation,
    cap: usize,
    window: Window<'_>,
    current: impl Fn() -> bool,
) -> Result<Vec<u8>, Error> {
    let mut reader = signal
        .reader(body, || (window.canceled)() || !current())
        .map_err(|_| Error::RequestFailed)?;
    let mut bytes = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        check(window)?;
        if !current() {
            return Err(Error::Revoked);
        }
        let left = cap
            .saturating_sub(bytes.len())
            .saturating_add(1)
            .min(buf.len());
        let received = reader.read(&mut buf[..left]);
        check(window)?;
        if !current() {
            return Err(Error::Revoked);
        }
        let n = received.map_err(|error| {
            if http_read_timed_out(&error) {
                Error::Deadline
            } else {
                Error::RequestFailed
            }
        })?;
        if n == 0 {
            return Ok(bytes);
        }
        if n > cap - bytes.len() {
            return Err(Error::TooLarge);
        }
        bytes.extend_from_slice(&buf[..n]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bodyless_http_statuses_do_not_enter_the_rpc_body_reader() -> Result<(), ureq::http::Error> {
        for status in [204, 205, 304] {
            let response = Response::builder()
                .status(status)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::CONTENT_LENGTH, "0")
                .body(())?;
            assert_eq!(
                check_media(&response, false, 128),
                Err(Error::RequestFailed)
            );
            assert_eq!(check_media(&response, true, 128), Err(Error::RequestFailed));
        }
        Ok(())
    }
}

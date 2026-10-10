use std::io::{BufRead, Write};
fn main() -> std::io::Result<()> {
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    loop {
        // Bound allocation before parsing an untrusted line; stdout is protocol only.
        let mut bytes = Vec::new();
        loop {
            let available = input.fill_buf()?;
            if available.is_empty() {
                return Ok(());
            }
            let count = available
                .iter()
                .position(|b| *b == b'\n')
                .map(|n| n + 1)
                .unwrap_or(available.len());
            if bytes.len() + count > 65536 {
                return Ok(());
            }
            bytes.extend_from_slice(&available[..count]);
            input.consume(count);
            if bytes.last() == Some(&b'\n') {
                break;
            }
        }
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            return Ok(());
        };
        let Some(method) = v.get("method").and_then(|v| v.as_str()) else {
            return Ok(());
        };
        if v.as_object()
            .is_none_or(|o| o.keys().any(|k| k != "method"))
        {
            return Ok(());
        }
        let Some(result) = plur1bus_host::response(method) else {
            return Ok(());
        };
        serde_json::to_writer(&mut output, &result)?;
        output.write_all(b"\n")?;
        output.flush()?;
        if method == "shutdown" {
            return Ok(());
        }
    }
}

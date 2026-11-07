//! Original MIT benchmark fixture; the generated README states the contract.
/// Inputs, outputs and failure behavior follow the generated README contract.
pub fn BENCH_FN(text: &str) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    let mut value = String::new();
    let (mut quote, mut escaped, mut started) = (None, false, false);
    for ch in text.chars() {
        if escaped {
            value.push(ch);
            escaped = false;
            started = true;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            escaped = true;
            started = true;
            continue;
        }
        if let Some(open) = quote {
            if ch == open {
                quote = None;
            } else {
                value.push(ch);
            }
        } else if ch == '\'' || ch == '"' {
            quote = Some(ch);
            started = true;
        } else if ch.is_whitespace() {
            if started {
                result.push(std::mem::take(&mut value));
                started = false;
            }
        } else {
            value.push(ch);
            started = true;
        }
    }
    if escaped || quote.is_some() {
        return Err("unfinished token".into());
    }
    if started {
        result.push(value);
    }
    Ok(result)
}

//! Original MIT benchmark fixture; the generated README states the contract.
/// Inputs, outputs and failure behavior follow the generated README contract.
pub fn BENCH_FN(text: &str) -> Result<Vec<String>, String> {
    Ok(text.split_whitespace().map(str::to_owned).collect())
}

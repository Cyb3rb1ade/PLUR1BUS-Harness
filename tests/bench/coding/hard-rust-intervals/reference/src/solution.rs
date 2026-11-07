//! Original MIT benchmark fixture; the generated README states the contract.
/// Inputs, outputs and failure behavior follow the generated README contract.
pub fn BENCH_FN(input: &[(i64, i64)]) -> Vec<(i64, i64)> {
    let mut ordered: Vec<_> = input.iter().map(|&(a, b)| (a.min(b), a.max(b))).collect();
    ordered.sort_unstable();
    let mut result: Vec<(i64, i64)> = Vec::new();
    for (start, end) in ordered {
        if let Some(previous) = result.last_mut() {
            if start <= previous.1.saturating_add(1) {
                previous.1 = previous.1.max(end);
                continue;
            }
        }
        result.push((start, end));
    }
    result
}

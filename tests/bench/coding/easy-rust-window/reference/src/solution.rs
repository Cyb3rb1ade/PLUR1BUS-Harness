//! Original MIT benchmark fixture; the generated README states the contract.
/// Inputs, outputs and failure behavior follow the generated README contract.
pub fn BENCH_FN(values: &[i64], width: usize) -> Vec<i128> {
    if width == 0 || width > values.len() {
        return Vec::new();
    }
    let mut sum: i128 = values[..width].iter().map(|v| i128::from(*v)).sum();
    let mut result = Vec::with_capacity(values.len() - width + 1);
    result.push(sum);
    for end in width..values.len() {
        sum += i128::from(values[end]) - i128::from(values[end - width]);
        result.push(sum);
    }
    result
}

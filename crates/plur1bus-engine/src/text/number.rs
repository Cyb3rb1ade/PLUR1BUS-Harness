//! Shared exact binary64 formatting for bounded persisted/prompt scores.
/// Exact binary64-to-decimal rounding used by Number.toFixed for prompt scores.
pub(crate) fn fixed(value: f64, digits: u32) -> String {
    if !value.is_finite() {
        return value.to_string();
    }
    if value.abs() >= 1e21 {
        return value.to_string();
    }
    let bits = value.abs().to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1_u64 << 52) - 1);
    let significand = if exponent == 0 {
        fraction
    } else {
        fraction | (1_u64 << 52)
    };
    let shift = if exponent == 0 {
        -1074
    } else {
        exponent - 1023 - 52
    };
    let scaled = u128::from(significand) * 10_u128.pow(digits);
    let rounded = if shift >= 0 {
        scaled.checked_shl(shift as u32).unwrap_or(0)
    } else if -shift >= 128 {
        0
    } else {
        let divisor = 1_u128 << (-shift as u32);
        scaled / divisor + u128::from(scaled % divisor >= divisor / 2)
    };
    let scale = 10_u128.pow(digits);
    let sign = if value < 0.0 { "-" } else { "" };
    format!(
        "{sign}{}.{:0width$}",
        rounded / scale,
        rounded % scale,
        width = digits as usize
    )
}

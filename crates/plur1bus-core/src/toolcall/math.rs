//! The two functions of the JavaScript math library that a capability ranking stands on.
//!
//! A score is compared and printed as a double, so the logarithm in it has to be one function. Rust's `f64::ln` is the
//! platform's and differs between platforms in the last place. V8 carries its own routine (fdlibm's `e_log.c`), and
//! [`js_log`] is that routine with every operation rounded on its own, which is what V8 computes where it was compiled
//! without fused multiply-add. Where it was compiled with it (the arm64 builds), `Math.log` itself differs from this
//! routine in the last place for a few arguments in a hundred (K9b-D1): the TypeScript core's scores are not the same
//! doubles on every machine, and the Rust core's are. `2 ** x` goes to the platform's `pow` in V8 and here
//! ([`js_pow2`]). `fixtures/parity/capabilities/math.json` holds the routine bit for bit.

const LN2_HI: f64 = f64::from_bits(0x3fe6_2e42_fee0_0000);
const LN2_LO: f64 = f64::from_bits(0x3dea_39ef_3579_3c76);
const TWO54: f64 = f64::from_bits(0x4350_0000_0000_0000);
const THIRD: f64 = f64::from_bits(0x3fd5_5555_5555_5555);
const LG1: f64 = f64::from_bits(0x3fe5_5555_5555_5593);
const LG2: f64 = f64::from_bits(0x3fd9_9999_9997_fa04);
const LG3: f64 = f64::from_bits(0x3fd2_4924_9422_9359);
const LG4: f64 = f64::from_bits(0x3fcc_71c5_1d8e_78af);
const LG5: f64 = f64::from_bits(0x3fc7_4664_96cb_03de);
const LG6: f64 = f64::from_bits(0x3fc3_9a09_d078_c69f);
const LG7: f64 = f64::from_bits(0x3fc2_f112_df3e_5244);

/// The high 32 bits of a double, as the signed word fdlibm works on.
fn high_word(x: f64) -> i32 {
    i32::from_ne_bytes(((x.to_bits() >> 32) as u32).to_ne_bytes())
}

/// The double with its high 32 bits replaced.
fn with_high_word(x: f64, high: i32) -> f64 {
    let high = u64::from(u32::from_ne_bytes(high.to_ne_bytes()));
    f64::from_bits((high << 32) | (x.to_bits() & 0xffff_ffff))
}

/// `Math.log(x)` as V8 computes it (fdlibm `__ieee754_log`): the argument is reduced to `2^k * (1 + f)` with
/// `sqrt(2)/2 < 1 + f < sqrt(2)`, `log(1 + f)` comes from a polynomial in `s = f / (2 + f)`, and `k * ln2` is added in
/// two parts so the sum keeps its last bits.
pub fn js_log(x: f64) -> f64 {
    let mut x = x;
    let mut hx = high_word(x);
    let low = x.to_bits() & 0xffff_ffff;
    let mut k: i32 = 0;
    if hx < 0x0010_0000 {
        // Zero, negative or subnormal.
        if u64::from(u32::from_ne_bytes((hx & 0x7fff_ffff).to_ne_bytes())) | low == 0 {
            return f64::NEG_INFINITY;
        }
        if hx < 0 {
            return f64::NAN;
        }
        k -= 54;
        x *= TWO54;
        hx = high_word(x);
    }
    if hx >= 0x7ff0_0000 {
        return x + x;
    }
    k += (hx >> 20) - 1023;
    hx &= 0x000f_ffff;
    let i = (hx + 0x95f64) & 0x10_0000;
    x = with_high_word(x, hx | (i ^ 0x3ff0_0000));
    k += i >> 20;
    let f = x - 1.0;
    let dk = f64::from(k);
    if (0x000f_ffff & (2 + hx)) < 3 {
        // |f| < 2^-20.
        if f == 0.0 {
            return if k == 0 {
                0.0
            } else {
                dk * LN2_HI + dk * LN2_LO
            };
        }
        let r = f * f * (0.5 - THIRD * f);
        return if k == 0 {
            f - r
        } else {
            dk * LN2_HI - ((r - dk * LN2_LO) - f)
        };
    }
    let s = f / (2.0 + f);
    let z = s * s;
    let w = z * z;
    let t1 = w * (LG2 + w * (LG4 + w * LG6));
    let t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
    let r = t2 + t1;
    if ((hx - 0x6147a) | (0x6b851 - hx)) > 0 {
        let hfsq = 0.5 * f * f;
        if k == 0 {
            f - (hfsq - s * (hfsq + r))
        } else {
            dk * LN2_HI - ((hfsq - (s * (hfsq + r) + dk * LN2_LO)) - f)
        }
    } else if k == 0 {
        f - s * (f - r)
    } else {
        dk * LN2_HI - ((s * (f - r) - dk * LN2_LO) - f)
    }
}

/// `2 ** x`: the platform's `pow`, as in V8. Exact for an integer `x`; otherwise within the platform library's error.
pub fn js_pow2(x: f64) -> f64 {
    2f64.powf(x)
}

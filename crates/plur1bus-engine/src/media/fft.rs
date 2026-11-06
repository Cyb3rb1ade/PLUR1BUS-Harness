//! Fixed-size real Fourier transform for the MM-1 audio analysis window.

pub(super) const FFT_LENGTH: usize = 512;
pub(super) const FREQUENCY_BINS: usize = FFT_LENGTH / 2 + 1;

/// Return the 257 nonnegative-frequency magnitudes of an unnormalized real FFT.
pub(super) fn magnitudes(samples: &[f64; FFT_LENGTH]) -> [f64; FREQUENCY_BINS] {
    let mut real = [0.0; FFT_LENGTH];
    let mut imaginary = [0.0; FFT_LENGTH];
    for (index, value) in samples.iter().enumerate() {
        real[index.reverse_bits() >> (usize::BITS - FFT_LENGTH.ilog2())] = *value;
    }
    let mut width = 2;
    while width <= FFT_LENGTH {
        let half = width / 2;
        for offset in (0..FFT_LENGTH).step_by(width) {
            for index in 0..half {
                let angle = -2.0 * std::f64::consts::PI * index as f64 / width as f64;
                let (sine, cosine) = angle.sin_cos();
                let even = offset + index;
                let odd = even + half;
                let real_odd = real[odd] * cosine - imaginary[odd] * sine;
                let imaginary_odd = real[odd] * sine + imaginary[odd] * cosine;
                real[odd] = real[even] - real_odd;
                imaginary[odd] = imaginary[even] - imaginary_odd;
                real[even] += real_odd;
                imaginary[even] += imaginary_odd;
            }
        }
        width *= 2;
    }
    std::array::from_fn(|index| real[index].hypot(imaginary[index]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_impulse_has_unit_magnitude_in_every_bin() {
        let mut samples = [0.0; FFT_LENGTH];
        samples[0] = 1.0;
        for magnitude in magnitudes(&samples) {
            assert!((magnitude - 1.0).abs() < 1e-12);
        }
    }

    #[test]
    fn a_constant_signal_has_only_a_dc_component() {
        let spectrum = magnitudes(&[1.0; FFT_LENGTH]);
        assert!((spectrum[0] - 512.0).abs() < 1e-12);
        assert!(spectrum[1..]
            .iter()
            .all(|magnitude| magnitude.abs() < 1e-12));
    }

    #[test]
    fn a_bin_centered_sine_has_the_expected_amplitude() {
        let samples = std::array::from_fn(|i| {
            (2.0 * std::f64::consts::PI * 17.0 * i as f64 / FFT_LENGTH as f64).sin()
        });
        let spectrum = magnitudes(&samples);
        assert!((spectrum[17] - 256.0).abs() < 1e-10);
        for (index, magnitude) in spectrum.iter().enumerate() {
            if index != 17 {
                assert!(magnitude.abs() < 1e-10, "bin {index}: {magnitude}");
            }
        }
    }
}

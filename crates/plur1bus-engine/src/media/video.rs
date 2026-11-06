//! Bounded uniform video frame selection and vision batches (MM-1/E8).

use std::ops::Range;

/// Maximum decoded frames encoded for a single video and indexing run.
pub const MAX_VIDEO_FRAMES: usize = 32;

/// A video has fewer than two decoded frames to place into a vision batch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TooFewFrames;

impl std::fmt::Display for TooFewFrames {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("video embedding requires at least two decoded frames")
    }
}
impl std::error::Error for TooFewFrames {}

/// At most 32 source frame indices and batch ranges of two to four selected frames.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoPlan {
    /// Indices in ascending order, including the first and last source frame.
    pub indices: Vec<usize>,
    /// Ranges into `indices`, not into the source video.
    pub batches: Vec<Range<usize>>,
}

impl VideoPlan {
    /// Uniform floor-linspace sampling without duplicating frames or retaining a singleton batch.
    pub fn new(total_frames: usize) -> Result<Self, TooFewFrames> {
        if total_frames < 2 {
            return Err(TooFewFrames);
        }
        let selected = total_frames.min(MAX_VIDEO_FRAMES);
        let indices = (0..selected)
            .map(|i| ((i as u128 * (total_frames - 1) as u128) / (selected - 1) as u128) as usize)
            .collect();
        let mut batches = Vec::with_capacity(selected.div_ceil(4));
        let mut start = 0;
        while start < selected {
            let remaining = selected - start;
            let count = if remaining == 5 { 3 } else { remaining.min(4) };
            batches.push(start..start + count);
            start += count;
        }
        Ok(Self { indices, batches })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn uniform_sampling_preserves_endpoints_and_caps_the_frame_count() {
        let plan = VideoPlan::new(101).unwrap();
        assert_eq!(plan.indices.len(), 32);
        assert_eq!(plan.indices[0], 0);
        assert_eq!(plan.indices[31], 100);
        for (i, value) in plan.indices.iter().enumerate() {
            assert_eq!(*value, (i * 100) / 31);
        }
    }

    #[test]
    fn every_batch_contains_two_to_four_frames_with_no_loss_or_duplicate() {
        for count in 2..=100 {
            let plan = VideoPlan::new(count).unwrap();
            assert!(plan.batches.iter().all(|r| (2..=4).contains(&r.len())));
            assert_eq!(
                plan.batches.iter().cloned().flatten().collect::<Vec<_>>(),
                (0..count.min(32)).collect::<Vec<_>>()
            );
            assert!(plan.indices.windows(2).all(|pair| pair[0] < pair[1]));
            if count <= 32 {
                assert_eq!(plan.indices, (0..count).collect::<Vec<_>>());
            }
        }
    }

    #[test]
    fn invalid_counts_refuse_and_extreme_counts_do_not_overflow() {
        assert_eq!(VideoPlan::new(0), Err(TooFewFrames));
        assert_eq!(VideoPlan::new(1), Err(TooFewFrames));
        let plan = VideoPlan::new(usize::MAX).unwrap();
        assert_eq!(plan.indices.first(), Some(&0));
        assert_eq!(plan.indices.last(), Some(&(usize::MAX - 1)));
        assert_eq!(plan.indices.len(), 32);
    }
}

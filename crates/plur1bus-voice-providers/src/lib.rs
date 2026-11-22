//! Cloud voice wire operations. The caller owns the credential lease and the egress policy.
#![forbid(unsafe_code)]

pub mod catalog;
pub mod elevenlabs;
pub mod http;
pub mod polly;
pub mod realtime;
mod tts_socket;

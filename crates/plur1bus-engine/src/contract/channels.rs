//! The open host-declared channel vocabulary.

use super::ChannelRef;

/// A host-declared registry of channel names, with no closed built-in vocabulary.
pub trait ChannelRegistry: Send + Sync {
    /// Register a channel and return its canonical name.
    fn register(&self, name: ChannelRef) -> String;
    /// Report whether this channel has been declared.
    fn has(&self, name: ChannelRef) -> bool;
    /// List every declared channel.
    fn list(&self) -> Vec<ChannelRef>;
}

pub const MAX_OUTBOX_ATTEMPTS: u32 = 24;
pub const MAX_TRANSPORT_ATTEMPTS_PER_MINUTE: usize = 30;
pub const TRANSPORT_RATE_WINDOW_MS: u64 = 60_000;
pub const MAX_BACKOFF_MS: u64 = 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerLinkStatus {
    Discovered,
    Connecting,
    Connected,
    Ready,
    Disconnected,
}

impl PeerLinkStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Discovered => "discovered",
            Self::Connecting => "connecting",
            Self::Connected => "connected",
            Self::Ready => "ready",
            Self::Disconnected => "disconnected",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "discovered" => Some(Self::Discovered),
            "connecting" => Some(Self::Connecting),
            "connected" => Some(Self::Connected),
            "ready" => Some(Self::Ready),
            "disconnected" => Some(Self::Disconnected),
            _ => None,
        }
    }

    pub fn is_online(self) -> bool {
        matches!(self, Self::Ready)
    }
}

pub fn outbox_backoff_ms(attempt_count: u32) -> u64 {
    let shift = attempt_count.min(6);
    (1_000u64 << shift).min(MAX_BACKOFF_MS)
}

pub fn should_attempt_outbox(
    in_flight: bool,
    attempt_count: u32,
    last_attempt_at_ms: u64,
    now_ms: u64,
    ignore_backoff: bool,
) -> bool {
    if in_flight || attempt_count >= MAX_OUTBOX_ATTEMPTS {
        return false;
    }
    if ignore_backoff || last_attempt_at_ms == 0 {
        return true;
    }
    now_ms.saturating_sub(last_attempt_at_ms) >= outbox_backoff_ms(attempt_count)
}

pub fn discovered_means_online() -> bool {
    false
}

pub fn connected_means_transport_ready() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovered_is_not_online_or_ready() {
        assert!(!discovered_means_online());
        assert!(!connected_means_transport_ready());
        assert!(!PeerLinkStatus::Discovered.is_online());
        assert!(!PeerLinkStatus::Connecting.is_online());
        assert!(!PeerLinkStatus::Connected.is_online());
        assert!(PeerLinkStatus::Ready.is_online());
        assert!(!PeerLinkStatus::Disconnected.is_online());
    }

    #[test]
    fn backoff_grows_then_caps() {
        assert_eq!(outbox_backoff_ms(0), 1_000);
        assert_eq!(outbox_backoff_ms(1), 2_000);
        assert_eq!(outbox_backoff_ms(2), 4_000);
        assert_eq!(outbox_backoff_ms(6), MAX_BACKOFF_MS);
        assert_eq!(outbox_backoff_ms(20), MAX_BACKOFF_MS);
    }

    #[test]
    fn in_flight_or_exhausted_skips_retry() {
        assert!(!should_attempt_outbox(true, 0, 0, 10_000, true));
        assert!(!should_attempt_outbox(
            false,
            MAX_OUTBOX_ATTEMPTS,
            0,
            10_000,
            true
        ));
        assert!(!should_attempt_outbox(false, 1, 9_500, 10_000, false));
        assert!(should_attempt_outbox(false, 1, 1_000, 10_000, false));
        assert!(should_attempt_outbox(false, 3, 9_999, 10_000, true));
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PollPolicy {
    pub poll_seconds: u64,
    pub timeout_seconds: u64,
}

impl PollPolicy {
    pub fn new(poll_seconds: u64, timeout_seconds: u64) -> anyhow::Result<Self> {
        anyhow::ensure!(poll_seconds > 0, "poll interval must be positive");
        anyhow::ensure!(
            timeout_seconds >= poll_seconds,
            "poll timeout must be at least one interval"
        );
        Ok(Self {
            poll_seconds,
            timeout_seconds,
        })
    }
}

impl Default for PollPolicy {
    fn default() -> Self {
        Self {
            poll_seconds: 5,
            timeout_seconds: 300,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polling_defaults_are_bounded_and_configurable() {
        assert_eq!(
            PollPolicy::default(),
            PollPolicy {
                poll_seconds: 5,
                timeout_seconds: 300
            }
        );
        assert!(PollPolicy::new(0, 20).is_err());
        assert!(PollPolicy::new(10, 5).is_err());
        assert!(PollPolicy::new(2, 20).is_ok());
    }
}

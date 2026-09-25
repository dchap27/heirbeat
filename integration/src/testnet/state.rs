use anyhow::{bail, Result};

pub fn derive_deadline(last_check_in: u32, timeout_blocks: u32) -> Result<u64> {
    u64::from(last_check_in)
        .checked_add(u64::from(timeout_blocks))
        .ok_or_else(|| anyhow::anyhow!("deadline arithmetic overflow"))
}

pub fn ensure_unclaimed(claimed: bool, operation: &str) -> Result<()> {
    if claimed {
        let message = match operation {
            "heartbeat" => "Vault is already claimed; heartbeat is not permitted.",
            "claim" => "Vault is already claimed; claim cannot be repeated.",
            "deposit" => "Vault is already claimed; deposits are not permitted.",
            _ => "Vault is already claimed; this operation is not permitted.",
        };
        bail!("{message}");
    }
    Ok(())
}

pub fn ensure_claim_eligible(current_reference_block: u32, deadline: u64) -> Result<()> {
    if u64::from(current_reference_block) < deadline {
        bail!("claim is not yet eligible: current reference block {current_reference_block} < deadline {deadline}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deadline_is_widened_before_addition() {
        assert_eq!(derive_deadline(u32::MAX, u32::MAX).unwrap(), 8_589_934_590);
    }

    #[test]
    fn claimed_state_rejects_heartbeat_and_claim() {
        assert!(ensure_unclaimed(true, "heartbeat").is_err());
        assert!(ensure_unclaimed(true, "claim").is_err());
        assert!(ensure_unclaimed(false, "heartbeat").is_ok());
    }

    #[test]
    fn claim_eligibility_uses_inclusive_boundary() {
        assert!(ensure_claim_eligible(99, 100).is_err());
        assert!(ensure_claim_eligible(100, 100).is_ok());
    }
}

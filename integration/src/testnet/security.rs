use std::collections::BTreeSet;

use anyhow::{ensure, Result};

/// Validates the final, post-bootstrap Network Account authorization surface.
///
/// Bootstrap-only P2ID permission is deliberately excluded: a vault is not considered
/// finalized until its note roots exactly match the Heirbeat and required v0.16 system roots.
pub fn validate_hardened_allowlists<T: Copy + Ord, U: Copy + Ord>(
    actual_note_roots: &BTreeSet<T>,
    actual_transaction_script_roots: &BTreeSet<U>,
    check_in: T,
    claim: T,
    deposit: T,
    network_account_config: T,
    fee_sponsorship: T,
    p2id: T,
    expiration: U,
) -> Result<()> {
    let expected_note_roots = BTreeSet::from([
        check_in,
        claim,
        deposit,
        network_account_config,
        fee_sponsorship,
    ]);
    ensure!(
        expected_note_roots.len() == 5,
        "expected hardened note roots must be unique"
    );
    ensure!(
        !actual_note_roots.contains(&p2id),
        "P2ID input root is forbidden after bootstrap cleanup"
    );
    ensure!(
        actual_note_roots == &expected_note_roots,
        "note allowlist must contain exactly the three Heirbeat roots plus NetworkAccountConfig and FeeSponsorship"
    );
    ensure!(
        actual_transaction_script_roots == &BTreeSet::from([expiration]),
        "transaction-script allowlist must contain only the canonical expiration root"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expected() -> BTreeSet<u32> {
        BTreeSet::from([1, 2, 3, 4, 5])
    }

    fn validate(notes: &BTreeSet<u32>, txs: &BTreeSet<u32>) -> Result<()> {
        validate_hardened_allowlists(notes, txs, 1, 2, 3, 4, 5, 6, 7)
    }

    #[test]
    fn security_allowlist_accepts_exact_hardened_surface() {
        assert!(validate(&expected(), &BTreeSet::from([7])).is_ok());
    }

    #[test]
    fn security_allowlist_rejects_missing_or_unexpected_roots() {
        let mut missing = expected();
        missing.remove(&3);
        assert!(validate(&missing, &BTreeSet::from([7])).is_err());

        let mut extra = expected();
        extra.insert(8);
        assert!(validate(&extra, &BTreeSet::from([7])).is_err());

        let mut p2id_reintroduced = expected();
        p2id_reintroduced.insert(6);
        assert!(validate(&p2id_reintroduced, &BTreeSet::from([7])).is_err());
    }

    #[test]
    fn security_allowlist_rejects_transaction_script_broadening() {
        assert!(validate(&expected(), &BTreeSet::from([7, 8])).is_err());
        assert!(validate(&expected(), &BTreeSet::new()).is_err());
    }
}

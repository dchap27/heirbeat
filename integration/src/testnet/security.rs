use std::collections::BTreeSet;

use anyhow::{ensure, Result};

#[path = "../../../contracts/heirbeat-vault/src/network_auth_ids.rs"]
#[allow(dead_code)]
mod pinned_auth_ids;

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
    fee_sponsorship: T,
    network_account_config: T,
    activation_note: T,
    p2id: T,
    expiration: U,
) -> Result<()> {
    let expected_note_roots = BTreeSet::from([check_in, claim, deposit, fee_sponsorship]);
    ensure!(
        expected_note_roots.len() == 4,
        "expected hardened note roots must be unique"
    );
    ensure!(
        !actual_note_roots.contains(&p2id)
            && !actual_note_roots.contains(&network_account_config)
            && !actual_note_roots.contains(&activation_note),
        "P2ID, NetworkAccountConfig, and activation roots are forbidden after activation"
    );
    ensure!(
        actual_note_roots == &expected_note_roots,
        "activated note allowlist must contain exactly the three Heirbeat roots and FeeSponsorship"
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
    use miden_protocol::{account::StorageSlotName, Felt, Word};
    use miden_standards::note::{FeeSponsorshipNote, NetworkAccountConfigNote};

    fn expected() -> BTreeSet<u32> {
        BTreeSet::from([1, 2, 3, 4])
    }

    fn validate(notes: &BTreeSet<u32>, txs: &BTreeSet<u32>) -> Result<()> {
        validate_hardened_allowlists(notes, txs, 1, 2, 3, 4, 5, 6, 7, 8)
    }

    #[test]
    fn security_allowlist_accepts_exact_hardened_surface() {
        assert!(validate(&expected(), &BTreeSet::from([8])).is_ok());
    }

    #[test]
    fn security_allowlist_rejects_missing_or_unexpected_roots() {
        let mut missing = expected();
        missing.remove(&3);
        assert!(validate(&missing, &BTreeSet::from([8])).is_err());

        let mut extra = expected();
        extra.insert(9);
        assert!(validate(&extra, &BTreeSet::from([8])).is_err());

        let mut p2id_reintroduced = expected();
        p2id_reintroduced.insert(7);
        assert!(validate(&p2id_reintroduced, &BTreeSet::from([8])).is_err());
        let mut config_root_reintroduced = expected();
        config_root_reintroduced.insert(5);
        assert!(validate(&config_root_reintroduced, &BTreeSet::from([8])).is_err());
        let mut activation_root_reintroduced = expected();
        activation_root_reintroduced.insert(6);
        assert!(validate(&activation_root_reintroduced, &BTreeSet::from([8])).is_err());
    }

    #[test]
    fn security_allowlist_rejects_transaction_script_broadening() {
        assert!(validate(&expected(), &BTreeSet::from([8, 9])).is_err());
        assert!(validate(&expected(), &BTreeSet::new()).is_err());
    }

    #[test]
    fn security_activation_constants_match_stable_v016_apis() {
        let slot =
            StorageSlotName::new("miden::standards::auth::network_account::allowed_note_scripts")
                .unwrap();
        assert_eq!(
            slot.id().suffix().as_canonical_u64(),
            pinned_auth_ids::ALLOWED_NOTE_SCRIPTS_SLOT_SUFFIX
        );
        assert_eq!(
            slot.id().prefix().as_canonical_u64(),
            pinned_auth_ids::ALLOWED_NOTE_SCRIPTS_SLOT_PREFIX
        );
        assert_eq!(
            NetworkAccountConfigNote::script_root().as_word(),
            Word::new(pinned_auth_ids::NETWORK_ACCOUNT_CONFIG_ROOT.map(|n| Felt::new(n).unwrap()))
        );
        assert_eq!(
            FeeSponsorshipNote::script_root().as_word(),
            Word::new(pinned_auth_ids::FEE_SPONSORSHIP_ROOT.map(|n| Felt::new(n).unwrap()))
        );
    }
}

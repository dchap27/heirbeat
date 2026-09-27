use anyhow::{ensure, Context, Result};
use miden_client::account::AccountId;
use miden_protocol::{
    asset::FungibleAsset,
    crypto::rand::FeltRng,
    note::{Note, NoteId},
};
use miden_standards::note::{FeeSponsorshipNote, FeeSponsorshipNoteStorage, P2idNote};

pub const DEFAULT_NETWORK_SPONSORSHIP_AMOUNT: u64 = 150;

/// The CLI's existing conservative reserve for an ordinary wallet transaction, expressed as
/// verification-base-fee units (also used by the payout-consumption preflight).
pub const WALLET_FEE_RESERVE_UNITS: u64 = 17;

/// Estimates the wallet transaction fee using the current verification base fee and the
/// conservative reserve already used by the CLI for normal-wallet transactions.
pub fn estimated_wallet_transaction_fee(verification_base_fee: u32) -> Result<u64> {
    u64::from(verification_base_fee)
        .checked_mul(WALLET_FEE_RESERVE_UNITS)
        .context("estimated wallet transaction fee overflowed")
}

/// Returns the native balance required to fund a sponsorship note, the ordinary wallet
/// transaction fee reserve, and any additional native assets sent in the same transaction.
pub fn required_native_for_sponsorship(
    sponsorship_amount: u64,
    verification_base_fee: u32,
    other_native_outputs: u64,
) -> Result<u64> {
    sponsorship_amount
        .checked_add(estimated_wallet_transaction_fee(verification_base_fee)?)
        .and_then(|amount| amount.checked_add(other_native_outputs))
        .context("required native balance for sponsorship overflowed")
}

/// Fails before submission when a normal wallet cannot fund both sponsorship and its own
/// transaction reserve. `account_label` and `operation` keep the user-facing error actionable.
pub fn ensure_sufficient_native_for_sponsorship(
    account_label: &str,
    operation: &str,
    available: u64,
    sponsorship_amount: u64,
    verification_base_fee: u32,
    other_native_outputs: u64,
) -> Result<()> {
    let required = required_native_for_sponsorship(
        sponsorship_amount,
        verification_base_fee,
        other_native_outputs,
    )?;
    ensure!(
        available >= required,
        "{account_label} has insufficient native fee balance for {operation} sponsorship. Required: {required}, available: {available}. Fund the {account_label} wallet and retry."
    );
    Ok(())
}

/// Builds a normal wallet P2ID fee transfer. This is used for wallet/faucet fee liquidity;
/// Network Account execution instead uses a feature-note-paired `FeeSponsorshipNote`.
pub fn build_wallet_fee_note<R: FeltRng>(
    sender: AccountId,
    target: AccountId,
    fee_faucet: AccountId,
    amount: u64,
    rng: &mut R,
) -> Result<Note> {
    ensure!(amount > 0, "wallet fee transfer amount must be positive");
    Ok(P2idNote::builder()
        .sender(sender)
        .target(target)
        .asset(FungibleAsset::new(fee_faucet, amount)?)
        .note_type(miden_protocol::note::NoteType::Public)
        .generate_serial_number(rng)
        .build()?
        .into())
}

/// Builds the standard Network Account fee note paired to one feature note.
pub fn build_network_sponsorship<R: FeltRng>(
    sender: AccountId,
    vault_id: AccountId,
    feature_note_id: NoteId,
    fee_faucet: AccountId,
    amount: u64,
    rng: &mut R,
) -> Result<Note> {
    ensure!(amount > 0, "network sponsorship amount must be positive");
    Ok(FeeSponsorshipNote::builder()
        .sender(sender)
        .target_account(vault_id)
        .feature_note_id(feature_note_id)
        .asset(FungibleAsset::new(fee_faucet, amount)?)
        .generate_serial_number(rng)
        .build()?
        .into())
}

/// Validates the canonical pairing between a Network Account feature note and its sponsorship.
pub fn ensure_sponsorship_pair(
    feature_note_id: NoteId,
    storage: &[miden_protocol::Felt],
) -> Result<()> {
    let sponsorship = FeeSponsorshipNoteStorage::try_from(storage)?;
    ensure!(
        sponsorship.feature_note_id() == feature_note_id,
        "fee sponsorship note is paired to a different feature note"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sponsorship_preflight_rejects_balance_below_sponsorship_amount() {
        let error =
            ensure_sufficient_native_for_sponsorship("Beneficiary", "claim", 149, 150, 7, 0)
                .unwrap_err()
                .to_string();
        assert!(error.contains("Beneficiary has insufficient native fee balance"));
        assert!(error.contains("claim sponsorship"));
        assert!(error.contains("Required: 269, available: 149"));
        assert!(error.contains("Fund the Beneficiary wallet and retry"));
    }

    #[test]
    fn sponsorship_preflight_rejects_exact_sponsorship_without_fee_reserve() {
        let error =
            ensure_sufficient_native_for_sponsorship("Beneficiary", "claim", 150, 150, 7, 0)
                .unwrap_err()
                .to_string();
        assert!(error.contains("Required: 269, available: 150"));
    }

    #[test]
    fn sponsorship_preflight_accepts_exact_required_balance_and_above() {
        let required = required_native_for_sponsorship(150, 7, 0).unwrap();
        assert_eq!(required, 269);
        assert!(ensure_sufficient_native_for_sponsorship(
            "Beneficiary",
            "claim",
            required,
            150,
            7,
            0,
        )
        .is_ok());
        assert!(ensure_sufficient_native_for_sponsorship(
            "Beneficiary",
            "claim",
            required + 1,
            150,
            7,
            0,
        )
        .is_ok());
    }

    #[test]
    fn sponsorship_preflight_includes_other_native_outputs() {
        assert_eq!(required_native_for_sponsorship(150, 7, 1).unwrap(), 270);
    }

    #[test]
    fn rejects_invalid_or_mismatched_sponsorship_metadata() {
        let feature = NoteId::try_from_hex(
            "0x9a432906999582825c1e15d69f53312a6f8e84c8787bb26029ffcba850cc852d",
        )
        .unwrap();
        let other = NoteId::try_from_hex(
            "0xf5d28de2a49084c4d7126b3701e0024fc4747d0b5e63ef79e05cc8e6385294e0",
        )
        .unwrap();
        assert!(ensure_sponsorship_pair(feature, &[]).is_err());
        assert_ne!(feature, other);
        let sender = AccountId::from_hex("0x39fcc854fe715ad1446afb9859df04").unwrap();
        let faucet = AccountId::from_hex("0x18101fa522c174b165efd4f70a0385").unwrap();
        let mut rng =
            miden_protocol::crypto::rand::RandomCoin::new(miden_protocol::Word::default());
        let note =
            build_network_sponsorship(sender, sender, feature, faucet, 150, &mut rng).unwrap();
        let storage = note.recipient().storage().items();
        assert!(ensure_sponsorship_pair(feature, storage).is_ok());
        assert!(ensure_sponsorship_pair(other, storage).is_err());
    }

    #[test]
    fn security_sponsorship_amount_is_positive_and_independent_of_inherited_asset() {
        let sender = AccountId::from_hex("0x39fcc854fe715ad1446afb9859df04").unwrap();
        let faucet = AccountId::from_hex("0x18101fa522c174b165efd4f70a0385").unwrap();
        let feature = NoteId::try_from_hex(
            "0x9a432906999582825c1e15d69f53312a6f8e84c8787bb26029ffcba850cc852d",
        )
        .unwrap();
        let mut rng =
            miden_protocol::crypto::rand::RandomCoin::new(miden_protocol::Word::default());
        assert!(build_network_sponsorship(sender, sender, feature, faucet, 0, &mut rng).is_err());
        let excessive_but_representable =
            build_network_sponsorship(sender, sender, feature, faucet, u32::MAX as u64, &mut rng)
                .unwrap();
        assert_eq!(
            excessive_but_representable.metadata().sender(),
            sender,
            "sponsorship construction does not change feature-note sender"
        );
        assert!(ensure_sponsorship_pair(
            feature,
            excessive_but_representable.recipient().storage().items()
        )
        .is_ok());
    }

    #[test]
    fn normal_wallet_fee_funding_is_a_public_p2id_note() {
        let account = AccountId::from_hex("0x39fcc854fe715ad1446afb9859df04").unwrap();
        let faucet = AccountId::from_hex("0x18101fa522c174b165efd4f70a0385").unwrap();
        let mut rng =
            miden_protocol::crypto::rand::RandomCoin::new(miden_protocol::Word::default());
        let note = build_wallet_fee_note(account, account, faucet, 151, &mut rng).unwrap();
        assert_eq!(
            note.metadata().note_type(),
            miden_protocol::note::NoteType::Public
        );
        assert_eq!(note.metadata().sender(), account);
        assert_eq!(note.recipient().script().root(), P2idNote::script_root());
        assert!(build_wallet_fee_note(account, account, faucet, 0, &mut rng).is_err());
    }
}

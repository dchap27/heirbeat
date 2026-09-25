use anyhow::{ensure, Result};
use miden_client::account::AccountId;
use miden_protocol::{
    asset::FungibleAsset,
    crypto::rand::FeltRng,
    note::{Note, NoteId},
};
use miden_standards::note::{FeeSponsorshipNote, FeeSponsorshipNoteStorage, P2idNote};

pub const DEFAULT_NETWORK_SPONSORSHIP_AMOUNT: u64 = 150;

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

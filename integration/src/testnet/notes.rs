use anyhow::{ensure, Context, Result};
use miden_client::account::AccountId;
use miden_protocol::note::Note;
use miden_standards::note::{AccountTargetNetworkNote, NetworkAccountTarget, NoteExecutionHint};

pub fn network_target(vault_id: AccountId) -> Result<NetworkAccountTarget> {
    NetworkAccountTarget::new(vault_id, NoteExecutionHint::Always).map_err(Into::into)
}

pub fn assert_network_target(note: &Note, expected_vault: AccountId) -> Result<()> {
    let attached = NetworkAccountTarget::try_from(note.attachments())
        .context("feature note has no valid NetworkAccountTarget attachment")?;
    let wrapped = AccountTargetNetworkNote::new(note.clone())
        .context("feature note cannot be used by the Network Account builder")?;
    ensure!(
        attached.target_id() == expected_vault,
        "NetworkAccountTarget attachment points to {}, expected {expected_vault}",
        attached.target_id()
    );
    ensure!(
        wrapped.target_account_id() == expected_vault,
        "NetworkAccountTarget wrapper resolves to a different account"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use miden_protocol::{note::NoteAttachment, Word};
    use miden_standards::testing::note::NoteBuilder;

    #[test]
    fn target_is_constructed_with_always_hint() {
        let account = AccountId::from_hex("0x39fcc854fe715ad1446afb9859df04").unwrap();
        let target = network_target(account).unwrap();
        assert_eq!(target.target_id(), account);
        assert_eq!(target.execution_hint(), NoteExecutionHint::Always);
    }

    fn public_account(hex: &str) -> AccountId {
        AccountId::from_hex(hex).unwrap()
    }

    fn note_with_attachment(sender: AccountId, attachment: impl Into<NoteAttachment>) -> Note {
        NoteBuilder::new(sender, rand::rng())
            .attachment(attachment)
            .build()
            .unwrap()
    }

    #[test]
    fn security_target_accepts_only_the_intended_vault() {
        let vault = public_account("0x39fcc854fe715ad1446afb9859df04");
        let owner = public_account("0xa61714a99ec7619109e397cbac32cd");
        let note = note_with_attachment(owner, network_target(vault).unwrap());
        assert_network_target(&note, vault).unwrap();
    }

    #[test]
    fn security_target_rejects_wrong_and_unrelated_network_accounts() {
        let vault = public_account("0x39fcc854fe715ad1446afb9859df04");
        let other = public_account("0x0204e51ba4ed7ad12a91576128ee90");
        let note = note_with_attachment(other, network_target(other).unwrap());
        let error = assert_network_target(&note, vault).unwrap_err().to_string();
        assert!(error.contains("expected"));
    }

    #[test]
    fn security_target_rejects_missing_and_malformed_attachments() {
        let vault = public_account("0x39fcc854fe715ad1446afb9859df04");
        let owner = public_account("0xa61714a99ec7619109e397cbac32cd");
        let missing = NoteBuilder::new(owner, rand::rng()).build().unwrap();
        assert!(assert_network_target(&missing, vault).is_err());

        let malformed = NoteAttachment::with_words(
            NetworkAccountTarget::ATTACHMENT_SCHEME,
            vec![Word::default(), Word::default()],
        )
        .unwrap();
        let malformed_note = note_with_attachment(owner, malformed);
        assert!(assert_network_target(&malformed_note, vault).is_err());
    }
}

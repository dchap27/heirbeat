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

    #[test]
    fn target_is_constructed_with_always_hint() {
        let account = AccountId::from_hex("0x39fcc854fe715ad1446afb9859df04").unwrap();
        let target = network_target(account).unwrap();
        assert_eq!(target.target_id(), account);
        assert_eq!(target.execution_hint(), NoteExecutionHint::Always);
    }
}

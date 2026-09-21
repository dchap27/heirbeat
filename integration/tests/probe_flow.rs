//! Runtime viability probe using the prebuilt contract packages and v0.15 MockChain.

use std::{collections::BTreeSet, path::Path};

use anyhow::{Context, Result};
use miden_mast_package::Package;
use miden_protocol::{
    account::{
        component::InitStorageData, Account, AccountBuilder, AccountComponent, AccountType,
        StorageSlotName,
    },
    note::{NoteScript, NoteScriptRoot, NoteTag},
    transaction::RawOutputNote,
    utils::serde::Deserializable,
    Felt, Word,
};
use miden_standards::{
    account::auth::{AuthNetworkAccount, NetworkAccount, NetworkAccountTxScriptAllowlist},
    errors::standards::ERR_NOTE_SCRIPT_ALLOWLIST_NOTE_NOT_ALLOWED,
    testing::note::NoteBuilder,
};
use miden_testing::{assert_transaction_executor_error, MockChain};

fn load_package(contract: &str) -> Result<Package> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
        "../contracts/{contract}/target/miden/release/{contract}.masp"
    ));
    let bytes = std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
    Package::read_from_bytes(&bytes)
        .with_context(|| format!("Package::read_from_bytes({})", path.display()))
}

#[test]
fn compiled_packages_load() -> Result<()> {
    // Inspect both supplied artifacts even when the first one fails to deserialize.
    let account = load_package("probe-account");
    let note = load_package("touch-note");
    for (name, result) in [("probe-account", &account), ("touch-note", &note)] {
        match result {
            Ok(_) => println!("{name}: package loaded"),
            Err(error) => eprintln!("{name}: {error:#}"),
        }
    }
    account?;
    note?;
    Ok(())
}

fn setup() -> Result<(Account, NoteScript, StorageSlotName)> {
    let package = load_package("probe-account")?;
    let metadata = miden_protocol::account::component::AccountComponentMetadata::try_from(&package)
        .context("extracting probe-account component metadata")?;
    let names: Vec<_> = metadata.storage_schema().slots().keys().cloned().collect();
    anyhow::ensure!(names.len() == 1, "probe must have exactly one storage slot");
    let last_seen = names[0].clone();
    anyhow::ensure!(last_seen.as_str().ends_with("::last_seen"));
    let mut init = InitStorageData::default();
    init.insert_value(last_seen.as_str(), Word::default())?;
    let component = AccountComponent::from_package(&package, &init)
        .context("AccountComponent::from_package(probe-account)")?;
    let script = NoteScript::from_package(&load_package("touch-note")?)
        .context("NoteScript::from_package(touch-note)")?;
    let auth = AuthNetworkAccount::with_allowed_notes(BTreeSet::from([script.root()]))?;
    // Seed an existing public account into MockChain genesis, as in the upstream auth tests.
    let account = AccountBuilder::new([42; 32])
        .account_type(AccountType::Public)
        .with_component(component)
        .with_auth_component(auth)
        .build_existing()?;
    assert_network_account(&account, script.root())?;
    Ok((account, script, last_seen))
}

fn assert_network_account(account: &Account, root: NoteScriptRoot) -> Result<()> {
    assert!(account.is_public());
    let network = NetworkAccount::new(account.clone())?;
    assert_eq!(
        network.allowed_notes().allowed_script_roots(),
        &BTreeSet::from([root])
    );
    assert!(
        NetworkAccountTxScriptAllowlist::try_from(account.storage())?
            .allowed_script_roots()
            .is_empty()
    );
    Ok(())
}

#[tokio::test]
async fn network_account_touch_flow() -> Result<()> {
    let (account, script, last_seen) = setup()?;
    let mut builder = MockChain::builder();
    let note = NoteBuilder::new(account.id(), builder.rng_mut())
        .tag(NoteTag::with_account_target(account.id()).into())
        .script(script.clone())
        .build()?;
    builder.add_account(account.clone())?;
    builder.add_output_note(RawOutputNote::Full(note.clone()));
    let mut chain = builder.build()?;
    let initial = chain
        .committed_account(account.id())?
        .storage()
        .get_item(&last_seen)?;
    assert_eq!(initial, Word::default());
    assert!(chain.is_note_committed(&note.id()));

    // AuthNetworkAccount permits omission of a transaction script; none is allowlisted or run.
    let executed = chain
        .build_tx_context(account.id(), &[note.id()], &[])?
        .build()?
        .execute()
        .await
        .context("executing compiled touch-note against Network Account")?;
    chain.add_pending_executed_transaction(&executed)?;
    chain.prove_next_block()?;
    let reloaded = chain.committed_account(account.id())?;
    let final_value = reloaded.storage().get_item(&last_seen)?;
    assert_ne!(final_value, initial);
    assert_eq!(
        final_value,
        Word::new([Felt::ONE, Felt::ZERO, Felt::ZERO, Felt::ZERO])
    );
    assert_eq!(
        reloaded.to_commitment(),
        executed.final_account().to_commitment()
    );
    assert!(chain.is_note_consumed(&note.nullifier()));
    assert_network_account(reloaded, script.root())?;
    println!("last_seen: {initial:?} -> {final_value:?} (committed MockChain state)");
    Ok(())
}

#[tokio::test]
async fn network_account_rejects_unallowlisted_note() -> Result<()> {
    let (account, script, last_seen) = setup()?;
    let mut builder = MockChain::builder();
    let touch = NoteBuilder::new(account.id(), builder.rng_mut())
        .script(script.clone())
        .build()?;
    let denied = NoteBuilder::new(account.id(), builder.rng_mut())
        .code("@note_script pub proc main push.1 drop end")
        .build()?;
    assert_ne!(denied.script().root(), script.root());
    builder.add_account(account.clone())?;
    builder.add_output_note(RawOutputNote::Full(touch.clone()));
    builder.add_output_note(RawOutputNote::Full(denied.clone()));
    let mut chain = builder.build()?;
    let before = chain.committed_account(account.id())?.clone();
    // Include the real mutating touch note: rejection must prevent that mutation from committing.
    let result = chain
        .build_tx_context(account.id(), &[touch.id(), denied.id()], &[])?
        .build()?
        .execute()
        .await;
    assert_transaction_executor_error!(result, ERR_NOTE_SCRIPT_ALLOWLIST_NOTE_NOT_ALLOWED);
    chain.prove_next_block()?;
    assert_eq!(chain.committed_account(account.id())?, &before);
    assert_eq!(
        chain
            .committed_account(account.id())?
            .storage()
            .get_item(&last_seen)?,
        Word::default()
    );
    assert!(!chain.is_note_consumed(&touch.nullifier()));
    assert!(!chain.is_note_consumed(&denied.nullifier()));
    Ok(())
}

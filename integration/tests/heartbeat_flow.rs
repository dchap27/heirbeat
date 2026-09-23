//! Heartbeat execution uses committed notes produced by signature-authenticated wallets.
use std::{collections::BTreeSet, path::Path};

use anyhow::{Context, Result};
use miden_mast_package::Package;
use miden_protocol::{
    account::{
        auth::AuthScheme, component::InitStorageData, Account, AccountBuilder, AccountComponent,
        AccountId, AccountType, StorageSlotName,
    },
    errors::MasmError,
    note::{Note, NoteScript, NoteScriptRoot, NoteTag, PartialNote},
    transaction::RawOutputNote,
    utils::serde::Deserializable,
    Felt, Word,
};
use miden_standards::{
    account::{
        auth::{AuthNetworkAccount, NetworkAccount, NetworkAccountTxScriptAllowlist},
        interface::{AccountInterface, AccountInterfaceError, AccountInterfaceExt},
    },
    errors::standards::ERR_NOTE_SCRIPT_ALLOWLIST_NOTE_NOT_ALLOWED,
    testing::note::NoteBuilder,
};
use miden_testing::{assert_transaction_executor_error, Auth, MockChain};

const TIMEOUT: u32 = 100;

fn package(name: &str) -> Result<Package> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
        "../contracts/{name}/target/miden/release/{name}.masp"
    ));
    Package::read_from_bytes(&std::fs::read(&path)?)
        .with_context(|| format!("loading {}", path.display()))
}

fn slot(name: &str) -> StorageSlotName {
    StorageSlotName::new(format!("heirbeat_vault::heirbeat_vault::{name}")).unwrap()
}

fn owner_word(id: AccountId) -> Word {
    Word::new([Felt::ZERO, Felt::ZERO, id.suffix(), id.prefix().as_felt()])
}

fn scalar(account: &Account, name: &str) -> Result<u32> {
    let word = account.storage().get_item(&slot(name))?;
    anyhow::ensure!(word[1..4] == [Felt::ZERO; 3]);
    Ok(u32::try_from(word[0].as_canonical_u64())?)
}

// Both operands are validated u32 values. Their sum fits u64 without Felt or u32 wrapping.
fn deadline(account: &Account) -> Result<u64> {
    Ok(
        u64::from(scalar(account, "last_check_in")?)
            + u64::from(scalar(account, "timeout_blocks")?),
    )
}

struct Harness {
    chain: MockChain,
    owner: Account,
    attacker: Account,
    vault: AccountId,
    script: NoteScript,
}

impl Harness {
    fn new() -> Result<Self> {
        let mut builder = MockChain::builder();
        let auth = Auth::BasicAuth {
            auth_scheme: AuthScheme::Falcon512Poseidon2,
        };
        let owner = builder.add_existing_wallet(auth.clone())?;
        let attacker = builder.add_existing_wallet(auth)?;
        let script = NoteScript::from_package(&package("check-in-note")?)?;
        let mut init = InitStorageData::default();
        init.insert_value(slot("owner").as_str(), owner_word(owner.id()))?;
        init.insert_value(slot("last_check_in").as_str(), Word::default())?;
        init.insert_value(
            slot("timeout_blocks").as_str(),
            Word::new([Felt::from(TIMEOUT), Felt::ZERO, Felt::ZERO, Felt::ZERO]),
        )?;
        let component = AccountComponent::from_package(&package("heirbeat-vault")?, &init)?;
        assert_eq!(component.storage_slots().len(), 3);
        let vault = AccountBuilder::new([42; 32])
            .account_type(AccountType::Public)
            .with_component(component)
            .with_auth_component(AuthNetworkAccount::with_allowed_notes(BTreeSet::from([
                script.root(),
            ]))?)
            .build_existing()?;
        assert_network(&vault, script.root())?;
        builder.add_account(vault.clone())?;
        let chain = builder.build()?;
        let h = Self {
            chain,
            owner,
            attacker,
            vault: vault.id(),
            script,
        };
        assert_eq!(
            h.state()?.storage().get_item(&slot("owner"))?,
            owner_word(h.owner.id())
        );
        assert_eq!(scalar(h.state()?, "timeout_blocks")?, TIMEOUT);
        assert_eq!(scalar(h.state()?, "last_check_in")?, 0);
        Ok(h)
    }

    fn state(&self) -> Result<&Account> {
        self.chain.committed_account(self.vault)
    }

    fn note(&self, sender: AccountId, serial: u32) -> Result<Note> {
        let mut builder = MockChain::builder();
        Ok(NoteBuilder::new(sender, builder.rng_mut())
            .serial_number(Word::from([serial, 0, 0, 0]))
            .tag(NoteTag::with_account_target(self.vault).into())
            .script(self.script.clone())
            .build()?)
    }

    async fn send(&mut self, sender: AccountId, notes: &[Note]) -> Result<()> {
        let account = self.chain.committed_account(sender)?;
        let partial: Vec<_> = notes.iter().cloned().map(PartialNote::from).collect();
        let script =
            AccountInterface::from_account(account).build_send_notes_script(&partial, None)?;
        let executed = self
            .chain
            .build_tx_context(sender, &[], &[])?
            .tx_script(script)
            .extend_expected_output_notes(notes.iter().cloned().map(RawOutputNote::Full).collect())
            .build()?
            .execute()
            .await?;
        assert_eq!(executed.output_notes().num_notes(), notes.len());
        for note in executed.output_notes().iter() {
            assert_eq!(note.metadata().sender(), sender);
        }
        self.chain.add_pending_executed_transaction(&executed)?;
        self.chain.prove_next_block()?;
        for note in notes {
            assert!(self.chain.is_note_committed(&note.id()));
        }
        Ok(())
    }

    async fn check_in(&mut self, note: &Note) -> Result<u32> {
        let reference = self.chain.latest_block_header().block_num().as_u32();
        let executed = self
            .chain
            .build_tx_context(self.vault, &[note.id()], &[])?
            .build()?
            .execute()
            .await?;
        assert_eq!(executed.block_header().block_num().as_u32(), reference);
        self.chain.add_pending_executed_transaction(&executed)?;
        self.chain.prove_next_block()?;
        assert_eq!(scalar(self.state()?, "last_check_in")?, reference);
        assert_eq!(
            self.state()?.to_commitment(),
            executed.final_account().to_commitment()
        );
        assert!(self.chain.is_note_consumed(&note.nullifier()));
        assert_network(self.state()?, self.script.root())?;
        Ok(reference)
    }
}

fn assert_network(account: &Account, root: NoteScriptRoot) -> Result<()> {
    assert!(account.is_public());
    assert_eq!(
        NetworkAccount::new(account.clone())?
            .allowed_notes()
            .allowed_script_roots(),
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
async fn owner_heartbeat_persists_and_deadline_advances() -> Result<()> {
    let mut h = Harness::new()?;
    let initial_deadline = deadline(h.state()?)?;
    let note = h.note(h.owner.id(), 1)?;
    assert!(note.assets().is_empty());
    h.send(h.owner.id(), &[note.clone()]).await?;
    let first = h.check_in(&note).await?;
    assert_eq!(first, 1);
    let first_deadline = deadline(h.state()?)?;
    assert_eq!(first_deadline, initial_deadline + u64::from(first));
    h.chain.prove_next_block()?;
    h.chain.prove_next_block()?;
    let note = h.note(h.owner.id(), 2)?;
    h.send(h.owner.id(), &[note.clone()]).await?;
    let second = h.check_in(&note).await?;
    assert_eq!(second, 5);
    assert_eq!(second, first + 4); // first commit + two empty blocks + second send
    assert_eq!(
        deadline(h.state()?)? - first_deadline,
        u64::from(second - first)
    );
    assert_eq!(
        h.state()?.storage().get_item(&slot("owner"))?,
        owner_word(h.owner.id())
    );
    assert_eq!(scalar(h.state()?, "timeout_blocks")?, TIMEOUT);
    println!(
        "heartbeat 0 -> {first} -> {second}; deadline {initial_deadline} -> {first_deadline} -> {}",
        deadline(h.state()?)?
    );
    Ok(())
}

#[tokio::test]
async fn wrong_owner_cannot_check_in() -> Result<()> {
    let mut h = Harness::new()?;
    let note = h.note(h.attacker.id(), 3)?;
    h.send(h.attacker.id(), &[note.clone()]).await?;
    let before = h.state()?.clone();
    let result = h
        .chain
        .build_tx_context(h.vault, &[note.id()], &[])?
        .build()?
        .execute()
        .await;
    // The Rust SDK lowers a failed assert! to a VM unreachable-code assertion.
    assert_transaction_executor_error!(
        result,
        MasmError::from_static_str("entered unreachable code")
    );
    h.chain.prove_next_block()?;
    assert_eq!(h.state()?, &before);
    assert!(!h.chain.is_note_consumed(&note.nullifier()));
    Ok(())
}

#[tokio::test]
async fn attacker_cannot_spoof_owner_sender() -> Result<()> {
    let mut h = Harness::new()?;
    // Untrusted host metadata can be constructed. The wallet send API must reject it.
    let forged = h.note(h.owner.id(), 4)?;
    assert_eq!(forged.metadata().sender(), h.owner.id());
    let result = AccountInterface::from_account(&h.attacker)
        .build_send_notes_script(&[PartialNote::from(forged.clone())], None);
    assert!(
        matches!(result, Err(AccountInterfaceError::InvalidSenderAccount(id)) if id == h.owner.id()),
        "SECURITY BLOCKER: attacker send script accepted forged owner metadata"
    );
    // Bypass the host guard: build for the owner, then execute that same script as attacker.
    // The kernel must stamp the attacker's ID, regardless of the supplied host metadata.
    let script = AccountInterface::from_account(&h.owner)
        .build_send_notes_script(&[PartialNote::from(forged.clone())], None)?;
    let actual = h.note(h.attacker.id(), 4)?;
    let executed = h
        .chain
        .build_tx_context(h.attacker.id(), &[], &[])?
        .tx_script(script)
        .extend_expected_output_notes(vec![RawOutputNote::Full(actual.clone())])
        .build()?
        .execute()
        .await?;
    let output = executed.output_notes().get_note(0);
    assert_eq!(
        output.metadata().sender(),
        h.attacker.id(),
        "SECURITY BLOCKER: kernel permitted forged owner sender"
    );
    assert_ne!(output.id(), forged.id());
    h.chain.add_pending_executed_transaction(&executed)?;
    h.chain.prove_next_block()?;
    assert!(h.chain.is_note_committed(&actual.id()));
    assert!(!h.chain.is_note_committed(&forged.id()));
    assert_eq!(scalar(h.state()?, "last_check_in")?, 0);
    Ok(())
}

#[tokio::test]
async fn unallowlisted_note_cannot_mutate_vault() -> Result<()> {
    let mut h = Harness::new()?;
    let allowed = h.note(h.owner.id(), 5)?;
    let mut builder = MockChain::builder();
    let denied = NoteBuilder::new(h.owner.id(), builder.rng_mut())
        .tag(NoteTag::with_account_target(h.vault).into())
        .code("@note_script pub proc main push.1 drop end")
        .build()?;
    assert_ne!(denied.script().root(), h.script.root());
    h.send(h.owner.id(), &[allowed.clone(), denied.clone()])
        .await?;
    let before = h.state()?.clone();
    let result = h
        .chain
        .build_tx_context(h.vault, &[allowed.id(), denied.id()], &[])?
        .build()?
        .execute()
        .await;
    assert_transaction_executor_error!(result, ERR_NOTE_SCRIPT_ALLOWLIST_NOTE_NOT_ALLOWED);
    h.chain.prove_next_block()?;
    assert_eq!(h.state()?, &before);
    assert!(!h.chain.is_note_consumed(&allowed.nullifier()));
    assert!(!h.chain.is_note_consumed(&denied.nullifier()));
    Ok(())
}

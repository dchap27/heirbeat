//! Heartbeat and claim execution uses committed notes produced by signature-authenticated wallets.
use std::{collections::BTreeSet, path::Path};

use anyhow::{Context, Result};
use miden_mast_package::Package;
use miden_protocol::{
    account::{
        auth::AuthScheme, component::InitStorageData, Account, AccountBuilder, AccountComponent,
        AccountId, AccountType, StorageSlotName,
    },
    asset::{Asset, AssetAmount, FungibleAsset, NonFungibleAsset},
    errors::MasmError,
    note::{Note, NoteScript, NoteScriptRoot, NoteTag, NoteType, PartialNote},
    transaction::RawOutputNote,
    utils::serde::Deserializable,
    Felt, Word,
};
use miden_standards::{
    account::{
        access::AccessControl,
        auth::{
            AuthNetworkAccount, NetworkAccount, NetworkAccountNoteAllowlist,
            NetworkAccountTxScriptAllowlist,
        },
        fees::{BasicConstantFeePolicy, FeePolicyManager},
        wallets::BasicWallet,
    },
    errors::standards::ERR_NOTE_SCRIPT_ALLOWLIST_NOTE_NOT_ALLOWED,
    note::{FeeSponsorshipNote, NetworkAccountConfigNote, P2idNote},
    testing::note::NoteBuilder,
    tx_script::{ExpirationTransactionScript, SendNotesTransactionScript},
};
use miden_testing::{assert_transaction_executor_error, Auth, MockChain};

#[path = "../../contracts/heirbeat-vault/src/p2id.rs"]
mod pinned_p2id;

fn supported(amount: u64) -> Asset {
    FungibleAsset::mock(amount)
}
fn unsupported() -> Asset {
    FungibleAsset::new(
        miden_protocol::testing::account_id::ACCOUNT_ID_PUBLIC_FUNGIBLE_FAUCET_1
            .try_into()
            .unwrap(),
        50,
    )
    .unwrap()
    .into()
}
fn balance(account: &Account) -> u64 {
    account
        .vault()
        .get_balance(
            FungibleAsset::new(FungibleAsset::mock_issuer(), 1)
                .unwrap()
                .id(),
        )
        .unwrap()
        .into()
}

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
    beneficiary: Account,
    vault: AccountId,
    script: NoteScript,
    claim_script: NoteScript,
    deposit_script: NoteScript,
}

impl Harness {
    fn new() -> Result<Self> {
        Self::configured(TIMEOUT, 0)
    }

    fn configured(timeout: u32, initial_last: u32) -> Result<Self> {
        let mut builder = MockChain::builder();
        let auth = Auth::BasicAuth {
            auth_scheme: AuthScheme::Falcon512Poseidon2,
        };
        let owner = builder.add_existing_wallet_with_assets(auth.clone(), [supported(1000)])?;
        let beneficiary = builder.add_existing_wallet(auth.clone())?;
        let attacker = builder.add_existing_wallet_with_assets(
            auth,
            [
                supported(1000),
                unsupported(),
                NonFungibleAsset::mock(&[1, 2, 3]),
            ],
        )?;
        let script = NoteScript::from_package(&package("check-in-note")?)?;
        let claim_script = NoteScript::from_package(&package("claim-note")?)?;
        let deposit_script = NoteScript::from_package(&package("deposit-note")?)?;
        assert_eq!(
            P2idNote::script_root().as_word(),
            Word::new(pinned_p2id::P2ID_ROOT.map(|value| Felt::new(value).unwrap()))
        );
        let mut init = InitStorageData::default();
        init.insert_value(
            slot("asset_faucet").as_str(),
            owner_word(FungibleAsset::mock_issuer()),
        )?;
        init.insert_value(slot("owner").as_str(), owner_word(owner.id()))?;
        init.insert_value(slot("beneficiary").as_str(), owner_word(beneficiary.id()))?;
        init.insert_value(slot("claimed").as_str(), Word::default())?;
        init.insert_value(
            slot("last_check_in").as_str(),
            Word::from([initial_last, 0, 0, 0]),
        )?;
        init.insert_value(
            slot("timeout_blocks").as_str(),
            Word::new([Felt::from(timeout), Felt::ZERO, Felt::ZERO, Felt::ZERO]),
        )?;
        let component = AccountComponent::from_package(&package("heirbeat-vault")?, &init)?;
        assert_eq!(component.storage_slots().len(), 6);
        let allowed = BTreeSet::from([script.root(), claim_script.root(), deposit_script.root()]);
        // MockChain has zero verification fees. Explicit zero note fees preserve
        // the exact inherited amounts without introducing a second asset class.
        let mut policy = BasicConstantFeePolicy::new();
        for root in &allowed {
            policy = policy.with_fee(*root, AssetAmount::ZERO);
        }
        let fee_manager = FeePolicyManager::builder()
            .active_fee_policy(policy.into())
            .fee_faucet_id(miden_protocol::testing::account_id::ACCOUNT_ID_FEE_FAUCET.try_into()?)
            .build();
        let vault = AccountBuilder::new([42; 32])
            .account_type(AccountType::Public)
            .with_component(component)
            // `new` adds configuration/sponsorship notes and an expiration script.
            // `custom` preserves exactly our three roots and an empty tx allowlist.
            .with_components(AuthNetworkAccount::custom(allowed, fee_manager)?)
            .build_existing()?;
        assert_network(
            &vault,
            [script.root(), claim_script.root(), deposit_script.root()],
        )?;
        builder.add_account(vault.clone())?;
        let chain = builder.build()?;
        let h = Self {
            chain,
            owner,
            attacker,
            beneficiary,
            vault: vault.id(),
            script,
            claim_script,
            deposit_script,
        };
        assert_eq!(
            h.state()?.storage().get_item(&slot("owner"))?,
            owner_word(h.owner.id())
        );
        assert_eq!(
            h.state()?.storage().get_item(&slot("beneficiary"))?,
            owner_word(h.beneficiary.id())
        );
        assert_eq!(scalar(h.state()?, "claimed")?, 0);
        assert_eq!(
            deadline(h.state()?)?,
            u64::from(initial_last) + u64::from(timeout)
        );
        assert_eq!(scalar(h.state()?, "timeout_blocks")?, timeout);
        assert_eq!(scalar(h.state()?, "last_check_in")?, initial_last);
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
        let script = SendNotesTransactionScript::new(&account.code_interface(), &partial)?;
        let executed = self
            .chain
            .build_transaction(sender)
            .send_notes_script(&script)
            .expected_output_notes(notes.iter().cloned().map(RawOutputNote::Full).collect())
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

    fn claim_note(&self, sender: AccountId, serial: u32) -> Result<Note> {
        let mut builder = MockChain::builder();
        let note = NoteBuilder::new(sender, builder.rng_mut())
            .serial_number(Word::from([serial, 0, 0, 0]))
            .tag(NoteTag::with_account_target(self.vault).into())
            .script(self.claim_script.clone())
            .build()?;
        assert!(note.assets().is_empty());
        Ok(note)
    }

    fn advance_to(&mut self, reference: u32) -> Result<()> {
        assert!(self.chain.latest_block_header().block_num().as_u32() <= reference);
        while self.chain.latest_block_header().block_num().as_u32() < reference {
            self.chain.prove_next_block()?;
        }
        Ok(())
    }

    async fn reject(&mut self, note: &Note) -> Result<()> {
        let beneficiary_before = self.chain.committed_account(self.beneficiary.id())?.clone();
        let notes_before = self.chain.committed_notes().len();
        let before = self.state()?.clone();
        let result = self
            .chain
            .build_transaction(self.vault)
            .authenticated_input_note(note.id())
            .build()?
            .execute()
            .await;
        assert_transaction_executor_error!(
            result,
            MasmError::from_static_str("entered unreachable code")
        );
        self.chain.prove_next_block()?;
        assert_eq!(self.state()?, &before);
        assert!(!self.chain.is_note_consumed(&note.nullifier()));
        assert_eq!(self.chain.committed_notes().len(), notes_before);
        assert_eq!(
            self.chain.committed_account(self.beneficiary.id())?,
            &beneficiary_before
        );
        Ok(())
    }

    fn payout(&self, claim: &Note, amount: u64) -> Result<Note> {
        let mut builder = MockChain::builder();
        Ok(NoteBuilder::new(self.vault, builder.rng_mut())
            .serial_number(claim.serial_num())
            .tag(NoteTag::with_account_target(self.beneficiary.id()).into())
            .script(P2idNote::script())
            .note_storage([
                self.beneficiary.id().suffix(),
                self.beneficiary.id().prefix().as_felt(),
            ])?
            .add_assets([supported(amount)])
            .build()?)
    }

    fn deposit_note(&self, sender: AccountId, assets: Vec<Asset>, serial: u32) -> Result<Note> {
        let mut builder = MockChain::builder();
        Ok(NoteBuilder::new(sender, builder.rng_mut())
            .serial_number(Word::from([serial, 0, 0, 0]))
            .tag(NoteTag::with_account_target(self.vault).into())
            .script(self.deposit_script.clone())
            .note_storage([self.vault.suffix(), self.vault.prefix().as_felt()])?
            .add_assets(assets)
            .build()?)
    }

    async fn fund(&mut self, sender: AccountId, amount: u64, serial: u32) -> Result<Note> {
        let deposit = self.deposit_note(sender, vec![supported(amount)], serial)?;
        let sender_before = balance(self.chain.committed_account(sender)?);
        self.send(sender, &[deposit.clone()]).await?;
        assert_eq!(
            balance(self.chain.committed_account(sender)?),
            sender_before - amount
        );
        let before = self.state()?.clone();
        let executed = self
            .chain
            .build_transaction(self.vault)
            .authenticated_input_note(deposit.id())
            .build()?
            .execute()
            .await?;
        assert!(executed.output_notes().is_empty());
        self.chain.add_pending_executed_transaction(&executed)?;
        self.chain.prove_next_block()?;
        assert_eq!(
            self.state()?.storage(),
            before.storage(),
            "deposit cannot change protocol state"
        );
        assert_eq!(balance(self.state()?), balance(&before) + amount);
        assert_eq!(
            self.state()?.to_commitment(),
            executed.final_account().to_commitment()
        );
        assert!(self.chain.is_note_consumed(&deposit.nullifier()));
        Ok(deposit)
    }

    async fn receive_payout(&mut self, payout: &Note, amount: u64) -> Result<()> {
        let before = balance(self.chain.committed_account(self.beneficiary.id())?);
        let executed = self
            .chain
            .build_transaction(self.beneficiary.id())
            .authenticated_input_note(payout.id())
            .build()?
            .execute()
            .await?;
        self.chain.add_pending_executed_transaction(&executed)?;
        self.chain.prove_next_block()?;
        assert_eq!(
            balance(self.chain.committed_account(self.beneficiary.id())?),
            before + amount
        );
        assert!(self.chain.is_note_consumed(&payout.nullifier()));
        Ok(())
    }

    async fn claim(&mut self, note: &Note, reference: u32) -> Result<Note> {
        assert_eq!(
            self.chain.latest_block_header().block_num().as_u32(),
            reference
        );
        let before = self.state()?.clone();
        let amount = balance(&before);
        assert!(amount > 0);
        let payout = self.payout(note, amount)?;
        let executed = self
            .chain
            .build_transaction(self.vault)
            .authenticated_input_note(note.id())
            .build()?
            .execute()
            .await?;
        assert_eq!(executed.block_header().block_num().as_u32(), reference);
        assert_eq!(executed.output_notes().num_notes(), 1);
        assert_eq!(
            executed.output_notes().get_note(0),
            &RawOutputNote::Full(payout.clone())
        );
        self.chain.add_pending_executed_transaction(&executed)?;
        self.chain.prove_next_block()?;
        assert_eq!(scalar(self.state()?, "claimed")?, 1);
        for name in [
            "owner",
            "beneficiary",
            "last_check_in",
            "timeout_blocks",
            "asset_faucet",
        ] {
            assert_eq!(
                self.state()?.storage().get_item(&slot(name))?,
                before.storage().get_item(&slot(name))?
            );
        }
        assert_eq!(balance(self.state()?), 0);
        assert!(self.state()?.vault().is_empty());
        assert!(self.chain.is_note_committed(&payout.id()));
        assert_eq!(
            self.state()?.to_commitment(),
            executed.final_account().to_commitment()
        );
        assert!(self.chain.is_note_consumed(&note.nullifier()));
        assert_network(
            self.state()?,
            [
                self.script.root(),
                self.claim_script.root(),
                self.deposit_script.root(),
            ],
        )?;
        Ok(payout)
    }

    async fn check_in(&mut self, note: &Note) -> Result<u32> {
        let reference = self.chain.latest_block_header().block_num().as_u32();
        let executed = self
            .chain
            .build_transaction(self.vault)
            .authenticated_input_note(note.id())
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
        assert_network(
            self.state()?,
            [
                self.script.root(),
                self.claim_script.root(),
                self.deposit_script.root(),
            ],
        )?;
        Ok(reference)
    }
}

fn assert_network(account: &Account, roots: [NoteScriptRoot; 3]) -> Result<()> {
    assert_eq!(BTreeSet::from(roots).len(), 3);
    assert!(account.is_public());
    assert_eq!(
        NetworkAccountNoteAllowlist::try_from(account.storage())?.allowed_script_roots(),
        &BTreeSet::from(roots)
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
        .build_transaction(h.vault)
        .authenticated_input_note(note.id())
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
    let result = SendNotesTransactionScript::new(
        &h.attacker.code_interface(),
        &[PartialNote::from(forged.clone())],
    );
    assert!(
        matches!(result, Err(miden_standards::tx_script::SendNotesTransactionScriptError::InvalidSenderAccount(id)) if id == h.owner.id()),
        "SECURITY BLOCKER: attacker send script accepted forged owner metadata"
    );
    // Bypass the host guard: build for the owner, then execute that same script as attacker.
    // The kernel must stamp the attacker's ID, regardless of the supplied host metadata.
    let script = SendNotesTransactionScript::new(
        &h.owner.code_interface(),
        &[PartialNote::from(forged.clone())],
    )?;
    let actual = h.note(h.attacker.id(), 4)?;
    let executed = h
        .chain
        .build_transaction(h.attacker.id())
        .send_notes_script(&script)
        .expected_output_note(RawOutputNote::Full(actual.clone()))
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
        .build_transaction(h.vault)
        .authenticated_input_notes([allowed.id(), denied.id()])
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

#[tokio::test]
async fn early_claim_then_exact_deadline_and_terminal_state() -> Result<()> {
    let mut h = Harness::configured(6, 0)?;
    assert_ne!(h.owner.id(), h.beneficiary.id());
    assert_eq!(deadline(h.state()?)?, 6);
    let first = h.claim_note(h.beneficiary.id(), 10)?;
    let repeated = h.claim_note(h.beneficiary.id(), 11)?;
    h.send(h.beneficiary.id(), &[first.clone(), repeated.clone()])
        .await?;
    let heartbeat = h.note(h.owner.id(), 12)?;
    h.send(h.owner.id(), &[heartbeat.clone()]).await?;
    h.fund(h.owner.id(), 100, 1001).await?;
    h.advance_to(5)?;
    h.reject(&first).await?; // deadline - 1; rejected note remains available
    assert_eq!(scalar(h.state()?, "claimed")?, 0);
    assert_eq!(h.chain.latest_block_header().block_num().as_u32(), 6);
    h.claim(&first, 6).await?; // exactly deadline, not the commitment block 7
    let terminal_last = scalar(h.state()?, "last_check_in")?;
    h.reject(&repeated).await?;
    h.reject(&heartbeat).await?;
    assert_eq!(scalar(h.state()?, "claimed")?, 1);
    assert_eq!(scalar(h.state()?, "last_check_in")?, terminal_last);
    println!(
        "claim rejected at 5; accepted at deadline 6; repeat and post-claim heartbeat rejected"
    );
    Ok(())
}

#[tokio::test]
async fn wrong_claimant_and_owner_cannot_claim_when_eligible() -> Result<()> {
    let mut h = Harness::configured(6, 0)?;
    h.fund(h.owner.id(), 100, 1003).await?;
    assert_ne!(h.owner.id(), h.beneficiary.id());
    assert_ne!(h.attacker.id(), h.beneficiary.id());
    let attacker = h.claim_note(h.attacker.id(), 20)?;
    let owner = h.claim_note(h.owner.id(), 21)?;
    h.send(h.attacker.id(), &[attacker.clone()]).await?;
    h.send(h.owner.id(), &[owner.clone()]).await?;
    h.advance_to(6)?;
    h.reject(&attacker).await?;
    h.reject(&owner).await?;
    assert_eq!(scalar(h.state()?, "claimed")?, 0);
    Ok(())
}

#[tokio::test]
async fn heartbeat_postpones_claim_until_new_exact_deadline() -> Result<()> {
    let mut h = Harness::configured(6, 0)?;
    let old_deadline = deadline(h.state()?)?;
    let heartbeat = h.note(h.owner.id(), 30)?;
    let claim = h.claim_note(h.beneficiary.id(), 31)?;
    h.send(h.owner.id(), &[heartbeat.clone()]).await?;
    h.send(h.beneficiary.id(), &[claim.clone()]).await?;
    h.advance_to(3)?;
    assert_eq!(h.check_in(&heartbeat).await?, 3);
    let new_deadline = deadline(h.state()?)?;
    assert_eq!((old_deadline, new_deadline), (6, 9));
    h.fund(h.owner.id(), 100, 1002).await?;
    h.advance_to(7)?; // strictly after old deadline, strictly before the new one
    h.reject(&claim).await?;
    assert_eq!(scalar(h.state()?, "claimed")?, 0);
    h.advance_to(9)?;
    h.claim(&claim, 9).await?;
    println!("heartbeat at 3 extends deadline 6 -> 9; claim rejected at 7, accepted at 9");
    Ok(())
}

#[tokio::test]
async fn deadline_above_u32_max_does_not_wrap_into_eligibility() -> Result<()> {
    let mut h = Harness::configured(u32::MAX, 1)?;
    // A nonzero balance isolates the deadline check from the empty-vault guard.
    h.fund(h.owner.id(), 100, 1004).await?;
    assert_eq!(deadline(h.state()?)?, 4_294_967_296);
    let claim = h.claim_note(h.beneficiary.id(), 40)?;
    h.send(h.beneficiary.id(), &[claim.clone()]).await?;
    // Wrapping u32 addition would turn this deadline into 0 and incorrectly allow the claim.
    h.reject(&claim).await?;
    assert_eq!(scalar(h.state()?, "claimed")?, 0);
    Ok(())
}

#[tokio::test]
async fn attacker_cannot_spoof_beneficiary_sender() -> Result<()> {
    let mut h = Harness::configured(6, 0)?;
    h.fund(h.owner.id(), 100, 1005).await?;
    let forged = h.claim_note(h.beneficiary.id(), 50)?;
    assert_eq!(forged.metadata().sender(), h.beneficiary.id());
    let result = SendNotesTransactionScript::new(
        &h.attacker.code_interface(),
        &[PartialNote::from(forged.clone())],
    );
    assert!(
        matches!(result, Err(miden_standards::tx_script::SendNotesTransactionScriptError::InvalidSenderAccount(id)) if id == h.beneficiary.id()),
        "SECURITY BLOCKER: attacker send script accepted forged beneficiary metadata"
    );
    // Deliberately bypass the host guard, then inspect the kernel-produced sender.
    let script = SendNotesTransactionScript::new(
        &h.beneficiary.code_interface(),
        &[PartialNote::from(forged.clone())],
    )?;
    let actual = h.claim_note(h.attacker.id(), 50)?;
    let executed = h
        .chain
        .build_transaction(h.attacker.id())
        .send_notes_script(&script)
        .expected_output_note(RawOutputNote::Full(actual.clone()))
        .build()?
        .execute()
        .await?;
    assert_eq!(executed.output_notes().num_notes(), 1);
    let output = executed.output_notes().get_note(0);
    assert_eq!(
        output.metadata().sender(),
        h.attacker.id(),
        "SECURITY BLOCKER: kernel permitted forged beneficiary sender"
    );
    assert_ne!(output.id(), forged.id());
    h.chain.add_pending_executed_transaction(&executed)?;
    h.chain.prove_next_block()?;
    assert!(h.chain.is_note_committed(&actual.id()));
    assert!(!h.chain.is_note_committed(&forged.id()));
    h.advance_to(6)?;
    h.reject(&actual).await?; // Real committed output cannot authorize a beneficiary claim.
    assert_eq!(scalar(h.state()?, "claimed")?, 0);
    Ok(())
}

#[tokio::test]
async fn single_deposit_full_payout_and_terminal_asset_safety() -> Result<()> {
    let mut h = Harness::configured(8, 0)?;
    assert_eq!(balance(h.state()?), 0);
    h.fund(h.owner.id(), 100, 100).await?;
    assert_eq!(balance(h.state()?), 100);
    assert_eq!(scalar(h.state()?, "claimed")?, 0);
    let claim = h.claim_note(h.beneficiary.id(), 101)?;
    h.send(h.beneficiary.id(), &[claim.clone()]).await?;
    h.advance_to(8)?;
    let payout = h.claim(&claim, 8).await?;
    assert_eq!(payout.script().root(), P2idNote::script_root());
    assert_eq!(
        payout.assets().iter().copied().collect::<Vec<_>>(),
        vec![supported(100)]
    );
    assert_eq!(
        payout.storage().items(),
        &[
            h.beneficiary.id().suffix(),
            h.beneficiary.id().prefix().as_felt()
        ]
    );
    // Binding is enforced by P2ID itself, not just by its routing tag.
    let result = h
        .chain
        .build_transaction(h.attacker.id())
        .authenticated_input_note(payout.id())
        .build()?
        .execute()
        .await;
    assert_transaction_executor_error!(
        result,
        MasmError::from_static_str(
            "P2ID's target account address and transaction address do not match"
        )
    );
    assert!(!h.chain.is_note_consumed(&payout.nullifier()));
    h.receive_payout(&payout, 100).await?;
    assert_eq!(balance(h.chain.committed_account(h.beneficiary.id())?), 100);
    let repeated = h.claim_note(h.beneficiary.id(), 102)?;
    h.send(h.beneficiary.id(), &[repeated.clone()]).await?;
    h.reject(&repeated).await?;
    let heartbeat = h.note(h.owner.id(), 103)?;
    h.send(h.owner.id(), &[heartbeat.clone()]).await?;
    h.reject(&heartbeat).await?;
    let deposit = h.deposit_note(h.owner.id(), vec![supported(25)], 104)?;
    h.send(h.owner.id(), &[deposit.clone()]).await?;
    h.reject(&deposit).await?;
    assert_eq!(balance(h.state()?), 0);
    assert_eq!(scalar(h.state()?, "claimed")?, 1);
    assert_eq!(balance(h.chain.committed_account(h.beneficiary.id())?), 100);
    assert_eq!(scalar(h.state()?, "last_check_in")?, 0);
    println!("single deposit: vault 0 -> 100 -> 0; beneficiary 0 -> 100; terminal deposits/claims/heartbeat rejected");
    Ok(())
}

#[tokio::test]
async fn multiple_deposits_pay_combined_balance() -> Result<()> {
    let mut h = Harness::configured(8, 0)?;
    h.fund(h.owner.id(), 40, 110).await?;
    assert_eq!(balance(h.state()?), 40);
    h.fund(h.attacker.id(), 60, 111).await?; // permissionless funding
    assert_eq!(balance(h.state()?), 100);
    let claim = h.claim_note(h.beneficiary.id(), 112)?;
    h.send(h.beneficiary.id(), &[claim.clone()]).await?;
    h.advance_to(8)?;
    let payout = h.claim(&claim, 8).await?;
    h.receive_payout(&payout, 100).await?;
    assert_eq!(balance(h.state()?), 0);
    assert_eq!(balance(h.chain.committed_account(h.beneficiary.id())?), 100);
    Ok(())
}

#[tokio::test]
async fn early_and_wrong_claimants_cannot_move_assets() -> Result<()> {
    let mut h = Harness::configured(8, 0)?;
    h.fund(h.owner.id(), 100, 120).await?;
    let early = h.claim_note(h.beneficiary.id(), 121)?;
    h.send(h.beneficiary.id(), &[early.clone()]).await?;
    assert!(h.chain.latest_block_header().block_num().as_u32() < 8);
    h.reject(&early).await?;
    let wrong = h.claim_note(h.attacker.id(), 122)?;
    h.send(h.attacker.id(), &[wrong.clone()]).await?;
    h.advance_to(8)?;
    h.reject(&wrong).await?;
    assert_eq!(balance(h.state()?), 100);
    assert_eq!(scalar(h.state()?, "claimed")?, 0);
    assert_eq!(balance(h.chain.committed_account(h.beneficiary.id())?), 0);
    Ok(())
}

#[tokio::test]
async fn zero_balance_claim_does_not_close_vault() -> Result<()> {
    let mut h = Harness::configured(2, 0)?;
    let claim = h.claim_note(h.beneficiary.id(), 130)?;
    h.send(h.beneficiary.id(), &[claim.clone()]).await?;
    h.advance_to(2)?;
    h.reject(&claim).await?;
    assert_eq!(scalar(h.state()?, "claimed")?, 0);
    assert_eq!(balance(h.state()?), 0);
    Ok(())
}

#[tokio::test]
async fn other_faucet_and_nft_deposits_are_rejected_atomically() -> Result<()> {
    let mut h = Harness::configured(8, 0)?;
    for (serial, denied) in [
        (140, unsupported()),
        (141, NonFungibleAsset::mock(&[1, 2, 3])),
    ] {
        // Mixed deposit: even its supported portion must not be retained.
        let note = h.deposit_note(h.attacker.id(), vec![supported(10), denied], serial)?;
        h.send(h.attacker.id(), &[note.clone()]).await?;
        h.reject(&note).await?;
        assert!(h.state()?.vault().is_empty());
    }
    Ok(())
}

#[tokio::test]
async fn failed_transaction_after_payout_rolls_back_claim_and_assets() -> Result<()> {
    let mut h = Harness::configured(8, 0)?;
    h.fund(h.owner.id(), 100, 150).await?;
    let first = h.claim_note(h.beneficiary.id(), 151)?;
    let second = h.claim_note(h.beneficiary.id(), 152)?;
    h.send(h.beneficiary.id(), &[first.clone(), second.clone()])
        .await?;
    h.advance_to(8)?;
    let before = h.state()?.clone();
    let notes_before = h.chain.committed_notes().len();
    // Either ordering first creates a full payout, then the other claim fails the terminal guard.
    let payout_a = h.payout(&first, 100)?;
    let payout_b = h.payout(&second, 100)?;
    let result = h
        .chain
        .build_transaction(h.vault)
        .authenticated_input_notes([first.id(), second.id()])
        .expected_output_notes(vec![
            RawOutputNote::Full(payout_a.clone()),
            RawOutputNote::Full(payout_b.clone()),
        ])
        .build()?
        .execute()
        .await;
    assert_transaction_executor_error!(
        result,
        MasmError::from_static_str("entered unreachable code")
    );
    h.chain.prove_next_block()?;
    assert_eq!(h.state()?, &before);
    assert_eq!(scalar(h.state()?, "claimed")?, 0);
    assert_eq!(balance(h.state()?), 100);
    assert_eq!(h.chain.committed_notes().len(), notes_before);
    assert!(!h.chain.is_note_committed(&payout_a.id()));
    assert!(!h.chain.is_note_committed(&payout_b.id()));
    assert!(!h.chain.is_note_consumed(&first.nullifier()));
    assert!(!h.chain.is_note_consumed(&second.nullifier()));
    // The same claim succeeds alone, proving it was not intrinsically invalid.
    let payout = h.claim(&first, 9).await?;
    h.receive_payout(&payout, 100).await?;
    Ok(())
}

#[tokio::test]
async fn payout_creation_failure_preserves_claim_and_assets() -> Result<()> {
    let mut h = Harness::configured(8, 0)?;
    h.fund(h.owner.id(), 100, 160).await?;
    let claim = h.claim_note(h.beneficiary.id(), 161)?;
    h.send(h.beneficiary.id(), &[claim.clone()]).await?;
    h.advance_to(8)?;
    let before = h.state()?.clone();
    let notes_before = h.chain.committed_notes().len();
    // Corrupt the host's script witness: output creation fails after claimed is
    // written and the asset is removed in the transaction's working state.
    let error = h
        .chain
        .build_transaction(h.vault)
        .authenticated_input_note(claim.id())
        .add_advice_map_entry(P2idNote::script_root().as_word(), vec![Felt::ZERO])
        .build()?
        .execute()
        .await
        .expect_err("malformed P2ID witness must fail");
    assert!(
        format!("{error:?}").contains("MalformedNoteScript"),
        "{error:?}"
    );
    h.chain.prove_next_block()?;
    assert_eq!(h.state()?, &before);
    assert_eq!(balance(h.state()?), 100);
    assert_eq!(scalar(h.state()?, "claimed")?, 0);
    assert_eq!(h.chain.committed_notes().len(), notes_before);
    assert!(!h.chain.is_note_consumed(&claim.nullifier()));
    assert_eq!(balance(h.chain.committed_account(h.beneficiary.id())?), 0);
    let payout = h.claim(&claim, 9).await?;
    h.receive_payout(&payout, 100).await?;
    Ok(())
}

#[tokio::test]
async fn deposit_recipient_is_enforced_independently_of_routing_tag() -> Result<()> {
    let mut h = Harness::configured(8, 0)?;
    let mut builder = MockChain::builder();
    let deposit = NoteBuilder::new(h.owner.id(), builder.rng_mut())
        .serial_number(Word::from([170u32, 0, 0, 0]))
        .tag(NoteTag::with_account_target(h.vault).into())
        .script(h.deposit_script.clone())
        .note_storage([h.attacker.id().suffix(), h.attacker.id().prefix().as_felt()])?
        .add_assets([supported(100)])
        .build()?;
    h.send(h.owner.id(), &[deposit.clone()]).await?;
    // This vault supports the asset and script, but is not the committed recipient.
    h.reject(&deposit).await?;
    assert_eq!(balance(h.state()?), 0);
    Ok(())
}

#[tokio::test]
async fn fee_sponsorship_bootstraps_empty_network_account() -> Result<()> {
    let fee_faucet: AccountId =
        miden_protocol::testing::account_id::ACCOUNT_ID_FEE_FAUCET.try_into()?;
    let inherited_faucet = FungibleAsset::mock_issuer();
    let native_asset = FungibleAsset::new(fee_faucet, 10_000)?;
    let fee_asset: Asset = native_asset.clone().into();

    let auth = Auth::BasicAuth {
        auth_scheme: AuthScheme::Falcon512Poseidon2,
    };
    // MockChain's verification_base_fee remains zero here: setting it nonzero makes the
    // signature-authenticated owner transaction fail because MockTransactionBuilder does not
    // attach the fee-conversion commitment to auth args. This test covers the standard paired
    // sponsorship/P2ID path and state isolation; the live bootstrap below exercises real fee debit.
    let mut chain_builder = MockChain::builder().fee_faucet_id(fee_faucet);
    let owner = chain_builder.add_existing_wallet_with_assets(auth.clone(), [fee_asset.clone()])?;
    let beneficiary = chain_builder.add_existing_wallet(auth)?;

    let check_in = NoteScript::from_package(&package("check-in-note")?)?;
    let claim = NoteScript::from_package(&package("claim-note")?)?;
    let deposit = NoteScript::from_package(&package("deposit-note")?)?;
    let p2id_root = P2idNote::script_root();
    let sponsorship_root = FeeSponsorshipNote::script_root();
    let heirbeat_roots = BTreeSet::from([check_in.root(), claim.root(), deposit.root()]);
    let mut allowed_roots = heirbeat_roots.clone();
    allowed_roots.insert(p2id_root);
    let mut policy = BasicConstantFeePolicy::new()
        .with_fee(p2id_root, AssetAmount::ZERO)
        .with_fee(NetworkAccountConfigNote::script_root(), AssetAmount::ZERO)
        .with_fee(sponsorship_root, AssetAmount::ZERO);
    for root in &heirbeat_roots {
        policy = policy.with_fee(*root, AssetAmount::ZERO);
    }
    let fee_manager = FeePolicyManager::builder()
        .active_fee_policy(policy.into())
        .fee_faucet_id(fee_faucet)
        .build();

    let mut init = InitStorageData::default();
    init.insert_value(slot("asset_faucet").as_str(), owner_word(inherited_faucet))?;
    init.insert_value(slot("owner").as_str(), owner_word(owner.id()))?;
    init.insert_value(slot("beneficiary").as_str(), owner_word(beneficiary.id()))?;
    init.insert_value(slot("claimed").as_str(), Word::default())?;
    init.insert_value(slot("last_check_in").as_str(), Word::default())?;
    init.insert_value(
        slot("timeout_blocks").as_str(),
        Word::new([Felt::from(10u32), Felt::ZERO, Felt::ZERO, Felt::ZERO]),
    )?;
    let component = AccountComponent::from_package(&package("heirbeat-vault")?, &init)?;
    let account = AccountBuilder::new([0x5b; 32])
        .account_type(AccountType::Public)
        .with_component(component)
        .with_component(BasicWallet)
        .with_components(AccessControl::Ownable2Step { owner: owner.id() })
        .with_components(AuthNetworkAccount::new(allowed_roots.clone(), fee_manager)?)
        .build_existing()?;
    let network_account = NetworkAccount::new(account.clone())?;
    let all_roots = allowed_roots
        .iter()
        .copied()
        .chain([NetworkAccountConfigNote::script_root(), sponsorship_root])
        .collect::<BTreeSet<_>>();
    assert_eq!(
        network_account.allowed_notes().allowed_script_roots(),
        &all_roots
    );
    assert_eq!(
        network_account.allowed_tx_scripts().allowed_script_roots(),
        &BTreeSet::from([ExpirationTransactionScript::script_root()])
    );
    assert_eq!(
        account.vault().get_balance(native_asset.id())?,
        AssetAmount::ZERO
    );
    assert_eq!(
        account
            .vault()
            .get_balance(FungibleAsset::new(inherited_faucet, 1)?.id())?,
        AssetAmount::ZERO
    );

    let mut chain = {
        chain_builder.add_account(account.clone())?;
        chain_builder.build()?
    };
    let mut note_rng = MockChain::builder();
    let feature: Note = P2idNote::builder()
        .sender(owner.id())
        .target(account.id())
        .asset(FungibleAsset::new(fee_faucet, 1)?)
        .note_type(NoteType::Public)
        .generate_serial_number(note_rng.rng_mut())
        .build()?
        .into();
    let sponsored_fee: Note = FeeSponsorshipNote::builder()
        .sender(owner.id())
        .target_account(account.id())
        .feature_note_id(feature.id())
        .asset(FungibleAsset::new(fee_faucet, 1_000)?)
        .generate_serial_number(note_rng.rng_mut())
        .build()?
        .into();

    let outputs = [feature.clone(), sponsored_fee.clone()];
    let partial = outputs
        .iter()
        .cloned()
        .map(PartialNote::from)
        .collect::<Vec<_>>();
    let send_script = SendNotesTransactionScript::new(
        &chain.committed_account(owner.id())?.code_interface(),
        &partial,
    )?;
    let sent = chain
        .build_transaction(owner.id())
        .foreign_accounts([chain.get_foreign_account_inputs(account.id())?])
        .send_notes_script(&send_script)
        .expected_output_notes(outputs.iter().cloned().map(RawOutputNote::Full).collect())
        .build()?
        .execute()
        .await
        .context("owner transaction emitting P2ID bootstrap and sponsorship notes")?;
    chain.add_pending_executed_transaction(&sent)?;
    chain.prove_next_block()?;

    let before = chain.committed_account(account.id())?.clone();
    assert_eq!(scalar(&before, "claimed")?, 0);
    assert_eq!(scalar(&before, "last_check_in")?, 0);
    assert_eq!(scalar(&before, "timeout_blocks")?, 10);
    let bootstrapped = chain
        .build_transaction(account.id())
        .foreign_accounts([chain.get_foreign_account_inputs(owner.id())?])
        .authenticated_input_note(feature.id())
        .authenticated_input_note(sponsored_fee.id())
        .build()?
        .execute()
        .await
        .context("empty Network Account consuming P2ID and its fee sponsorship")?;
    assert!(bootstrapped.output_notes().is_empty());
    chain.add_pending_executed_transaction(&bootstrapped)?;
    chain.prove_next_block()?;

    let after = chain.committed_account(account.id())?;
    let native_fee_balance = after.vault().get_balance(native_asset.id())?;
    assert_eq!(native_fee_balance, AssetAmount::new(1_001)?);
    assert_eq!(
        after
            .vault()
            .get_balance(FungibleAsset::new(inherited_faucet, 1)?.id(),)?,
        AssetAmount::ZERO
    );
    assert_eq!(
        after.storage().get_item(&slot("owner"))?,
        owner_word(owner.id())
    );
    assert_eq!(
        after.storage().get_item(&slot("beneficiary"))?,
        owner_word(beneficiary.id())
    );
    assert_eq!(scalar(after, "claimed")?, 0);
    assert_eq!(scalar(after, "last_check_in")?, 0);
    assert_eq!(scalar(after, "timeout_blocks")?, 10);
    assert!(chain.is_note_consumed(&feature.nullifier()));
    assert!(chain.is_note_consumed(&sponsored_fee.nullifier()));
    assert!(chain.is_note_committed(&feature.id()));
    assert!(chain.is_note_committed(&sponsored_fee.id()));

    Ok(())
}

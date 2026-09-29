//! Offline parity fixture for the Sprint 8F browser vault-account constructor.
use std::{collections::BTreeSet, path::Path};

use anyhow::{Context, Result};
use miden_client::account::AccountBuilderSchemaCommitmentExt;
use miden_client::transaction::{TransactionRequest, TransactionRequestBuilder};
use miden_mast_package::Package;
use miden_protocol::{
    account::{
        component::InitStorageData, AccountBuilder, AccountComponent, AccountId, AccountType,
        StorageSlotName,
    },
    asset::AssetAmount,
    utils::serde::{Deserializable, Serializable},
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
    note::{FeeSponsorshipNote, NetworkAccountConfigNote, P2idNote, StandardNote},
    tx_script::ExpirationTransactionScript,
};

const OWNER: &str = "0x528f6ca64fdf62410c36b5e00c4521";
const BENEFICIARY: &str = "0x4181277bcf64381105ee61baadb5bc";
const INHERITED: &str = "0x4020542183b9643120d0192be38793";
const NATIVE: &str = "0x18101fa522c174b165efd4f70a0385";
const BROWSER_ACCOUNT_ID: &str = "0x27c655040bca51d14069e50380bf6f";
const CLI_CODE_COMMITMENT: &str =
    "0x28025e4b70080b6956eeecb54a94208894b6b93db61956672ad7300cec825edc";
const CLI_STORAGE_COMMITMENT: &str =
    "0xd284e73b82ab53f0c03c9c67d86b3d39826fb58c70ffab545084959426a03a4e";

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

#[test]
fn rust_cli_vault_build_matches_browser_deterministic_seed_and_policy() -> Result<()> {
    let owner = AccountId::from_hex(OWNER)?;
    let beneficiary = AccountId::from_hex(BENEFICIARY)?;
    let inherited = AccountId::from_hex(INHERITED)?;
    let native = AccountId::from_hex(NATIVE)?;
    let check_in = miden_protocol::note::NoteScript::from_package(&package("check-in-note")?)?;
    let claim = miden_protocol::note::NoteScript::from_package(&package("claim-note")?)?;
    let deposit = miden_protocol::note::NoteScript::from_package(&package("deposit-note")?)?;
    let activation =
        miden_protocol::note::NoteScript::from_package(&package("activate-vault-note")?)?;
    let mut allowed = BTreeSet::from([check_in.root(), claim.root(), deposit.root()]);
    allowed.insert(P2idNote::script_root());
    allowed.insert(activation.root());

    let mut init = InitStorageData::default();
    init.insert_value(slot("owner").as_str(), owner_word(owner))?;
    init.insert_value(slot("beneficiary").as_str(), owner_word(beneficiary))?;
    init.insert_value(slot("asset_faucet").as_str(), owner_word(inherited))?;
    init.insert_value(slot("claimed").as_str(), Word::default())?;
    init.insert_value(slot("activated").as_str(), Word::default())?;
    init.insert_value(slot("last_check_in").as_str(), Word::default())?;
    init.insert_value(
        slot("timeout_blocks").as_str(),
        Word::new([Felt::from(1_000_000u32), Felt::ZERO, Felt::ZERO, Felt::ZERO]),
    )?;
    let vault_component = AccountComponent::from_package(&package("heirbeat-vault")?, &init)?;
    let mut policy = BasicConstantFeePolicy::new()
        .with_fee(NetworkAccountConfigNote::script_root(), AssetAmount::ZERO)
        .with_fee(FeeSponsorshipNote::script_root(), AssetAmount::ZERO)
        .with_fee(P2idNote::script_root(), AssetAmount::ZERO)
        .with_fee(activation.root(), AssetAmount::ZERO);
    for root in &allowed {
        policy = policy.with_fee(*root, AssetAmount::ZERO);
    }
    let manager = FeePolicyManager::builder()
        .active_fee_policy(policy.into())
        .fee_faucet_id(native)
        .build();
    let auth = AuthNetworkAccount::new(allowed, manager)?;
    let account = AccountBuilder::new([0x48; 32])
        .account_type(AccountType::Public)
        .with_component(vault_component)
        .with_component(BasicWallet)
        .with_components(AccessControl::Ownable2Step { owner })
        .with_components(auth)
        .build_with_schema_commitment()?;

    // Match the runtime Network Account classification the browser constructor
    // must pass, rather than validating only commitments and individual slots.
    let network_account = NetworkAccount::new(account.clone())?;

    assert_eq!(account.id().to_string(), BROWSER_ACCOUNT_ID);
    assert_eq!(account.code().commitment().to_string(), CLI_CODE_COMMITMENT);
    assert_eq!(
        account.storage().to_commitment().to_string(),
        CLI_STORAGE_COMMITMENT
    );
    assert!(account.is_public());
    assert!(account.id().is_public());
    assert_eq!(network_account.id(), account.id());
    assert_eq!(
        NetworkAccountNoteAllowlist::try_from(account.storage())?
            .allowed_script_roots()
            .len(),
        7,
    );
    assert_eq!(
        NetworkAccountTxScriptAllowlist::try_from(account.storage())?.allowed_script_roots(),
        &BTreeSet::from([ExpirationTransactionScript::script_root()]),
    );
    assert_eq!(
        account.storage().get_item(&slot("owner"))?,
        owner_word(owner)
    );
    assert_eq!(
        account.storage().get_item(&slot("beneficiary"))?,
        owner_word(beneficiary)
    );
    assert_eq!(
        account.storage().get_item(&slot("asset_faucet"))?,
        owner_word(inherited)
    );
    assert_eq!(
        account.storage().get_item(&slot("activated"))?,
        Word::default()
    );
    assert_eq!(
        account.storage().get_item(&slot("claimed"))?,
        Word::default()
    );
    assert_eq!(
        account.storage().get_item(&slot("last_check_in"))?,
        Word::default()
    );
    assert_eq!(
        account.storage().get_item(&slot("timeout_blocks"))?[0],
        Felt::from(1_000_000u32)
    );
    Ok(())
}

#[test]
fn expected_ntx_scripts_are_serialized_client_metadata_for_standard_notes() -> Result<()> {
    let scripts = vec![P2idNote::script(), FeeSponsorshipNote::script()];
    assert!(scripts
        .iter()
        .all(|script| StandardNote::from_script(script).is_some()));

    let request = TransactionRequestBuilder::new()
        .expected_ntx_scripts(scripts.clone())
        .build()?;
    let encoded = request.to_bytes();
    let decoded = TransactionRequest::read_from_bytes(&encoded)?;

    assert_eq!(
        decoded
            .expected_ntx_scripts()
            .iter()
            .map(|script| script.root())
            .collect::<BTreeSet<_>>(),
        scripts.iter().map(|script| script.root()).collect()
    );
    Ok(())
}

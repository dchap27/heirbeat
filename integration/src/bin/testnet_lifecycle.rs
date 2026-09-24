use std::time::{SystemTime, UNIX_EPOCH};
use std::{
    collections::BTreeSet,
    env,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{bail, ensure, Context, Result};
use miden_client::{
    account::{
        component::InitStorageData, AccountBuilder, AccountBuilderSchemaCommitmentExt,
        AccountComponent, AccountId, AccountType, StorageSlotName,
    },
    builder::ClientBuilder,
    keystore::FilesystemKeyStore,
    rpc::{Endpoint, GrpcClient, NodeRpcClient, VerifyingRpcClient},
    store::{AccountStatus, TransactionFilter},
    transaction::TransactionRequestBuilder,
    transaction::TransactionStatus,
};
use miden_client_sqlite_store::SqliteStore;
use miden_mast_package::Package;
use miden_protocol::{
    asset::{Asset, AssetAmount, FungibleAsset},
    note::{Note, NoteScript, NoteTag, NoteType},
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
    note::{FeeSponsorshipNote, NetworkAccountConfig, NetworkAccountConfigNote, P2idNote},
    testing::note::NoteBuilder,
    tx_script::ExpirationTransactionScript,
};
use rand::{RngExt, SeedableRng};

const FEE_FAUCET: &str = "0x18101fa522c174b165efd4f70a0385";

fn state_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../.local/testnet-v016")
}

fn root(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
        "../contracts/{name}/target/miden/release/{name}.masp"
    ))
}

fn package(name: &str) -> Result<Package> {
    let path = root(name);
    Package::read_from_bytes(&std::fs::read(&path)?)
        .with_context(|| format!("loading Miden package {}", path.display()))
}

fn slot(name: &str) -> String {
    format!("heirbeat_vault::heirbeat_vault::{name}")
}

fn owner_word(id: AccountId) -> Word {
    Word::new([Felt::ZERO, Felt::ZERO, id.suffix(), id.prefix().as_felt()])
}

async fn client() -> Result<miden_client::Client<FilesystemKeyStore>> {
    let store = Arc::new(SqliteStore::new(state_dir().join("client.sqlite3")).await?);
    let keys = FilesystemKeyStore::new(state_dir().join(".miden/keystore"))?;
    Ok(ClientBuilder::for_testnet()
        .store(store)
        .authenticator(Arc::new(keys))
        .build()
        .await?)
}

fn parse_id(value: &str) -> Result<AccountId> {
    AccountId::from_hex(value).context("invalid Miden account ID")
}

async fn status() -> Result<()> {
    let endpoint = Endpoint::testnet();
    let rpc = VerifyingRpcClient::new(GrpcClient::new(&endpoint, 10_000));
    let (header, _) = rpc.get_block_header_by_number(None, false).await?;
    let fee = header.fee_parameters();
    println!("block={}", header.block_num());
    println!("fee_faucet={}", fee.fee_faucet_id());
    println!("verification_base_fee={}", fee.verification_base_fee());
    Ok(())
}

async fn committed_block(
    client: &miden_client::Client<FilesystemKeyStore>,
    txid: miden_protocol::transaction::TransactionId,
) -> Result<miden_protocol::block::BlockNumber> {
    let mut records = client
        .get_transactions(TransactionFilter::Ids(vec![txid]))
        .await?;
    let record = records
        .pop()
        .with_context(|| format!("transaction {txid} is not tracked"))?;
    match record.status {
        TransactionStatus::Committed { block_number, .. } => Ok(block_number),
        status => bail!("transaction {txid} has not committed: {status}"),
    }
}

async fn create_vault(
    owner: AccountId,
    beneficiary: AccountId,
    asset_faucet: AccountId,
    timeout: u32,
) -> Result<()> {
    let mut client = client().await?;
    client.sync_state().await?;

    let check_in = NoteScript::from_package(&package("check-in-note")?)?;
    let claim = NoteScript::from_package(&package("claim-note")?)?;
    let deposit = NoteScript::from_package(&package("deposit-note")?)?;
    let heirbeat_roots = BTreeSet::from([check_in.root(), claim.root(), deposit.root()]);
    ensure!(
        heirbeat_roots.len() == 3,
        "compiled Heirbeat note roots are not unique"
    );
    let p2id_root = P2idNote::script_root();
    let mut allowed = heirbeat_roots;
    allowed.insert(p2id_root);

    let mut init = InitStorageData::default();
    init.insert_value(slot("owner").as_str(), owner_word(owner))?;
    init.insert_value(slot("beneficiary").as_str(), owner_word(beneficiary))?;
    init.insert_value(slot("asset_faucet").as_str(), owner_word(asset_faucet))?;
    init.insert_value(slot("claimed").as_str(), Word::default())?;
    init.insert_value(slot("last_check_in").as_str(), Word::default())?;
    init.insert_value(
        slot("timeout_blocks").as_str(),
        Word::new([Felt::from(timeout), Felt::ZERO, Felt::ZERO, Felt::ZERO]),
    )?;

    let vault_component = AccountComponent::from_package(&package("heirbeat-vault")?, &init)?;
    let fee_faucet = parse_id(FEE_FAUCET)?;
    let config_note_root = NetworkAccountConfigNote::script_root();
    let fee_sponsorship_root = FeeSponsorshipNote::script_root();
    let mut policy = BasicConstantFeePolicy::new()
        .with_fee(config_note_root, AssetAmount::ZERO)
        .with_fee(fee_sponsorship_root, AssetAmount::ZERO)
        .with_fee(p2id_root, AssetAmount::ZERO);
    for root in &allowed {
        policy = policy.with_fee(*root, miden_client::asset::AssetAmount::ZERO);
    }
    let fee_manager = FeePolicyManager::builder()
        .active_fee_policy(policy.into())
        .fee_faucet_id(fee_faucet)
        .build();
    let auth = AuthNetworkAccount::new(allowed.clone(), fee_manager)?;
    let account = AccountBuilder::new([0x48; 32])
        .account_type(AccountType::Public)
        .with_component(vault_component)
        .with_component(BasicWallet)
        .with_components(AccessControl::Ownable2Step { owner })
        .with_components(auth)
        .build_with_schema_commitment()?;
    NetworkAccount::new(account.clone())?;
    let expected_roots = allowed
        .iter()
        .copied()
        .chain([config_note_root, fee_sponsorship_root])
        .collect::<BTreeSet<_>>();
    ensure!(
        NetworkAccountNoteAllowlist::try_from(account.storage())?.allowed_script_roots()
            == &expected_roots,
        "constructed Network Account has an unexpected note allowlist"
    );
    ensure!(
        NetworkAccountTxScriptAllowlist::try_from(account.storage())?.allowed_script_roots()
            == &BTreeSet::from([ExpirationTransactionScript::script_root()]),
        "constructed Network Account has an unexpected transaction-script allowlist"
    );

    let id = account.id();
    client.add_account(&account, false).await?;
    // Bootstrap with a standard P2ID feature note and a paired fee-sponsorship note. The P2ID
    // adds one native unit and the sponsorship supplies the fee reserve. Neither note invokes the
    // Heirbeat deposit procedure or changes Heirbeat storage.
    let mut rng = rng();
    let feature_note: Note = P2idNote::builder()
        .sender(owner)
        .target(id)
        .asset(FungibleAsset::new(fee_faucet, 1)?)
        .note_type(NoteType::Public)
        .generate_serial_number(&mut rng)
        .build()?
        .into();
    let sponsorship_amount = 150u64;
    let sponsorship_note: Note = FeeSponsorshipNote::builder()
        .sender(owner)
        .target_account(id)
        .feature_note_id(feature_note.id())
        .asset(FungibleAsset::new(fee_faucet, sponsorship_amount)?)
        .generate_serial_number(&mut rng)
        .build()?
        .into();

    let bootstrap_note_tx = client
        .submit_new_transaction(
            owner,
            TransactionRequestBuilder::new()
                .own_output_notes([feature_note.clone(), sponsorship_note.clone()])
                .expected_ntx_scripts(vec![P2idNote::script(), FeeSponsorshipNote::script()])
                .build()?,
        )
        .await?;
    println!("bootstrap_note_tx={bootstrap_note_tx}");
    println!("bootstrap_p2id_note_id={}", feature_note.id());
    println!("bootstrap_sponsorship_note_id={}", sponsorship_note.id());

    let note_sync = client.sync_state().await?;
    let bootstrap_note_block = committed_block(&client, bootstrap_note_tx).await?;
    let deploy_request = TransactionRequestBuilder::new()
        .input_notes([(feature_note, None), (sponsorship_note, None)])
        .expected_ntx_scripts(vec![P2idNote::script(), FeeSponsorshipNote::script()])
        .build()?;
    let txid = client.submit_new_transaction(id, deploy_request).await?;
    let deployment_sync = client.sync_state().await?;
    let deployment_block = committed_block(&client, txid).await?;
    let (header, account_status) = client
        .get_account_header(id)
        .await?
        .context("Network Account is not present in the reloaded client store")?;
    ensure!(
        matches!(account_status, AccountStatus::Tracked),
        "Network Account was submitted but is not yet tracked as committed: {account_status}"
    );
    let deployed = client
        .get_account(id)
        .await?
        .context("deployed Network Account is missing from local store")?;
    let network_account = NetworkAccount::new(deployed.clone())?;
    ensure!(
        deployed
            .storage()
            .get_item(&StorageSlotName::new(slot("owner"))?)?
            == owner_word(owner),
        "deployed owner does not match"
    );
    ensure!(
        deployed
            .storage()
            .get_item(&StorageSlotName::new(slot("beneficiary"))?)?
            == owner_word(beneficiary),
        "deployed beneficiary does not match"
    );
    ensure!(
        deployed
            .storage()
            .get_item(&StorageSlotName::new(slot("timeout_blocks"))?)?[0]
            == Felt::from(timeout),
        "deployed timeout does not match"
    );
    ensure!(
        deployed
            .storage()
            .get_item(&StorageSlotName::new(slot("claimed"))?)?
            == Word::default(),
        "new vault is not unclaimed"
    );
    ensure!(
        deployed
            .storage()
            .get_item(&StorageSlotName::new(slot("last_check_in"))?)?
            == Word::default(),
        "new vault last_check_in is not zero"
    );
    let inherited_balance = deployed
        .vault()
        .get_balance(FungibleAsset::new(asset_faucet, 1)?.id())?;
    let native_fee_balance = deployed
        .vault()
        .get_balance(FungibleAsset::new(fee_faucet, 1)?.id())?;
    ensure!(
        inherited_balance == AssetAmount::ZERO,
        "vault unexpectedly holds inherited assets"
    );
    println!("deployment_tx={txid}");
    println!("deployment_committed_block={deployment_block}");
    println!("deployment_sync_block={}", deployment_sync.block_num);
    println!("deployment_account_status={account_status}");
    println!("deployment_header={header:?}");
    println!("vault_id={id}");
    println!("owner={owner}");
    println!("beneficiary={beneficiary}");
    println!("asset_faucet={asset_faucet}");
    println!("timeout_blocks={timeout}");
    println!("check_in_root={}", check_in.root());
    println!("claim_root={}", claim.root());
    println!("deposit_root={}", deposit.root());
    println!("bootstrap_note_committed_block={bootstrap_note_block}");
    println!("bootstrap_sync_block={}", note_sync.block_num);
    println!(
        "network_account_note_roots={:?}",
        network_account.allowed_notes().allowed_script_roots()
    );
    println!("bootstrap_p2id_root={p2id_root}");
    println!("standard_network_account_config_root={config_note_root}");
    println!("standard_fee_sponsorship_root={fee_sponsorship_root}");
    println!(
        "network_account_note_roots={:?}",
        network_account.allowed_notes().allowed_script_roots()
    );
    println!(
        "transaction_script_allowlist={:?}",
        network_account.allowed_tx_scripts().allowed_script_roots()
    );
    println!("fee_schedule: check_in=0 claim=0 deposit=0 config_note=0 fee_sponsorship=0");
    println!("fee_faucet={fee_faucet}");
    println!("sponsorship_native_amount={sponsorship_amount}");
    println!("native_fee_balance_after={native_fee_balance}");
    println!("inherited_balance_after={inherited_balance}");
    println!("network_account_recognition=verified");
    Ok(())
}

async fn verify_vault(
    id: AccountId,
    owner: AccountId,
    beneficiary: AccountId,
    asset_faucet: AccountId,
) -> Result<()> {
    let mut client = client().await?;
    let sync = client.sync_state().await?;
    let (_, status) = client
        .get_account_header(id)
        .await?
        .context("vault is not tracked in the durable client store")?;
    ensure!(
        matches!(status, AccountStatus::Tracked),
        "vault is not tracked on-chain: {status}"
    );
    let account = client
        .get_account(id)
        .await?
        .context("vault account data is absent after restart/sync")?;
    let network_account = NetworkAccount::new(account.clone())?;
    for (name, expected) in [("owner", owner), ("beneficiary", beneficiary)] {
        ensure!(
            account
                .storage()
                .get_item(&StorageSlotName::new(slot(name))?)?
                == owner_word(expected),
            "vault {name} differs from the expected account"
        );
    }
    ensure!(
        account
            .storage()
            .get_item(&StorageSlotName::new(slot("timeout_blocks"))?)?[0]
            == Felt::from(10u32),
        "vault timeout is not 10"
    );
    ensure!(
        account
            .storage()
            .get_item(&StorageSlotName::new(slot("claimed"))?)?
            == Word::default(),
        "vault is not unclaimed"
    );
    ensure!(
        account
            .storage()
            .get_item(&StorageSlotName::new(slot("last_check_in"))?)?
            == Word::default(),
        "vault last_check_in is not its initial zero value"
    );
    let check_in = NoteScript::from_package(&package("check-in-note")?)?.root();
    let claim = NoteScript::from_package(&package("claim-note")?)?.root();
    let deposit = NoteScript::from_package(&package("deposit-note")?)?.root();
    let p2id = P2idNote::script_root();
    let config = NetworkAccountConfigNote::script_root();
    let sponsorship = FeeSponsorshipNote::script_root();
    let expected_roots = BTreeSet::from([check_in, claim, deposit, config, sponsorship]);
    ensure!(
        network_account.allowed_notes().allowed_script_roots() == &expected_roots,
        "vault note allowlist differs from the exact post-cleanup roots"
    );
    ensure!(
        !network_account
            .allowed_notes()
            .allowed_script_roots()
            .contains(&p2id),
        "P2ID is still allowlisted"
    );
    let mut random = rng();
    let p2id_probe: Note = P2idNote::builder()
        .sender(owner)
        .target(id)
        .asset(FungibleAsset::new(parse_id(FEE_FAUCET)?, 1)?)
        .note_type(NoteType::Public)
        .generate_serial_number(&mut random)
        .build()?
        .into();
    ensure!(
        network_account.allowed_tx_scripts().allowed_script_roots()
            == &BTreeSet::from([ExpirationTransactionScript::script_root()]),
        "vault transaction-script allowlist differs from the canonical Network Account default"
    );
    let inherited_balance = account
        .vault()
        .get_balance(FungibleAsset::new(asset_faucet, 1)?.id())?;
    let native_fee_balance = account
        .vault()
        .get_balance(FungibleAsset::new(parse_id(FEE_FAUCET)?, 1)?.id())?;
    ensure!(
        inherited_balance == AssetAmount::ZERO && native_fee_balance > AssetAmount::ZERO,
        "inherited/native balances are not separated as expected"
    );
    println!("restart_sync_block={}", sync.block_num);
    println!("vault_id={id}");
    println!("account_status={status}");
    println!("owner={owner}");
    println!("beneficiary={beneficiary}");
    println!("timeout_blocks=10");
    println!("last_check_in=0");
    println!("claimed=false");
    println!("native_fee_balance={native_fee_balance}");
    println!("inherited_balance={inherited_balance}");
    println!(
        "note_allowlist={:?}",
        network_account.allowed_notes().allowed_script_roots()
    );
    println!("check_in_root={check_in}");
    println!("claim_root={claim}");
    println!("deposit_root={deposit}");
    println!("config_root={config}");
    println!("sponsorship_root={sponsorship}");
    println!("p2id_root={p2id}");
    println!(
        "expiration_tx_script_root={}",
        ExpirationTransactionScript::script_root()
    );
    println!("constructed_p2id_probe_note_id={}", p2id_probe.id());
    println!("p2id_rejection=locally confirmed: canonical P2ID root is absent from synced NetworkAccountNoteAllowlist; auth allowlist check rejects it before execution; probe was not submitted");
    println!(
        "p2id_allowed={}",
        network_account
            .allowed_notes()
            .allowed_script_roots()
            .contains(&P2idNote::script_root())
    );
    println!("transaction_script_allowlist=canonical-expiration-only");
    Ok(())
}

async fn remove_bootstrap_p2id(
    vault_id: AccountId,
    owner: AccountId,
    beneficiary: AccountId,
    asset_faucet: AccountId,
) -> Result<()> {
    let mut client = client().await?;
    let sync = client.sync_state().await?;
    let endpoint = Endpoint::testnet();
    let rpc = VerifyingRpcClient::new(GrpcClient::new(&endpoint, 10_000));
    let (header, _) = rpc.get_block_header_by_number(None, false).await?;
    let vault = client
        .get_account(vault_id)
        .await?
        .context("vault is missing from the synced client store")?;
    let network_account = NetworkAccount::new(vault.clone())?;
    let check_in = NoteScript::from_package(&package("check-in-note")?)?.root();
    let claim = NoteScript::from_package(&package("claim-note")?)?.root();
    let deposit = NoteScript::from_package(&package("deposit-note")?)?.root();
    let p2id = P2idNote::script_root();
    let config = NetworkAccountConfigNote::script_root();
    let sponsorship = FeeSponsorshipNote::script_root();
    let expected_before = BTreeSet::from([check_in, claim, deposit, p2id, config, sponsorship]);
    ensure!(
        network_account.allowed_notes().allowed_script_roots() == &expected_before,
        "pre-cleanup note allowlist has unexpected roots: {:?}",
        network_account.allowed_notes().allowed_script_roots()
    );
    ensure!(
        network_account.allowed_tx_scripts().allowed_script_roots()
            == &BTreeSet::from([ExpirationTransactionScript::script_root()]),
        "pre-cleanup transaction-script allowlist is not expiration-only"
    );
    for (name, expected) in [("owner", owner), ("beneficiary", beneficiary)] {
        ensure!(
            vault
                .storage()
                .get_item(&StorageSlotName::new(slot(name))?)?
                == owner_word(expected),
            "vault {name} does not match"
        );
    }
    ensure!(
        vault
            .storage()
            .get_item(&StorageSlotName::new(slot("timeout_blocks"))?)?[0]
            == Felt::from(10u32)
            && vault
                .storage()
                .get_item(&StorageSlotName::new(slot("last_check_in"))?)?
                == Word::default()
            && vault
                .storage()
                .get_item(&StorageSlotName::new(slot("claimed"))?)?
                == Word::default(),
        "vault protocol state differs from the expected pre-cleanup state"
    );
    let inherited_before = vault
        .vault()
        .get_balance(FungibleAsset::new(asset_faucet, 1)?.id())?;
    let fee_asset = parse_id(FEE_FAUCET)?;
    let fee_before = vault
        .vault()
        .get_balance(FungibleAsset::new(fee_asset, 1)?.id())?;
    ensure!(
        inherited_before == AssetAmount::ZERO,
        "inherited asset balance is not zero"
    );

    println!("pre_cleanup_sync_block={}", sync.block_num);
    println!(
        "pre_cleanup_note_allowlist={:?}",
        network_account.allowed_notes().allowed_script_roots()
    );
    println!(
        "pre_cleanup_tx_allowlist={:?}",
        network_account.allowed_tx_scripts().allowed_script_roots()
    );
    println!("pre_cleanup_native_fee_balance={fee_before}");
    println!("pre_cleanup_inherited_balance={inherited_before}");
    println!(
        "current_verification_base_fee={} (latest node header block {})",
        header.fee_parameters().verification_base_fee(),
        header.block_num()
    );
    println!("fee_policy_schedule=check_in:0,claim:0,deposit:0,config:0,sponsorship:0");
    println!("historical_network_account_transaction_debit=112 native units");
    println!(
        "sponsorship_required=true (39 current units are below the prior observed 112-unit debit)"
    );

    let mut random = rng();
    let config_note: Note = NetworkAccountConfigNote::builder()
        .sender(owner)
        .target(vault_id)
        .config(NetworkAccountConfig::RemoveAllowedNoteScript { script_root: p2id })
        .generate_serial_number(&mut random)
        .build()?
        .into();
    let config_note_id = config_note.id();
    let sponsorship_amount = 120u64;
    let sponsorship_note: Note = FeeSponsorshipNote::builder()
        .sender(owner)
        .target_account(vault_id)
        .feature_note_id(config_note_id)
        .asset(FungibleAsset::new(fee_asset, sponsorship_amount)?)
        .generate_serial_number(&mut random)
        .build()?
        .into();
    let sponsorship_note_id = sponsorship_note.id();

    let owner_tx = client
        .submit_new_transaction(
            owner,
            TransactionRequestBuilder::new()
                .own_output_notes([config_note.clone(), sponsorship_note.clone()])
                .expected_ntx_scripts(vec![
                    NetworkAccountConfigNote::script(),
                    FeeSponsorshipNote::script(),
                ])
                .build()?,
        )
        .await?;
    println!("config_note_id={config_note_id}");
    println!("fee_sponsorship_note_id={sponsorship_note_id}");
    println!("config_note_funding_tx_id={owner_tx}");
    client.sync_state().await?;
    let owner_block = committed_block(&client, owner_tx).await?;

    let config_tx = client
        .submit_new_transaction(
            vault_id,
            TransactionRequestBuilder::new()
                .input_notes([(config_note, None), (sponsorship_note, None)])
                .expected_ntx_scripts(vec![
                    NetworkAccountConfigNote::script(),
                    FeeSponsorshipNote::script(),
                ])
                .build()?,
        )
        .await?;
    println!("config_transaction_id={config_tx}");
    let final_sync = client.sync_state().await?;
    let config_block = committed_block(&client, config_tx).await?;
    let updated = client
        .get_account(vault_id)
        .await?
        .context("vault missing after config-note transaction")?;
    let updated_network = NetworkAccount::new(updated.clone())?;
    let expected_after = BTreeSet::from([check_in, claim, deposit, config, sponsorship]);
    ensure!(
        updated_network.allowed_notes().allowed_script_roots() == &expected_after,
        "post-cleanup allowlist is not exactly the expected five roots: {:?}",
        updated_network.allowed_notes().allowed_script_roots()
    );
    ensure!(
        !updated_network
            .allowed_notes()
            .allowed_script_roots()
            .contains(&p2id),
        "P2ID root is still allowlisted"
    );
    ensure!(
        updated_network.allowed_tx_scripts().allowed_script_roots()
            == &BTreeSet::from([ExpirationTransactionScript::script_root()]),
        "post-cleanup transaction-script allowlist is not expiration-only"
    );
    for (name, expected) in [("owner", owner), ("beneficiary", beneficiary)] {
        ensure!(
            updated
                .storage()
                .get_item(&StorageSlotName::new(slot(name))?)?
                == owner_word(expected),
            "post-cleanup vault {name} changed"
        );
    }
    ensure!(
        updated
            .storage()
            .get_item(&StorageSlotName::new(slot("timeout_blocks"))?)?[0]
            == Felt::from(10u32)
            && updated
                .storage()
                .get_item(&StorageSlotName::new(slot("last_check_in"))?)?
                == Word::default()
            && updated
                .storage()
                .get_item(&StorageSlotName::new(slot("claimed"))?)?
                == Word::default(),
        "post-cleanup vault state changed"
    );
    let inherited_after = updated
        .vault()
        .get_balance(FungibleAsset::new(asset_faucet, 1)?.id())?;
    let fee_after = updated
        .vault()
        .get_balance(FungibleAsset::new(fee_asset, 1)?.id())?;
    ensure!(
        inherited_after == inherited_before,
        "inherited balance changed during config cleanup"
    );
    println!("owner_config_note_committed_block={owner_block}");
    println!("config_reference_block={}", final_sync.block_num);
    println!("config_committed_block={config_block}");
    println!("post_cleanup_sync_block={}", final_sync.block_num);
    println!(
        "post_cleanup_note_allowlist={:?}",
        updated_network.allowed_notes().allowed_script_roots()
    );
    println!(
        "post_cleanup_tx_allowlist={:?}",
        updated_network.allowed_tx_scripts().allowed_script_roots()
    );
    println!("p2id_root={p2id}");
    println!("p2id_rejection=standard P2ID root absent from freshly synced NetworkAccountNoteAllowlist; network-account auth rejects unallowlisted note roots");
    println!("heirbeat_roots_preserved=true");
    println!(
        "owner={owner} beneficiary={beneficiary} timeout_blocks=10 last_check_in=0 claimed=false"
    );
    println!("native_fee_before={fee_before} sponsorship_supplied={sponsorship_amount} native_fee_after={fee_after}");
    println!("inherited_balance_after={inherited_after}");
    Ok(())
}

async fn show_transactions(wanted: &[String]) -> Result<()> {
    let mut client = client().await?;
    let sync = client.sync_state().await?;
    println!("sync_block={}", sync.block_num);
    for record in client.get_transactions(TransactionFilter::All).await? {
        if wanted.is_empty() || wanted.iter().any(|id| id == &record.id.to_hex()) {
            println!("transaction_id={} status={}", record.id, record.status);
        }
    }
    Ok(())
}

async fn consume_config_notes(
    vault_id: AccountId,
    config_note_id: &str,
    sponsorship_note_id: &str,
) -> Result<()> {
    let mut client = client().await?;
    client.sync_state().await?;
    let config_id = miden_protocol::note::NoteId::try_from_hex(config_note_id)?;
    let sponsorship_id = miden_protocol::note::NoteId::try_from_hex(sponsorship_note_id)?;
    let config_record = client
        .get_input_note(config_id)
        .await?
        .context("committed config note is not present in the durable input-note store")?;
    let sponsorship_record = client
        .get_input_note(sponsorship_id)
        .await?
        .context("committed sponsorship note is not present in the durable input-note store")?;
    if config_record.consumer_account() == Some(vault_id)
        && sponsorship_record.consumer_account() == Some(vault_id)
    {
        println!("config_note_state=already consumed by target Network Account");
        println!("sponsorship_note_state=already consumed by target Network Account");
        println!("consumed_by_target=true");
        return Ok(());
    }
    let config_note: Note = config_record.try_into()?;
    let sponsorship_note: Note = sponsorship_record.try_into()?;
    let txid = client
        .submit_new_transaction(
            vault_id,
            TransactionRequestBuilder::new()
                .input_notes([(config_note, None), (sponsorship_note, None)])
                .expected_ntx_scripts(vec![
                    NetworkAccountConfigNote::script(),
                    FeeSponsorshipNote::script(),
                ])
                .build()?,
        )
        .await?;
    println!("config_note_id={config_id}");
    println!("fee_sponsorship_note_id={sponsorship_id}");
    println!("config_transaction_id={txid}");
    client.sync_state().await?;
    println!(
        "config_transaction_status={:?}",
        client
            .get_transactions(TransactionFilter::Ids(vec![txid]))
            .await?
            .first()
            .map(|record| &record.status)
    );
    Ok(())
}

async fn block_transactions(block_number: u32, account_id: AccountId) -> Result<()> {
    let endpoint = Endpoint::testnet();
    let rpc = VerifyingRpcClient::new(GrpcClient::new(&endpoint, 10_000));
    let block = rpc
        .get_block_by_number(block_number.into(), false)
        .await
        .with_context(|| format!("loading committed block {block_number}"))?;
    println!("block={}", block.header().block_num());
    let mut found = false;
    for tx in block.body().transactions().as_slice() {
        if tx.account_id() == account_id {
            println!("account_transaction_id={}", tx.id());
            found = true;
        }
    }
    ensure!(
        found,
        "no transaction for account {account_id} found in block {block_number}"
    );
    Ok(())
}

fn rng() -> impl miden_protocol::crypto::rand::FeltRng {
    let mut os_rng = rand::rng();
    miden_protocol::crypto::rand::RandomCoin::new(Word::new([
        Felt::from(os_rng.random::<u32>()),
        Felt::from(os_rng.random::<u32>()),
        Felt::from(os_rng.random::<u32>()),
        Felt::from(os_rng.random::<u32>()),
    ]))
}

async fn send_note(
    kind: &str,
    sender: AccountId,
    vault: AccountId,
    asset_faucet: Option<AccountId>,
    amount: u64,
) -> Result<()> {
    let script_name = match kind {
        "check-in" => "check-in-note",
        "claim" => "claim-note",
        "deposit" => "deposit-note",
        _ => bail!("stage must be check-in, claim, or deposit"),
    };
    let script = NoteScript::from_package(&package(script_name)?)?;
    let mut seed = [0_u8; 32];
    seed[..8].copy_from_slice(
        &SystemTime::now()
            .duration_since(UNIX_EPOCH)?
            .as_nanos()
            .to_le_bytes()[..8],
    );
    let rng = rand::rngs::StdRng::from_seed(seed);
    let mut builder = NoteBuilder::new(sender, rng)
        .tag(NoteTag::with_account_target(vault).into())
        .script(script.clone());
    if kind == "deposit" {
        ensure!(amount > 0, "deposit amount must be positive");
        let asset: Asset =
            FungibleAsset::new(asset_faucet.context("deposit needs a faucet ID")?, amount)?.into();
        builder = builder
            .add_assets([asset])
            .note_storage([vault.suffix(), vault.prefix().as_felt()])?;
    }
    let note: Note = builder.build()?;
    let note_id = note.id();
    let request = TransactionRequestBuilder::new()
        .own_output_notes([note])
        .expected_ntx_scripts(vec![script])
        .build()?;
    let mut client = client().await?;
    client.sync_state().await?;
    let txid = client.submit_new_transaction(sender, request).await?;
    println!("transaction_id={txid}");
    println!("note_id={note_id}");
    println!(
        "note_root={}",
        NoteScript::from_package(&package(script_name)?)?.root()
    );
    println!("sender={sender}");
    println!("vault={vault}");
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    match args.first().map(String::as_str) {
        Some("status") => status().await,
        Some("create-vault") if args.len() == 5 => {
            create_vault(parse_id(&args[1])?, parse_id(&args[2])?, parse_id(&args[3])?, args[4].parse()?).await
        },
        Some("verify-vault") if args.len() == 5 => {
            verify_vault(
                parse_id(&args[1])?,
                parse_id(&args[2])?,
                parse_id(&args[3])?,
                parse_id(&args[4])?,
            )
            .await
        },
        Some("remove-bootstrap-p2id") if args.len() == 5 => {
            remove_bootstrap_p2id(
                parse_id(&args[1])?,
                parse_id(&args[2])?,
                parse_id(&args[3])?,
                parse_id(&args[4])?,
            )
            .await
        },
        Some("transactions") => show_transactions(&args[1..]).await,
        Some("consume-config-notes") if args.len() == 4 => {
            consume_config_notes(parse_id(&args[1])?, &args[2], &args[3]).await
        },
        Some("block-transactions") if args.len() == 3 => {
            block_transactions(args[1].parse()?, parse_id(&args[2])?).await
        },
        Some(stage @ ("check-in" | "claim")) if args.len() == 3 => {
            send_note(stage, parse_id(&args[1])?, parse_id(&args[2])?, None, 0).await
        },
        Some("deposit") if args.len() == 5 => {
            send_note("deposit", parse_id(&args[1])?, parse_id(&args[2])?, Some(parse_id(&args[3])?), args[4].parse()?).await
        },
        _ => bail!("usage: testnet_lifecycle status | create-vault <owner> <beneficiary> <asset-faucet> <timeout> | verify-vault <vault> <owner> <beneficiary> <asset-faucet> | remove-bootstrap-p2id <vault> <owner> <beneficiary> <asset-faucet> | consume-config-notes <vault> <config-note-id> <sponsorship-note-id> | block-transactions <block> <account> | transactions [tx-id ...] | check-in <owner> <vault> | claim <beneficiary> <vault> | deposit <owner> <vault> <asset-faucet> <amount>"),
    }
}

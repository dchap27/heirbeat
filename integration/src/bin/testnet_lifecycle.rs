use std::time::Duration;
use std::{
    collections::BTreeSet,
    env,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{bail, ensure, Context, Result};
use integration::testnet::{
    config::{TestnetConfig, DEFAULT_RPC_ENDPOINT},
    fees::{
        build_network_sponsorship, build_wallet_fee_note, ensure_sponsorship_pair,
        DEFAULT_NETWORK_SPONSORSHIP_AMOUNT,
    },
    notes::{assert_network_target, network_target},
    polling::PollPolicy,
    security::validate_hardened_allowlists,
    state::{derive_deadline, ensure_claim_eligible, ensure_positive_timeout, ensure_unclaimed},
};
use miden_client::{
    account::{
        component::InitStorageData, AccountBuilder, AccountBuilderSchemaCommitmentExt,
        AccountComponent, AccountId, AccountType, StorageSlotName,
    },
    builder::ClientBuilder,
    keystore::{FilesystemKeyStore, Keystore},
    rpc::{Endpoint, GrpcClient, NodeRpcClient, VerifyingRpcClient},
    store::{AccountStatus, TransactionFilter},
    transaction::TransactionRequestBuilder,
    transaction::TransactionStatus,
};
use miden_client_sqlite_store::SqliteStore;
use miden_mast_package::Package;
use miden_protocol::{
    account::auth::{AuthScheme, AuthSecretKey},
    asset::TokenSymbol,
    asset::{AssetAmount, FungibleAsset},
    block::BlockNumber,
    note::{Note, NoteScript, NoteTag, NoteType, PartialNote},
    utils::serde::Deserializable,
    Felt, Word,
};
use miden_standards::{
    account::{
        access::AccessControl,
        auth::{
            Approver, AuthNetworkAccount, AuthSingleSig, NetworkAccount,
            NetworkAccountNoteAllowlist, NetworkAccountTxScriptAllowlist,
        },
        faucets::{create_singlesig_user_fungible_faucet, FungibleFaucet, TokenName},
        fees::{BasicConstantFeePolicy, FeePolicyManager},
        policies::{BurnPolicy, MintPolicy, TokenPolicyManager, TransferPolicy},
        wallets::BasicWallet,
    },
    note::{
        FeeSponsorshipNote, FeeSponsorshipNoteStorage, NetworkAccountConfig,
        NetworkAccountConfigNote, NetworkAccountTarget, P2idNote, P2idNoteStorage,
    },
    testing::note::NoteBuilder,
    tx_script::{ExpirationTransactionScript, SendFungibleFaucetNotesTransactionScript},
};
use rand::RngExt;

const FEE_FAUCET: &str = "0x18101fa522c174b165efd4f70a0385";

fn state_dir() -> PathBuf {
    env::var_os("HEIRBEAT_TESTNET_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../.local/testnet-v016"))
}

fn default_config_path() -> PathBuf {
    state_dir().join("heirbeat.json")
}

fn load_cli_config(path: &Path) -> Result<TestnetConfig> {
    let config = TestnetConfig::load(path)?;
    ensure!(
        config.rpc_endpoint == DEFAULT_RPC_ENDPOINT,
        "this CLI build currently supports the public testnet endpoint {DEFAULT_RPC_ENDPOINT}; got {}",
        config.rpc_endpoint
    );
    Ok(config)
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
    client_from_paths(
        state_dir().join("client.sqlite3"),
        state_dir().join(".miden/keystore"),
    )
    .await
}

async fn client_from_paths(
    db_path: PathBuf,
    keystore_path: PathBuf,
) -> Result<miden_client::Client<FilesystemKeyStore>> {
    let store = Arc::new(SqliteStore::new(db_path).await?);
    let keys = FilesystemKeyStore::new(keystore_path)?;
    Ok(ClientBuilder::for_testnet()
        .store(store)
        .authenticator(Arc::new(keys))
        .build()
        .await?)
}

async fn create_durable_faucet(
    owner: AccountId,
    name: &str,
    symbol: &str,
    decimals: u8,
    max_supply: u64,
) -> Result<AccountId> {
    let mut client = client().await?;
    let sync = client.sync_state().await?;
    let keystore = FilesystemKeyStore::new(state_dir().join(".miden/keystore"))?;
    ensure!(
        !keystore.get_keys_for_account(&owner).await?.is_empty(),
        "durable owner signer is required to create the test faucet"
    );

    let secret_key = AuthSecretKey::new_falcon512_poseidon2();
    let auth = AuthSingleSig::new(Approver::new(
        secret_key.public_key().to_commitment(),
        AuthScheme::Falcon512Poseidon2,
    ));
    let max_supply = AssetAmount::from(
        u32::try_from(max_supply).context("max supply exceeds the v0.16 u32 asset amount limit")?,
    );
    let faucet = FungibleFaucet::builder()
        .name(TokenName::new(name)?)
        .symbol(
            TokenSymbol::try_from(symbol)
                .context("symbol must satisfy Miden's uppercase token-symbol rules")?,
        )
        .decimals(decimals)
        .max_supply(max_supply)
        .build()?;
    let policies = TokenPolicyManager::builder()
        .active_mint_policy(MintPolicy::allow_all())
        .active_burn_policy(BurnPolicy::allow_all())
        .active_send_policy(TransferPolicy::allow_all())
        .active_receive_policy(TransferPolicy::allow_all())
        .build();
    let account = create_singlesig_user_fungible_faucet(
        rand::rng().random::<[u8; 32]>(),
        faucet,
        auth,
        policies,
        AccountType::Public,
    )?;
    let faucet_id = account.id();
    keystore.add_key(&secret_key, faucet_id).await?;
    ensure!(
        !keystore.get_keys_for_account(&faucet_id).await?.is_empty(),
        "new faucet signer was not persisted"
    );
    client.add_account(&account, false).await?;

    println!("faucet_id={faucet_id}");
    println!("faucet_name={name}");
    println!("faucet_symbol={symbol}");
    println!("faucet_decimals={decimals}");
    println!("faucet_max_supply={max_supply}");
    println!("faucet_mint_policy=allow_all");
    println!("faucet_auth=single_signature_falcon512_poseidon2");
    println!("faucet_local_store_status=New");
    println!("faucet_signer_persisted=true");
    println!("created_after_sync_block={}", sync.block_num);
    println!("next=restart process, run verify-faucet {faucet_id}, then deploy-faucet {faucet_id}");
    Ok(faucet_id)
}

async fn verify_durable_faucet(faucet_id: AccountId, expected_max_supply: u64) -> Result<()> {
    let mut client = client().await?;
    let sync = client.sync_state().await?;
    let keys = FilesystemKeyStore::new(state_dir().join(".miden/keystore"))?;
    ensure!(
        !keys.get_keys_for_account(&faucet_id).await?.is_empty(),
        "faucet signer is not available after process restart"
    );
    let account = client
        .get_account(faucet_id)
        .await?
        .context("faucet account state is missing from the durable store")?;
    let faucet = FungibleFaucet::try_from(&account)?;
    ensure!(account.is_public(), "new faucet is not public");
    ensure!(
        faucet.max_supply()
            == AssetAmount::from(
                u32::try_from(expected_max_supply).context(
                    "configured maximum supply exceeds the v0.16 u32 asset amount limit"
                )?
            ),
        "faucet maximum supply changed"
    );
    println!("faucet_id={faucet_id}");
    let account_status = client
        .get_account_header(faucet_id)
        .await?
        .map(|(_, status)| safe_account_status(&status))
        .unwrap_or("Missing");
    println!("account_status={account_status}");
    println!("public={}", account.is_public());
    println!("signer_available_after_restart=true");
    println!("token_name={:?}", faucet.token_name());
    println!("token_symbol={}", faucet.symbol());
    println!("decimals={}", faucet.decimals());
    println!("supply={}", faucet.token_supply());
    println!("max_supply={}", faucet.max_supply());
    println!("synced_block={}", sync.block_num);
    Ok(())
}

async fn deploy_durable_faucet(faucet_id: AccountId, owner: AccountId) -> Result<(String, String)> {
    let mut client = client().await?;
    client.sync_state().await?;
    let fee_faucet = parse_id(FEE_FAUCET)?;
    let keys = FilesystemKeyStore::new(state_dir().join(".miden/keystore"))?;
    ensure!(
        !keys.get_keys_for_account(&faucet_id).await?.is_empty(),
        "faucet signer is missing; refusing to deploy without durable authority"
    );
    ensure!(
        !keys.get_keys_for_account(&owner).await?.is_empty(),
        "owner signer is missing from the durable keystore"
    );
    let owner_account = client
        .get_account(owner)
        .await?
        .context("owner is not tracked")?;
    let owner_fee_balance = owner_account
        .vault()
        .get_balance(FungibleAsset::new(fee_faucet, 1)?.id())?;
    ensure!(
        owner_fee_balance.as_u64() >= 151,
        "owner native fee balance is too low for paired faucet bootstrap: {owner_fee_balance}"
    );

    let mut rng = rng();
    let feature_note: Note = P2idNote::builder()
        .sender(owner)
        .target(faucet_id)
        .asset(FungibleAsset::new(fee_faucet, 1)?)
        .note_type(NoteType::Public)
        .generate_serial_number(&mut rng)
        .build()?
        .into();
    let sponsorship_amount = 150u64;
    let sponsorship_note: Note = FeeSponsorshipNote::builder()
        .sender(owner)
        .target_account(faucet_id)
        .feature_note_id(feature_note.id())
        .asset(FungibleAsset::new(fee_faucet, sponsorship_amount)?)
        .generate_serial_number(&mut rng)
        .build()?
        .into();
    let bootstrap_feature_note_id = feature_note.id();
    let owner_tx = client
        .submit_new_transaction(
            owner,
            TransactionRequestBuilder::new()
                .own_output_notes([feature_note.clone(), sponsorship_note.clone()])
                .expected_ntx_scripts(vec![P2idNote::script(), FeeSponsorshipNote::script()])
                .build()?,
        )
        .await?;
    println!("bootstrap_owner_transaction={owner_tx}");
    println!("bootstrap_p2id_note_id={}", feature_note.id());
    println!(
        "bootstrap_fee_sponsorship_note_id={}",
        sponsorship_note.id()
    );
    client.sync_state().await?;
    let feature_block = committed_block(&mut client, owner_tx).await?;

    let deploy_tx = client
        .submit_new_transaction(
            faucet_id,
            TransactionRequestBuilder::new()
                .input_notes([(feature_note, None), (sponsorship_note, None)])
                .expected_ntx_scripts(vec![P2idNote::script(), FeeSponsorshipNote::script()])
                .build()?,
        )
        .await?;
    let sync = client.sync_state().await?;
    let deploy_block = committed_block(&mut client, deploy_tx).await?;
    let (_, status) = client
        .get_account_header(faucet_id)
        .await?
        .context("deployed faucet is not present in the client store")?;
    ensure!(
        matches!(status, AccountStatus::Tracked),
        "faucet deployment was not committed: {status}"
    );
    let deployed = client
        .get_account(faucet_id)
        .await?
        .context("deployed faucet state is missing")?;
    let faucet = FungibleFaucet::try_from(&deployed)?;
    ensure!(deployed.is_public(), "deployed faucet is not public");
    ensure!(
        faucet.token_supply() == AssetAmount::ZERO,
        "deployed faucet supply is not zero"
    );
    ensure!(
        faucet.max_supply() == AssetAmount::from(1_000_000u32),
        "deployed faucet maximum supply changed"
    );
    let key_available = !keys.get_keys_for_account(&faucet_id).await?.is_empty();
    ensure!(key_available, "faucet signer disappeared after deployment");
    println!("faucet_id={faucet_id}");
    println!("deployment_transaction={deploy_tx}");
    println!("deployment_block={deploy_block}");
    println!("deployment_sync_block={}", sync.block_num);
    println!("bootstrap_owner_transaction_block={feature_block}");
    println!("account_status={status}");
    println!("public=true");
    println!("token_name={:?}", faucet.token_name());
    println!("token_symbol={}", faucet.symbol());
    println!("decimals={}", faucet.decimals());
    println!("supply={}", faucet.token_supply());
    println!("max_supply={}", faucet.max_supply());
    println!("durable_signer_available=true");
    println!("next=restart process, run verify-faucet {faucet_id}, then mint-probe {faucet_id}");
    Ok((deploy_tx.to_string(), bootstrap_feature_note_id.to_string()))
}

async fn mint_faucet_asset(
    faucet_id: AccountId,
    recipient: AccountId,
    amount: u64,
    fee_note_hex: &str,
) -> Result<(String, String, String)> {
    let mut client = client().await?;
    client.sync_state().await?;
    let keys = FilesystemKeyStore::new(state_dir().join(".miden/keystore"))?;
    ensure!(
        !keys.get_keys_for_account(&faucet_id).await?.is_empty(),
        "faucet signing key is unavailable"
    );
    ensure!(
        !keys.get_keys_for_account(&recipient).await?.is_empty(),
        "mint recipient signing key is unavailable for P2ID consumption"
    );
    let faucet_account = client
        .get_account(faucet_id)
        .await?
        .context("deployed faucet is not tracked")?;
    let faucet = FungibleFaucet::try_from(&faucet_account)?;
    ensure!(faucet_account.is_public(), "faucet is not public");
    ensure!(amount > 0, "mint amount must be positive");
    let supply_before = faucet.token_supply();
    let asset = FungibleAsset::new(faucet_id, amount)?;
    let fee_faucet = parse_id(FEE_FAUCET)?;
    let fee_asset = FungibleAsset::new(fee_faucet, 1)?;
    let fee_balance_before = faucet_account.vault().get_balance(fee_asset.id())?;
    let fee_funding_id = miden_protocol::note::NoteId::try_from_hex(fee_note_hex)?;
    let faucet_fee_note = tracked_note_for_consumption(&client, fee_funding_id).await?;
    let mut rng = rng();
    let note: Note = P2idNote::builder()
        .sender(faucet_id)
        .target(recipient)
        .asset(asset)
        .note_type(NoteType::Public)
        .generate_serial_number(&mut rng)
        .build()?
        .into();
    let partial_note = PartialNote::new(
        note.metadata().partial_metadata().clone(),
        note.recipient().digest(),
        note.assets().clone(),
        note.attachments().clone(),
    );
    let faucet_interface = faucet_account.code().interface(faucet_id);
    let send_script =
        SendFungibleFaucetNotesTransactionScript::new(&faucet_interface, &[partial_note])?;
    let mint_request = TransactionRequestBuilder::new()
        .input_notes([(faucet_fee_note, None)])
        .custom_script(send_script.tx_script().clone())
        .script_arg(send_script.tx_script_args())
        .expected_output_recipients([note.recipient().clone()])
        .expected_ntx_scripts(vec![P2idNote::script()])
        .build()?;
    let owner_before = client
        .get_account(recipient)
        .await?
        .context("mint recipient account is not tracked")?
        .vault()
        .get_balance(asset.id())?;
    let mint_tx = client
        .submit_new_transaction(faucet_id, mint_request)
        .await?;
    client.sync_state().await?;
    let mint_block = committed_block(&mut client, mint_tx).await?;
    let minted_record = client
        .get_input_note(note.id())
        .await?
        .context("minted P2ID note was not discovered for the owner")?;
    ensure!(
        minted_record.is_committed(),
        "minted probe note is not committed"
    );
    let minted_note: Note = minted_record.try_into()?;

    let consume_tx = client
        .submit_new_transaction(
            recipient,
            TransactionRequestBuilder::new()
                .input_notes([(minted_note, None)])
                .expected_ntx_scripts(vec![P2idNote::script()])
                .build()?,
        )
        .await?;
    client.sync_state().await?;
    let consume_block = committed_block(&mut client, consume_tx).await?;
    let owner_after = client
        .get_account(recipient)
        .await?
        .context("mint recipient state disappeared after note consumption")?
        .vault()
        .get_balance(asset.id())?;
    let faucet_after = client
        .get_account(faucet_id)
        .await?
        .context("faucet state disappeared after mint")?;
    let faucet_after = FungibleFaucet::try_from(&faucet_after)?;
    ensure!(
        owner_after.as_u64() == owner_before.as_u64() + amount,
        "recipient balance did not increase by exactly {amount}: {owner_before} -> {owner_after}"
    );
    ensure!(
        faucet_after.token_supply().as_u64() == supply_before.as_u64() + amount,
        "faucet supply did not increase by exactly {amount}"
    );
    let consumed_record = client
        .get_input_note(note.id())
        .await?
        .context("consumed probe note record is missing")?;
    ensure!(
        consumed_record.consumer_account() == Some(recipient),
        "mint note was not consumed by the configured recipient"
    );
    println!("faucet_id={faucet_id}");
    println!("faucet_fee_funding_note_id={fee_funding_id}");
    println!("faucet_native_fee_before_probe={fee_balance_before}");
    println!("faucet_native_fee_topup=151");
    println!("mint_transaction={mint_tx}");
    println!("mint_committed_block={mint_block}");
    println!("mint_note_id={}", note.id());
    println!("mint_amount={amount}");
    println!("mint_recipient={recipient}");
    println!("mint_consumption_transaction={consume_tx}");
    println!("mint_consumption_block={consume_block}");
    println!("owner_balance_before={owner_before}");
    println!("owner_balance_after={owner_after}");
    println!("faucet_supply_after={}", faucet_after.token_supply());
    Ok((
        mint_tx.to_string(),
        note.id().to_string(),
        consume_tx.to_string(),
    ))
}

async fn fund_account_native(
    sender: AccountId,
    target: AccountId,
    amount: u64,
) -> Result<(String, String)> {
    let mut client = client().await?;
    let sync = client.sync_state().await?;
    let fee_faucet = parse_id(FEE_FAUCET)?;
    let keys = FilesystemKeyStore::new(state_dir().join(".miden/keystore"))?;
    ensure!(
        !keys.get_keys_for_account(&sender).await?.is_empty(),
        "native fee funding sender key is missing from the durable keystore"
    );
    let mut note_rng = rng();
    let note = build_wallet_fee_note(sender, target, fee_faucet, amount, &mut note_rng)?;
    let txid = client
        .submit_new_transaction(
            sender,
            TransactionRequestBuilder::new()
                .own_output_notes([note.clone()])
                .expected_ntx_scripts(vec![P2idNote::script()])
                .build()?,
        )
        .await?;
    let committed = committed_block(&mut client, txid).await?;
    println!("native_fee_funding_transaction={txid}");
    println!("native_fee_funding_note_id={}", note.id());
    println!("native_fee_funding_sender={sender}");
    println!("native_fee_funding_target={target}");
    println!("faucet_fee_funding_amount={amount}");
    println!("native_fee_funding_committed_block={committed}");
    let synced = client.sync_state().await?;
    println!("synced_block_after_funding={}", synced.block_num);
    println!(
        "funding_transaction_status={}",
        client
            .get_transactions(TransactionFilter::Ids(vec![txid]))
            .await?
            .first()
            .map(|tx| format!("{:?}", tx.status))
            .unwrap_or_else(|| "Missing".to_string())
    );
    println!("prior_synced_block={}", sync.block_num);
    Ok((txid.to_string(), note.id().to_string()))
}

fn parse_id(value: &str) -> Result<AccountId> {
    AccountId::from_hex(value).context("invalid Miden account ID")
}

fn safe_account_status(status: &AccountStatus) -> &'static str {
    if status.is_new() {
        "New"
    } else if status.is_locked() {
        "Locked"
    } else {
        "Tracked"
    }
}

fn parse_config_id(value: &Option<String>, name: &str) -> Result<Option<AccountId>> {
    value
        .as_deref()
        .map(|value| {
            parse_id(value).with_context(|| format!("invalid configured {name} Account ID"))
        })
        .transpose()
}

fn configured_id(value: &Option<String>, name: &str) -> Result<AccountId> {
    parse_config_id(value, name)?.with_context(|| format!("configure {name} first"))
}

async fn status_snapshot(config: &TestnetConfig) -> Result<serde_json::Value> {
    let mut client = client().await?;
    let synced = client.sync_state().await?;
    let endpoint = Endpoint::testnet();
    let rpc = VerifyingRpcClient::new(GrpcClient::new(&endpoint, 10_000));
    let (header, _) = rpc.get_block_header_by_number(None, false).await?;
    let fee_faucet = header.fee_parameters().fee_faucet_id();
    let fee_balance = |account: &miden_client::account::Account| -> Result<AssetAmount> {
        Ok(account
            .vault()
            .get_balance(FungibleAsset::new(fee_faucet, 1)?.id())?)
    };
    let keys = FilesystemKeyStore::new(state_dir().join(".miden/keystore"))?;
    let owner_id = parse_config_id(&config.owner, "owner")?;
    let beneficiary_id = parse_config_id(&config.beneficiary, "beneficiary")?;
    let faucet_id = parse_config_id(&config.inherited_faucet, "inherited faucet")?;
    let vault_id = parse_config_id(&config.vault, "vault")?;
    let mut owner_balance = None;
    let mut beneficiary_balance = None;
    let mut faucet_supply = None;
    let mut faucet_signer = false;
    let mut owner_signer = false;
    let mut beneficiary_signer = false;
    let mut vault_data = serde_json::Value::Null;
    let mut vault_transaction_count = None;
    let asset_id = faucet_id
        .map(|id| FungibleAsset::new(id, 1).map(|asset| asset.id()))
        .transpose()?;

    if let Some(id) = owner_id {
        owner_signer = !keys.get_keys_for_account(&id).await?.is_empty();
        if let Some(account) = client.get_account(id).await? {
            owner_balance = Some(
                asset_id
                    .map(|asset_id| account.vault().get_balance(asset_id))
                    .transpose()?
                    .unwrap_or(AssetAmount::ZERO)
                    .as_u64(),
            );
        }
    }
    if let Some(id) = beneficiary_id {
        beneficiary_signer = !keys.get_keys_for_account(&id).await?.is_empty();
        if let Some(account) = client.get_account(id).await? {
            beneficiary_balance = Some(
                asset_id
                    .map(|asset_id| account.vault().get_balance(asset_id))
                    .transpose()?
                    .unwrap_or(AssetAmount::ZERO)
                    .as_u64(),
            );
        }
    }
    if let Some(id) = faucet_id {
        faucet_signer = !keys.get_keys_for_account(&id).await?.is_empty();
        if let Some(account) = client.get_account(id).await? {
            if let Ok(faucet) = FungibleFaucet::try_from(&account) {
                faucet_supply = Some(faucet.token_supply().as_u64());
            }
        }
    }
    if let Some(id) = vault_id {
        vault_transaction_count = Some(
            rpc.sync_transactions(BlockNumber::GENESIS, header.block_num(), vec![id])
                .await?
                .len(),
        );
        if let Some(account) = client.get_account(id).await? {
            let network = NetworkAccount::new(account.clone()).ok();
            let owner = account
                .storage()
                .get_item(&StorageSlotName::new(slot("owner"))?)?;
            let beneficiary = account
                .storage()
                .get_item(&StorageSlotName::new(slot("beneficiary"))?)?;
            let stored_faucet = account
                .storage()
                .get_item(&StorageSlotName::new(slot("asset_faucet"))?)?;
            let last_check_in = account
                .storage()
                .get_item(&StorageSlotName::new(slot("last_check_in"))?)?[0]
                .as_canonical_u64();
            let timeout = account
                .storage()
                .get_item(&StorageSlotName::new(slot("timeout_blocks"))?)?[0]
                .as_canonical_u64();
            let claimed = account
                .storage()
                .get_item(&StorageSlotName::new(slot("claimed"))?)?[0]
                .as_canonical_u64()
                != 0;
            let deadline = u32::try_from(last_check_in)
                .ok()
                .zip(u32::try_from(timeout).ok())
                .map(|(last, timeout)| derive_deadline(last, timeout))
                .transpose()?;
            let inherited = asset_id
                .map(|asset_id| account.vault().get_balance(asset_id))
                .transpose()?
                .unwrap_or(AssetAmount::ZERO);
            vault_data = serde_json::json!({
                "account_id": id.to_string(),
                "public": account.is_public(),
                "network_account_recognized": network.is_some(),
                "owner_account_id": config.owner,
                "beneficiary_account_id": config.beneficiary,
                "configured_inherited_faucet": config.inherited_faucet,
                "owner_storage": format!("{owner:?}"),
                "beneficiary_storage": format!("{beneficiary:?}"),
                "faucet_storage": format!("{stored_faucet:?}"),
                "last_check_in": last_check_in,
                "timeout_blocks": timeout,
                "deadline": deadline,
                "claimed": claimed,
                "inherited_balance": inherited.as_u64(),
                "native_fee_balance": fee_balance(&account)?.as_u64(),
                "note_allowlist": network.as_ref().map(|n| n.allowed_notes().allowed_script_roots().iter().map(|r| format!("{r:?}")).collect::<Vec<_>>()),
                "transaction_script_allowlist": network.as_ref().map(|n| n.allowed_tx_scripts().allowed_script_roots().iter().map(|r| format!("{r:?}")).collect::<Vec<_>>()),
            });
        }
    }
    let node_version = "not exposed by the stable v0.16 block-header API";
    Ok(serde_json::json!({
        "network": {
            "rpc_endpoint": config.rpc_endpoint,
            "synced_block": synced.block_num.as_u32(),
            "public_chain_block": header.block_num().as_u32(),
            "node_version": node_version,
            "client_version": "0.16.0",
            "native_fee_faucet": fee_faucet.to_string(),
            "verification_base_fee": header.fee_parameters().verification_base_fee(),
        },
        "accounts": {
            "owner": config.owner,
            "beneficiary": config.beneficiary,
            "inherited_faucet": config.inherited_faucet,
            "vault": config.vault,
        },
        "signers": {
            "owner": owner_signer,
            "beneficiary": beneficiary_signer,
            "faucet": faucet_signer,
        },
        "vault": vault_data,
        "vault_transaction_count": vault_transaction_count,
        "assets": {
            "symbol": config.asset_symbol,
            "owner_balance": owner_balance,
            "beneficiary_balance": beneficiary_balance,
            "faucet_supply": faucet_supply,
        },
        "payout_note_id": config.payout_note_id,
        "public_ids": config.public_ids,
    }))
}

fn print_status_value(value: &serde_json::Value, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(value)?);
    } else if value.get("verified").is_some() {
        println!("verified={}", value["verified"]);
        println!("sync_block={}", value["sync_block"]);
        println!("vault={}", value["vault"]);
        println!("owner={}", value["owner"]);
        println!("beneficiary={}", value["beneficiary"]);
        println!("faucet={}", value["faucet"]);
        println!("timeout_blocks={}", value["timeout_blocks"]);
        println!("claimed={}", value["claimed"]);
        println!("inherited_balance={}", value["inherited_balance"]);
        println!("native_fee_balance={}", value["native_fee_balance"]);
        println!("faucet_supply={}", value["faucet_supply"]);
        println!("allowlist_roots={}", value["allowlist_roots"]);
        println!(
            "transaction_script_roots={}",
            value["transaction_script_roots"]
        );
        println!("payout_status={}", value["payout_status"]);
    } else {
        println!("network={}", value["network"]);
        println!("accounts={}", value["accounts"]);
        println!("signers={}", value["signers"]);
        println!("vault={}", value["vault"]);
        println!("assets={}", value["assets"]);
        println!("payout_note_id={}", value["payout_note_id"]);
    }
    Ok(())
}

async fn verify_config(config: &TestnetConfig, json: bool) -> Result<()> {
    let owner = configured_id(&config.owner, "owner")?;
    let beneficiary = configured_id(&config.beneficiary, "beneficiary")?;
    let faucet_id = configured_id(&config.inherited_faucet, "inherited faucet")?;
    let vault_id = configured_id(&config.vault, "vault")?;
    let mut client = client().await?;
    let sync = client.sync_state().await?;
    let keys = FilesystemKeyStore::new(state_dir().join(".miden/keystore"))?;
    for (name, id) in [
        ("owner", owner),
        ("beneficiary", beneficiary),
        ("faucet", faucet_id),
    ] {
        ensure!(
            !keys.get_keys_for_account(&id).await?.is_empty(),
            "configured {name} signer is missing from the durable keystore"
        );
    }
    let account = client
        .get_account(vault_id)
        .await?
        .context("configured vault is absent from the durable client store")?;
    ensure!(account.is_public(), "configured vault is not public");
    let network = NetworkAccount::new(account.clone())
        .context("configured account is not recognized as a Network Account")?;
    for (name, expected) in [
        ("owner", owner),
        ("beneficiary", beneficiary),
        ("asset_faucet", faucet_id),
    ] {
        ensure!(
            account
                .storage()
                .get_item(&StorageSlotName::new(slot(name))?)?
                == owner_word(expected),
            "on-chain vault {name} does not match local config"
        );
    }
    let timeout = account
        .storage()
        .get_item(&StorageSlotName::new(slot("timeout_blocks"))?)?[0]
        .as_canonical_u64();
    ensure_positive_timeout(u32::try_from(timeout).context("stored timeout exceeds u32 range")?)?;
    if let Some(expected) = config.timeout_blocks {
        ensure!(
            timeout == u64::from(expected),
            "on-chain timeout {timeout} differs from config {expected}"
        );
    }
    let roots = network.allowed_notes().allowed_script_roots();
    validate_hardened_allowlists(
        roots,
        network.allowed_tx_scripts().allowed_script_roots(),
        NoteScript::from_package(&package("check-in-note")?)?.root(),
        NoteScript::from_package(&package("claim-note")?)?.root(),
        NoteScript::from_package(&package("deposit-note")?)?.root(),
        NetworkAccountConfigNote::script_root(),
        FeeSponsorshipNote::script_root(),
        P2idNote::script_root(),
        ExpirationTransactionScript::script_root(),
    )?;
    let inherited_balance = account
        .vault()
        .get_balance(FungibleAsset::new(faucet_id, 1)?.id())?;
    let fee_faucet = parse_id(FEE_FAUCET)?;
    let native_balance = account
        .vault()
        .get_balance(FungibleAsset::new(fee_faucet, 1)?.id())?;
    let claimed = account
        .storage()
        .get_item(&StorageSlotName::new(slot("claimed"))?)?[0]
        .as_canonical_u64()
        != 0;
    let faucet_account = client
        .get_account(faucet_id)
        .await?
        .context("configured faucet is absent from the durable store")?;
    let faucet = FungibleFaucet::try_from(&faucet_account)
        .context("configured inherited account is not a fungible faucet")?;
    let payout_status = if let Some(note_id) = config.payout_note_id.as_deref() {
        let note_id = miden_protocol::note::NoteId::try_from_hex(note_id)?;
        client
            .get_input_note(note_id)
            .await?
            .map(|note| {
                serde_json::json!({
                "note_id": note_id.to_string(),
                "committed": note.is_committed() || note.is_consumed(),
                    "consumed": note.is_consumed(),
                    "consumer": note.consumer_account().map(|id| id.to_string()),
                })
            })
            .unwrap_or_else(
                || serde_json::json!({"note_id": note_id.to_string(), "tracked": false}),
            )
    } else {
        serde_json::Value::Null
    };
    let value = serde_json::json!({
        "verified": true,
        "sync_block": sync.block_num.as_u32(),
        "vault": vault_id.to_string(),
        "owner": owner.to_string(),
        "beneficiary": beneficiary.to_string(),
        "faucet": faucet_id.to_string(),
        "timeout_blocks": timeout,
        "claimed": claimed,
        "inherited_balance": inherited_balance.as_u64(),
        "native_fee_balance": native_balance.as_u64(),
        "faucet_supply": faucet.token_supply().as_u64(),
        "allowlist_roots": roots.iter().map(|root| format!("{root:?}")).collect::<Vec<_>>(),
        "transaction_script_roots": network.allowed_tx_scripts().allowed_script_roots().iter().map(|root| format!("{root:?}")).collect::<Vec<_>>(),
        "payout_note_id": config.payout_note_id,
        "payout_status": payout_status,
    });
    print_status_value(&value, json)?;
    Ok(())
}

/// Refuses post-deployment mutations when local IDs, signers, or the hardened account surface
/// diverge from the public chain. Bootstrap commands run before a vault is configured and use
/// their own creation-specific checks.
async fn validate_configured_vault_for_mutation(config: &TestnetConfig) -> Result<()> {
    ensure!(
        config.rpc_endpoint == DEFAULT_RPC_ENDPOINT,
        "refusing mutation: configured RPC endpoint is not the supported public testnet"
    );
    let owner = configured_id(&config.owner, "owner")?;
    let beneficiary = configured_id(&config.beneficiary, "beneficiary")?;
    let faucet_id = configured_id(&config.inherited_faucet, "inherited faucet")?;
    let vault_id = configured_id(&config.vault, "vault")?;
    let mut client = client().await?;
    client.sync_state().await?;
    for (label, id) in [
        ("owner", owner),
        ("beneficiary", beneficiary),
        ("inherited faucet", faucet_id),
    ] {
        ensure!(
            client.get_account(id).await?.is_some(),
            "refusing mutation: configured {label} account is not tracked"
        );
    }
    let vault = client
        .get_account(vault_id)
        .await?
        .context("refusing mutation: configured vault is not tracked")?;
    ensure!(vault.is_public(), "refusing mutation: vault is not public");
    let network = NetworkAccount::new(vault.clone())
        .context("refusing mutation: configured vault is not a Network Account")?;
    for (name, id) in [
        ("owner", owner),
        ("beneficiary", beneficiary),
        ("asset_faucet", faucet_id),
    ] {
        ensure!(
            vault
                .storage()
                .get_item(&StorageSlotName::new(slot(name))?)?
                == owner_word(id),
            "refusing mutation: on-chain vault {name} differs from durable config"
        );
    }
    if let Some(timeout) = config.timeout_blocks {
        ensure!(
            vault
                .storage()
                .get_item(&StorageSlotName::new(slot("timeout_blocks"))?)?[0]
                == Felt::from(timeout),
            "refusing mutation: on-chain timeout differs from durable config"
        );
    }
    ensure_positive_timeout(
        u32::try_from(
            vault
                .storage()
                .get_item(&StorageSlotName::new(slot("timeout_blocks"))?)?[0]
                .as_canonical_u64(),
        )
        .context("stored timeout exceeds u32 range")?,
    )?;
    validate_hardened_allowlists(
        network.allowed_notes().allowed_script_roots(),
        network.allowed_tx_scripts().allowed_script_roots(),
        NoteScript::from_package(&package("check-in-note")?)?.root(),
        NoteScript::from_package(&package("claim-note")?)?.root(),
        NoteScript::from_package(&package("deposit-note")?)?.root(),
        NetworkAccountConfigNote::script_root(),
        FeeSponsorshipNote::script_root(),
        P2idNote::script_root(),
        ExpirationTransactionScript::script_root(),
    )?;
    let faucet_account = client
        .get_account(faucet_id)
        .await?
        .context("refusing mutation: configured faucet is not tracked")?;
    ensure!(
        faucet_account.is_public() && FungibleFaucet::try_from(&faucet_account).is_ok(),
        "refusing mutation: configured inherited account is not a public fungible faucet"
    );
    Ok(())
}

async fn committed_block(
    client: &mut miden_client::Client<FilesystemKeyStore>,
    txid: miden_protocol::transaction::TransactionId,
) -> Result<miden_protocol::block::BlockNumber> {
    for attempt in 0..15 {
        client.sync_state().await?;
        let mut records = client
            .get_transactions(TransactionFilter::Ids(vec![txid]))
            .await?;
        let record = records
            .pop()
            .with_context(|| format!("transaction {txid} is not tracked"))?;
        match record.status {
            TransactionStatus::Committed { block_number, .. } => return Ok(block_number),
            TransactionStatus::Discarded(cause) => {
                bail!("transaction {txid} was discarded: {cause}")
            }
            TransactionStatus::Pending if attempt < 14 => {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            TransactionStatus::Pending => {
                bail!("transaction {txid} is still pending after 15 sync attempts")
            }
        }
    }
    unreachable!("the final polling attempt always returns or errors")
}

async fn wait_for_network_execution(
    note_id: miden_protocol::note::NoteId,
    vault_id: AccountId,
    start_block: u32,
    policy: PollPolicy,
) -> Result<(u32, String, u32)> {
    let rpc = VerifyingRpcClient::new(GrpcClient::new(&Endpoint::testnet(), 10_000));
    let started = std::time::Instant::now();
    let mut reported_discovery = false;
    let mut reported_inflight = false;
    loop {
        let (header, _) = rpc.get_block_header_by_number(None, false).await?;
        match rpc.get_network_note_status(note_id).await {
            Ok(status) => {
                if !reported_discovery {
                    println!("ntx_discovered=true");
                    reported_discovery = true;
                }
                println!(
                    "ntx_status={} attempts={} last_attempt_block={:?}",
                    status.status, status.attempt_count, status.last_attempt_block_num
                );
                match status.status.to_string().as_str() {
                    "NullifierInflight" => reported_inflight = true,
                    "Discarded" => bail!(
                        "NTX builder discarded feature note {note_id}: {}",
                        status
                            .last_error
                            .unwrap_or_else(|| "no reason was provided".into())
                    ),
                    "NullifierCommitted" => {
                        println!("ntx_nullifier_committed=true");
                        let mut client = client().await?;
                        let sync = client.sync_state().await?;
                        let _account = client
                            .get_account(vault_id)
                            .await?
                            .context("vault not found after NTX nullifier commitment")?;
                        let history = rpc
                            .sync_transactions(
                                BlockNumber::GENESIS,
                                header.block_num(),
                                vec![vault_id],
                            )
                            .await?;
                        let latest = history
                            .into_iter()
                            .filter(|record| record.block_num.as_u32() >= start_block)
                            .max_by_key(|record| record.block_num);
                        let (tx_id, tx_block) = latest
                            .map(|record| {
                                (
                                    record.transaction_header.id().to_string(),
                                    record.block_num.as_u32(),
                                )
                            })
                            .unwrap_or_else(|| {
                                ("detected-by-note-nullifier".into(), sync.block_num.as_u32())
                            });
                        println!("vault_transaction_detected=true");
                        println!("vault_transaction_id={tx_id}");
                        println!("vault_transaction_block={tx_block}");
                        return Ok((header.block_num().as_u32(), tx_id, tx_block));
                    }
                    _ => {}
                }
                if reported_inflight {
                    println!("ntx_nullifier_inflight=true");
                }
            }
            Err(error) => {
                if started.elapsed().as_secs() >= policy.timeout_seconds {
                    bail!("NTX builder has not discovered the feature note. Verify NetworkAccountTarget attachment. Last status error: {error}");
                }
                println!("ntx_discovery=pending; attachment target is required ({error})");
            }
        }
        if started.elapsed().as_secs() >= policy.timeout_seconds {
            bail!(
                "timed out waiting for NTX execution of {note_id} after {} seconds",
                policy.timeout_seconds
            );
        }
        tokio::time::sleep(Duration::from_secs(policy.poll_seconds)).await;
    }
}

async fn tracked_note_for_consumption(
    client: &miden_client::Client<FilesystemKeyStore>,
    note_id: miden_protocol::note::NoteId,
) -> Result<Note> {
    if let Some(record) = client.get_input_note(note_id).await? {
        ensure!(
            record.is_committed(),
            "input note {note_id} is not committed"
        );
        ensure!(
            record.consumer_account().is_none(),
            "note {note_id} has already been consumed by {:?}",
            record.consumer_account()
        );
        return Ok(record.try_into()?);
    }

    let record = client
        .get_output_note(note_id)
        .await?
        .with_context(|| format!("note {note_id} is not tracked as input or output"))?;
    ensure!(
        record.is_committed(),
        "output note {note_id} is not committed"
    );
    ensure!(
        !record.is_consumed(),
        "note {note_id} has already been consumed by {:?}",
        record.state()
    );
    Ok(record.try_into()?)
}

async fn create_vault(
    owner: AccountId,
    beneficiary: AccountId,
    asset_faucet: AccountId,
    timeout: u32,
    config_path: &Path,
    config: &mut TestnetConfig,
) -> Result<AccountId> {
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
    config
        .public_ids
        .insert("pending_vault".into(), id.to_string());
    config.save(config_path)?;
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
    let bootstrap_p2id_note_id = feature_note.id();
    config.public_ids.insert(
        "vault_bootstrap_p2id_note".into(),
        bootstrap_p2id_note_id.to_string(),
    );
    config.public_ids.insert(
        "vault_bootstrap_sponsorship_note".into(),
        sponsorship_note.id().to_string(),
    );
    config.save(config_path)?;

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
    config.public_ids.insert(
        "vault_bootstrap_funding_transaction".into(),
        bootstrap_note_tx.to_string(),
    );
    config.save(config_path)?;
    println!("bootstrap_p2id_note_id={bootstrap_p2id_note_id}");
    println!("bootstrap_sponsorship_note_id={}", sponsorship_note.id());

    let note_sync = client.sync_state().await?;
    let bootstrap_note_block = committed_block(&mut client, bootstrap_note_tx).await?;
    let deploy_request = TransactionRequestBuilder::new()
        .input_notes([(feature_note, None), (sponsorship_note, None)])
        .expected_ntx_scripts(vec![P2idNote::script(), FeeSponsorshipNote::script()])
        .build()?;
    let txid = client.submit_new_transaction(id, deploy_request).await?;
    config
        .public_ids
        .insert("vault_deployment_transaction".into(), txid.to_string());
    config.save(config_path)?;
    let deployment_sync = client.sync_state().await?;
    let deployment_block = committed_block(&mut client, txid).await?;
    config.public_ids.insert(
        "vault_deployment_block".into(),
        deployment_block.to_string(),
    );
    config.save(config_path)?;
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
    Ok(id)
}

async fn verify_vault(
    id: AccountId,
    owner: AccountId,
    beneficiary: AccountId,
    asset_faucet: AccountId,
    expected_timeout: u32,
) -> Result<()> {
    let mut client = client().await?;
    let sync = client.sync_state().await?;
    let rpc = VerifyingRpcClient::new(GrpcClient::new(&Endpoint::testnet(), 10_000));
    let (chain_header, _) = rpc.get_block_header_by_number(None, false).await?;
    let chain_account = rpc
        .get_account_details(id)
        .await?
        .context("vault is not present in the public testnet account state")?;
    let chain_network_account = NetworkAccount::new(chain_account)?;
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
            .get_item(&StorageSlotName::new(slot("asset_faucet"))?)?
            == owner_word(asset_faucet),
        "vault configured inherited faucet differs from the expected account"
    );
    ensure!(
        account
            .storage()
            .get_item(&StorageSlotName::new(slot("timeout_blocks"))?)?[0]
            == Felt::from(expected_timeout),
        "vault timeout differs from configured timeout"
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
    validate_hardened_allowlists(
        network_account.allowed_notes().allowed_script_roots(),
        network_account.allowed_tx_scripts().allowed_script_roots(),
        check_in,
        claim,
        deposit,
        config,
        sponsorship,
        p2id,
        ExpirationTransactionScript::script_root(),
    )?;
    let mut random = rng();
    let p2id_probe: Note = P2idNote::builder()
        .sender(owner)
        .target(id)
        .asset(FungibleAsset::new(parse_id(FEE_FAUCET)?, 1)?)
        .note_type(NoteType::Public)
        .generate_serial_number(&mut random)
        .build()?
        .into();
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
    println!("public_chain_block={}", chain_header.block_num());
    println!("vault_id={id}");
    println!("account_status={status}");
    println!("owner={owner}");
    println!("beneficiary={beneficiary}");
    println!("timeout_blocks={expected_timeout}");
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
    println!("allowlist_stage=hardened");
    println!(
        "p2id_rejection=locally confirmed: {}",
        if network_account
            .allowed_notes()
            .allowed_script_roots()
            .contains(&p2id)
        {
            "P2ID remains temporarily allowlisted pending config-note cleanup"
        } else {
            "canonical P2ID root is absent; auth rejects it before execution"
        }
    );
    println!(
        "p2id_allowed={}",
        network_account
            .allowed_notes()
            .allowed_script_roots()
            .contains(&P2idNote::script_root())
    );
    println!(
        "public_chain_note_allowlist={:?}",
        chain_network_account.allowed_notes().allowed_script_roots()
    );
    println!(
        "public_chain_p2id_allowed={}",
        chain_network_account
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
    expected_timeout: u32,
    policy: PollPolicy,
) -> Result<(String, String, String, String)> {
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
            == Felt::from(expected_timeout)
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
        .attachment(network_target(vault_id)?)
        .generate_serial_number(&mut random)
        .build()?
        .into();
    assert_network_target(&config_note, vault_id)?;
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
    let owner_block = committed_block(&mut client, owner_tx).await?;

    println!("config_note_target={}", vault_id);
    println!("config_note_submitted_by_owner_only=true");
    let (_, config_tx, config_block) =
        wait_for_network_execution(config_note_id, vault_id, owner_block.as_u32(), policy).await?;
    println!("config_network_transaction_id={config_tx}");
    let final_sync = client.sync_state().await?;
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
        "owner={owner} beneficiary={beneficiary} timeout_blocks={expected_timeout} last_check_in=0 claimed=false"
    );
    println!("native_fee_before={fee_before} sponsorship_supplied={sponsorship_amount} native_fee_after={fee_after}");
    println!("inherited_balance_after={inherited_after}");
    Ok((
        config_note_id.to_string(),
        sponsorship_note_id.to_string(),
        owner_tx.to_string(),
        config_tx,
    ))
}

async fn inspect_public_payout(
    note_id: miden_protocol::note::NoteId,
    vault_id: AccountId,
    beneficiary: AccountId,
    asset_faucet: AccountId,
) -> Result<u64> {
    let rpc = VerifyingRpcClient::new(GrpcClient::new(&Endpoint::testnet(), 10_000));
    let (header, _) = rpc.get_block_header_by_number(None, false).await?;
    let fetched = rpc.get_notes_by_id(&[note_id]).await?;
    let (note, proof) = fetched
        .into_iter()
        .find_map(|fetched| match fetched {
            miden_client::rpc::domain::note::FetchedNote::Public(note, proof) => {
                Some((note, proof))
            }
            _ => None,
        })
        .context("payout note is not publicly discoverable")?;
    ensure!(
        note.metadata().sender() == vault_id,
        "P2ID note was not created by the configured vault"
    );
    ensure!(
        note.recipient().script().root() == P2idNote::script_root(),
        "payout note does not use canonical P2ID"
    );
    let storage = P2idNoteStorage::try_from(note.recipient().storage().items())?;
    ensure!(
        storage.target() == beneficiary,
        "P2ID target is not the configured beneficiary"
    );
    let assets = note.assets().iter_fungible().collect::<Vec<_>>();
    ensure!(
        assets.len() == 1,
        "payout must contain exactly one fungible asset"
    );
    ensure!(
        assets[0].faucet_id() == asset_faucet,
        "P2ID does not contain the configured inherited asset"
    );
    let payout_amount = assets[0].amount().as_u64();
    ensure!(payout_amount > 0, "P2ID payout amount is zero");
    println!("public_chain_block={}", header.block_num());
    println!("payout_note_id={note_id}");
    println!("payout_committed_block={}", proof.location().block_num());
    println!("payout_nullifier={}", note.nullifier());
    println!("payout_script_root={}", note.recipient().script().root());
    println!("payout_recipient={}", storage.target());
    println!("payout_assets={:?}", note.assets());
    Ok(payout_amount)
}

async fn consume_public_payout(
    beneficiary: AccountId,
    vault_id: AccountId,
    asset_faucet: AccountId,
    note_id: miden_protocol::note::NoteId,
) -> Result<String> {
    let mut client = client().await?;
    let sync = client.sync_state().await?;
    let payout_amount = inspect_public_payout(note_id, vault_id, beneficiary, asset_faucet).await?;
    let note = tracked_note_for_consumption(&client, note_id).await?;
    let fee_asset_id = FungibleAsset::new(parse_id(FEE_FAUCET)?, 1)?.id();
    let inherited_asset_id = FungibleAsset::new(asset_faucet, 1)?.id();
    let before = client
        .get_account(beneficiary)
        .await?
        .context("beneficiary account is not tracked")?;
    let native_before = before.vault().get_balance(fee_asset_id)?;
    let inherited_before = before.vault().get_balance(inherited_asset_id)?;
    let endpoint = Endpoint::testnet();
    let rpc = VerifyingRpcClient::new(GrpcClient::new(&endpoint, 10_000));
    let (header, _) = rpc.get_block_header_by_number(None, false).await?;
    let minimum_reserve =
        u64::from(header.fee_parameters().verification_base_fee()).saturating_mul(17);
    ensure!(native_before.as_u64() >= minimum_reserve, "beneficiary native fee reserve {} is below the estimated wallet requirement {minimum_reserve}; fund fees through normal P2ID first", native_before);
    let txid = client
        .submit_new_transaction(
            beneficiary,
            TransactionRequestBuilder::new()
                .input_notes([(note, None)])
                .expected_ntx_scripts(vec![P2idNote::script()])
                .build()?,
        )
        .await?;
    let committed = committed_block(&mut client, txid).await?;
    let after = client
        .get_account(beneficiary)
        .await?
        .context("beneficiary account disappeared after payout consumption")?;
    let inherited_after = after.vault().get_balance(inherited_asset_id)?;
    let consumed = client
        .get_input_note(note_id)
        .await?
        .context("payout note record is missing after consumption")?;
    ensure!(
        consumed.consumer_account() == Some(beneficiary),
        "payout was not consumed by the configured beneficiary"
    );
    ensure!(
        inherited_after.as_u64() == inherited_before.as_u64() + payout_amount,
        "beneficiary balance did not increase by the full payout amount {payout_amount}"
    );
    println!("beneficiary_starting_sync_block={}", sync.block_num);
    println!("payout_consumption_transaction_id={txid}");
    println!("payout_consumption_committed_block={committed}");
    println!("payout_note_id={note_id}");
    println!(
        "payout_nullifier_consumed_by={:?}",
        consumed.consumer_account()
    );
    println!("beneficiary_HBTESTV_before={inherited_before}");
    println!("beneficiary_HBTESTV_after={inherited_after}");
    println!("beneficiary_native_fee_before={native_before}");
    println!(
        "beneficiary_native_fee_after={}",
        after.vault().get_balance(fee_asset_id)?
    );
    Ok(txid.to_string())
}

#[derive(serde::Serialize)]
struct FeatureResult {
    command: String,
    funding_transaction_id: Option<String>,
    feature_note_id: String,
    sponsorship_note_id: String,
    ntx_status: String,
    vault_transaction_id: Option<String>,
    vault_transaction_block: Option<u32>,
    inherited_balance: u64,
    last_check_in: u64,
    timeout_blocks: u64,
    deadline: u64,
    claimed: bool,
    payout_note_id: Option<String>,
    dry_run: bool,
}

fn live_submission_enabled(dry_run: bool, yes: bool) -> Result<bool> {
    if dry_run {
        return Ok(false);
    }
    ensure!(
        yes,
        "no transaction submitted; review the preflight and rerun with --yes"
    );
    Ok(true)
}

async fn submit_feature_command(
    kind: &str,
    config_path: &Path,
    config: &mut TestnetConfig,
    amount: u64,
    dry_run: bool,
    yes: bool,
    policy: PollPolicy,
    json: bool,
) -> Result<()> {
    let owner = configured_id(&config.owner, "owner")?;
    let beneficiary = configured_id(&config.beneficiary, "beneficiary")?;
    let vault_id = configured_id(&config.vault, "vault")?;
    let faucet_id = configured_id(&config.inherited_faucet, "inherited faucet")?;
    let sender = match kind {
        "deposit" | "heartbeat" => owner,
        "claim" => beneficiary,
        _ => bail!("unsupported Heirbeat operation {kind}"),
    };
    ensure!(
        (kind == "deposit" && amount > 0) || (kind != "deposit" && amount == 0),
        "only deposit accepts a positive --amount"
    );
    ensure!(
        config.timeout_blocks.is_some(),
        "timeout_blocks is missing from config; configure the vault first"
    );

    let mut client = client().await?;
    let sync = client.sync_state().await?;
    let rpc = VerifyingRpcClient::new(GrpcClient::new(&Endpoint::testnet(), 10_000));
    let (header, _) = rpc.get_block_header_by_number(None, false).await?;
    let vault = client
        .get_account(vault_id)
        .await?
        .context("vault is not tracked; run verify or deploy-vault first")?;
    let network =
        NetworkAccount::new(vault.clone()).context("configured vault is not a Network Account")?;
    for (name, id) in [
        ("owner", owner),
        ("beneficiary", beneficiary),
        ("asset_faucet", faucet_id),
    ] {
        ensure!(
            vault
                .storage()
                .get_item(&StorageSlotName::new(slot(name))?)?
                == owner_word(id),
            "configured {name} does not match on-chain vault state"
        );
    }
    let claimed = vault
        .storage()
        .get_item(&StorageSlotName::new(slot("claimed"))?)?[0]
        .as_canonical_u64()
        != 0;
    ensure_unclaimed(claimed, kind)?;
    let last_check_in = vault
        .storage()
        .get_item(&StorageSlotName::new(slot("last_check_in"))?)?[0]
        .as_canonical_u64();
    let timeout_blocks = vault
        .storage()
        .get_item(&StorageSlotName::new(slot("timeout_blocks"))?)?[0]
        .as_canonical_u64();
    let deadline = derive_deadline(
        u32::try_from(last_check_in)
            .context("stored last_check_in exceeds the protocol u32 range")?,
        u32::try_from(timeout_blocks).context("stored timeout exceeds the protocol u32 range")?,
    )?;
    if kind == "claim" {
        ensure_claim_eligible(sync.block_num.as_u32(), deadline)?;
    }
    validate_hardened_allowlists(
        network.allowed_notes().allowed_script_roots(),
        network.allowed_tx_scripts().allowed_script_roots(),
        NoteScript::from_package(&package("check-in-note")?)?.root(),
        NoteScript::from_package(&package("claim-note")?)?.root(),
        NoteScript::from_package(&package("deposit-note")?)?.root(),
        NetworkAccountConfigNote::script_root(),
        FeeSponsorshipNote::script_root(),
        P2idNote::script_root(),
        ExpirationTransactionScript::script_root(),
    )?;
    let asset_id = FungibleAsset::new(faucet_id, 1)?.id();
    let inherited_before = vault.vault().get_balance(asset_id)?;
    if kind == "deposit" {
        let owner_account = client
            .get_account(owner)
            .await?
            .context("owner account is not tracked")?;
        let owner_asset_balance = owner_account.vault().get_balance(asset_id)?;
        ensure!(
            owner_asset_balance.as_u64() >= amount,
            "owner has {owner_asset_balance} configured assets; deposit requests {amount}"
        );
    }
    if kind == "claim" {
        ensure!(
            inherited_before > AssetAmount::ZERO,
            "vault has zero inheritable balance; claim is disabled"
        );
    }

    let script_name = match kind {
        "deposit" => "deposit-note",
        "heartbeat" => "check-in-note",
        "claim" => "claim-note",
        _ => unreachable!(),
    };
    let script = NoteScript::from_package(&package(script_name)?)?;
    ensure!(
        network
            .allowed_notes()
            .allowed_script_roots()
            .contains(&script.root()),
        "{script_name} root is not allowlisted by the configured vault"
    );
    let target = network_target(vault_id)?;
    let mut builder = NoteBuilder::new(sender, rng())
        .tag(NoteTag::with_account_target(vault_id).into())
        .note_type(NoteType::Public)
        .script(script.clone())
        .attachment(target);
    if kind == "deposit" {
        builder = builder
            .add_assets([FungibleAsset::new(faucet_id, amount)?.into()])
            .note_storage([vault_id.suffix(), vault_id.prefix().as_felt()])?;
    }
    let feature_note: Note = builder.build()?;
    assert_network_target(&feature_note, vault_id)?;
    let feature_note_id = feature_note.id();
    let fee_faucet = header.fee_parameters().fee_faucet_id();
    let mut note_rng = rng();
    let sponsorship_note = build_network_sponsorship(
        sender,
        vault_id,
        feature_note_id,
        fee_faucet,
        DEFAULT_NETWORK_SPONSORSHIP_AMOUNT,
        &mut note_rng,
    )?;
    let sponsorship_storage =
        FeeSponsorshipNoteStorage::try_from(sponsorship_note.recipient().storage().items())?;
    ensure_sponsorship_pair(
        feature_note_id,
        sponsorship_note.recipient().storage().items(),
    )?;
    let keys = FilesystemKeyStore::new(state_dir().join(".miden/keystore"))?;
    ensure!(
        !keys.get_keys_for_account(&sender).await?.is_empty(),
        "configured sender key is missing from the durable keystore"
    );
    let sender_account = client
        .get_account(sender)
        .await?
        .context("configured note sender is not tracked")?;
    let native_balance = sender_account
        .vault()
        .get_balance(FungibleAsset::new(fee_faucet, 1)?.id())?;
    ensure!(native_balance >= AssetAmount::from(header.fee_parameters().verification_base_fee()), "wallet native fee balance is below the current base fee; use fund-fees with a normal P2ID note");
    let funding_request = TransactionRequestBuilder::new()
        .own_output_notes([feature_note.clone(), sponsorship_note.clone()])
        .expected_ntx_scripts(vec![script.clone(), FeeSponsorshipNote::script()])
        .build()?;

    println!("command={kind}");
    println!("network_account={vault_id}");
    println!("sender={sender}");
    println!(
        "target_attachment={:?}",
        NetworkAccountTarget::try_from(feature_note.attachments())?
    );
    println!("feature_note_id={feature_note_id}");
    println!("feature_note_root={}", script.root());
    println!("sponsorship_note_id={}", sponsorship_note.id());
    println!(
        "sponsorship_feature_note_id={}",
        sponsorship_storage.feature_note_id()
    );
    println!("current_block={}", sync.block_num);
    println!(
        "verification_base_fee={}",
        header.fee_parameters().verification_base_fee()
    );
    println!("inherited_balance_before={inherited_before}");
    println!("last_check_in_before={last_check_in}");
    println!("timeout_blocks={timeout_blocks}");
    println!("deadline={deadline}");
    println!("claimed={claimed}");
    if kind == "claim" {
        println!("payout_destination={beneficiary}");
        println!("expected_payout={inherited_before}");
    }
    if dry_run {
        let result = FeatureResult {
            command: kind.to_owned(),
            funding_transaction_id: None,
            feature_note_id: feature_note_id.to_string(),
            sponsorship_note_id: sponsorship_note.id().to_string(),
            ntx_status: "not_submitted_dry_run".to_owned(),
            vault_transaction_id: None,
            vault_transaction_block: None,
            inherited_balance: inherited_before.as_u64(),
            last_check_in,
            timeout_blocks,
            deadline,
            claimed,
            payout_note_id: None,
            dry_run: true,
        };
        if json {
            println!("{}", serde_json::to_string_pretty(&result)?);
        } else {
            println!("dry_run=true; no transaction was submitted");
        }
        return Ok(());
    }
    ensure!(
        live_submission_enabled(dry_run, yes)?,
        "internal error: dry-run reached submission"
    );
    let pending_key = format!("{kind}_pending_feature_note");
    ensure!(
        !config.public_ids.contains_key(&pending_key),
        "a {kind} feature note is already pending; refusing to create a duplicate. Check the recorded note ID in the durable config"
    );

    let funding_tx = client
        .submit_new_transaction(sender, funding_request)
        .await?;
    let funding_block = committed_block(&mut client, funding_tx).await?;
    config
        .public_ids
        .insert(pending_key.clone(), feature_note_id.to_string());
    config.public_ids.insert(
        format!("{kind}_funding_transaction"),
        funding_tx.to_string(),
    );
    config.public_ids.insert(
        format!("{kind}_fee_sponsorship_note"),
        sponsorship_note.id().to_string(),
    );
    config.save(config_path)?;
    println!("feature_note_committed_block={funding_block}");
    println!("funding_transaction_id={funding_tx}");
    println!("feature_note_committed=true");
    let (_, vault_tx, vault_tx_block) =
        wait_for_network_execution(feature_note_id, vault_id, funding_block.as_u32(), policy)
            .await?;
    let final_sync = client.sync_state().await?;
    let updated = client
        .get_account(vault_id)
        .await?
        .context("vault state missing after NTX execution")?;
    let inherited_after = updated.vault().get_balance(asset_id)?;
    let last_after = updated
        .storage()
        .get_item(&StorageSlotName::new(slot("last_check_in"))?)?[0]
        .as_canonical_u64();
    let claimed_after = updated
        .storage()
        .get_item(&StorageSlotName::new(slot("claimed"))?)?[0]
        .as_canonical_u64()
        != 0;
    match kind {
        "deposit" => {
            ensure!(
                inherited_after.as_u64() == inherited_before.as_u64() + amount,
                "deposit did not increase vault balance by exactly {amount}"
            );
            ensure!(
                last_after == last_check_in && !claimed_after,
                "deposit changed heartbeat or claimed state"
            );
        }
        "heartbeat" => {
            ensure!(
                last_after > last_check_in,
                "heartbeat did not advance last_check_in"
            );
            ensure!(
                inherited_after == inherited_before && !claimed_after,
                "heartbeat changed assets or claimed state"
            );
        }
        "claim" => {
            ensure!(
                claimed_after && inherited_after == AssetAmount::ZERO,
                "eligible claim did not set terminal state and drain the vault"
            );
            ensure!(last_after == last_check_in, "claim changed last_check_in");
        }
        _ => unreachable!(),
    }
    let mut payout_note_id = None;
    if kind == "claim" {
        let (note_id, payout_block) = find_vault_payout(
            vault_id,
            beneficiary,
            faucet_id,
            inherited_before.as_u64(),
            vault_tx_block,
        )
        .await?;
        println!("payout_note_id={note_id}");
        println!("payout_committed_block={payout_block}");
        payout_note_id = Some(note_id.clone());
        config.payout_note_id = Some(note_id.clone());
        config
            .public_ids
            .insert("claim_payout_note".into(), note_id);
    }
    config.public_ids.insert(
        format!("{kind}_funding_transaction"),
        funding_tx.to_string(),
    );
    config
        .public_ids
        .insert(format!("{kind}_feature_note"), feature_note_id.to_string());
    config.public_ids.insert(
        format!("{kind}_fee_sponsorship_note"),
        sponsorship_note.id().to_string(),
    );
    config
        .public_ids
        .insert(format!("{kind}_vault_transaction"), vault_tx.clone());
    config.public_ids.insert(
        format!("{kind}_vault_transaction_block"),
        vault_tx_block.to_string(),
    );
    config
        .public_ids
        .insert("last_check_in".into(), last_after.to_string());
    config.public_ids.insert(
        "deadline".into(),
        derive_deadline(
            u32::try_from(last_after).context("stored last_check_in exceeds protocol u32 range")?,
            u32::try_from(timeout_blocks).context("stored timeout exceeds protocol u32 range")?,
        )?
        .to_string(),
    );
    config.public_ids.remove(&pending_key);
    config.save(config_path)?;
    let result = FeatureResult {
        command: kind.to_owned(),
        funding_transaction_id: Some(funding_tx.to_string()),
        feature_note_id: feature_note_id.to_string(),
        sponsorship_note_id: sponsorship_note.id().to_string(),
        ntx_status: "NullifierCommitted".to_owned(),
        vault_transaction_id: Some(vault_tx),
        vault_transaction_block: Some(vault_tx_block),
        inherited_balance: inherited_after.as_u64(),
        last_check_in: last_after,
        timeout_blocks,
        deadline: derive_deadline(last_after as u32, timeout_blocks as u32)?,
        claimed: claimed_after,
        payout_note_id,
        dry_run: false,
    };
    if json {
        println!("{}", serde_json::to_string_pretty(&result)?);
    } else {
        println!("synced_block={}", final_sync.block_num);
        println!("inherited_balance_after={}", result.inherited_balance);
        println!("last_check_in={}", result.last_check_in);
        println!("timeout_blocks={}", result.timeout_blocks);
        println!("deadline={}", result.deadline);
        println!("claimed={}", result.claimed);
    }
    Ok(())
}

#[cfg(test)]
mod cli_safety_tests {
    use super::*;

    #[test]
    fn dry_run_never_enables_submission() {
        assert!(!live_submission_enabled(true, true).unwrap());
        assert!(!live_submission_enabled(true, false).unwrap());
        assert!(live_submission_enabled(false, false).is_err());
        assert!(live_submission_enabled(false, true).unwrap());
    }
}

async fn find_vault_payout(
    vault_id: AccountId,
    beneficiary: AccountId,
    faucet_id: AccountId,
    expected_amount: u64,
    start_block: u32,
) -> Result<(String, u32)> {
    let rpc = VerifyingRpcClient::new(GrpcClient::new(&Endpoint::testnet(), 10_000));
    let (header, _) = rpc.get_block_header_by_number(None, false).await?;
    let history = rpc
        .sync_transactions(BlockNumber::GENESIS, header.block_num(), vec![vault_id])
        .await?;
    for tx in history
        .into_iter()
        .filter(|tx| tx.block_num.as_u32() >= start_block)
    {
        let output_ids = tx
            .transaction_header
            .output_notes()
            .iter()
            .map(|note| note.id())
            .collect::<Vec<_>>();
        for fetched in rpc.get_notes_by_id(&output_ids).await? {
            if let miden_client::rpc::domain::note::FetchedNote::Public(note, proof) = fetched {
                if note.metadata().sender() != vault_id
                    || note.recipient().script().root() != P2idNote::script_root()
                {
                    continue;
                }
                let target =
                    P2idNoteStorage::try_from(note.recipient().storage().items())?.target();
                let assets = note.assets().iter_fungible().collect::<Vec<_>>();
                if target == beneficiary
                    && assets.len() == 1
                    && assets[0].faucet_id() == faucet_id
                    && assets[0].amount().as_u64() == expected_amount
                {
                    return Ok((note.id().to_string(), proof.location().block_num().as_u32()));
                }
            }
        }
    }
    bail!("claim committed but no beneficiary-bound P2ID payout matching the full pre-claim balance was found")
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

#[tokio::main]
async fn main() -> Result<()> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() || args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print_cli_help();
        return Ok(());
    }
    let command = args[0].as_str();
    let mut values = std::collections::BTreeMap::<String, String>::new();
    let mut flags = BTreeSet::<String>::new();
    let mut i = 1;
    while i < args.len() {
        let key = &args[i];
        ensure!(
            key.starts_with("--"),
            "unexpected positional argument {key:?}; see --help"
        );
        let name = key.trim_start_matches("--").to_owned();
        ensure!(
            matches!(
                name.as_str(),
                "yes"
                    | "dry-run"
                    | "json"
                    | "force"
                    | "config"
                    | "owner"
                    | "beneficiary"
                    | "faucet"
                    | "vault"
                    | "timeout"
                    | "amount"
                    | "recipient"
                    | "symbol"
                    | "name"
                    | "decimals"
                    | "max-supply"
                    | "note"
                    | "target"
                    | "sender"
                    | "poll-seconds"
                    | "timeout-seconds"
            ),
            "unknown option --{name}; see --help"
        );
        if matches!(name.as_str(), "yes" | "dry-run" | "json" | "force") {
            ensure!(flags.insert(name.clone()), "duplicate flag --{name}");
            i += 1;
        } else {
            let value = args
                .get(i + 1)
                .with_context(|| format!("--{name} requires a value"))?
                .clone();
            ensure!(!value.starts_with("--"), "--{name} requires a value");
            ensure!(
                values.insert(name.clone(), value).is_none(),
                "duplicate option --{name}"
            );
            i += 2;
        }
    }
    let config_path = values
        .get("config")
        .map(PathBuf::from)
        .unwrap_or_else(default_config_path);
    let mut config = load_cli_config(&config_path)?;
    let yes = flags.contains("yes");
    let dry_run = flags.contains("dry-run");
    let json = flags.contains("json");
    let force = flags.contains("force");
    ensure!(
        !dry_run || matches!(command, "deposit" | "heartbeat" | "claim"),
        "--dry-run is supported only for deposit, heartbeat, and claim"
    );
    ensure!(
        !json || matches!(command, "status" | "verify"),
        "--json is supported only for status and verify"
    );
    ensure!(
        !force || command == "create-faucet",
        "--force is supported only for create-faucet"
    );
    let policy = PollPolicy::new(
        values
            .get("poll-seconds")
            .map(|s| s.parse())
            .transpose()?
            .unwrap_or(config.poll_seconds),
        values
            .get("timeout-seconds")
            .map(|s| s.parse())
            .transpose()?
            .unwrap_or(config.timeout_seconds),
    )?;
    if matches!(
        command,
        "mint" | "deposit" | "heartbeat" | "claim" | "consume" | "fund-fees"
    ) && config.vault.is_some()
    {
        validate_configured_vault_for_mutation(&config).await?;
    }
    match command {
        "configure" => {
            if let Some(value) = values.get("owner") {
                config.owner = Some(parse_id(value)?.to_string());
            }
            if let Some(value) = values.get("beneficiary") {
                config.beneficiary = Some(parse_id(value)?.to_string());
            }
            if let Some(value) = values.get("faucet") {
                config.inherited_faucet = Some(parse_id(value)?.to_string());
            }
            if let Some(value) = values.get("vault") {
                config.vault = Some(parse_id(value)?.to_string());
            }
            if let Some(value) = values.get("timeout") {
                config.timeout_blocks = Some(value.parse()?);
            }
            config.save(&config_path)?;
            println!("config_path={}", config_path.display());
        }
        "status" => print_status_value(&status_snapshot(&config).await?, json)?,
        "verify" => verify_config(&config, json).await?,
        "create-faucet" => {
            let owner = configured_id(&config.owner, "owner")?;
            let symbol = values
                .get("symbol")
                .cloned()
                .or_else(|| config.asset_symbol.clone())
                .unwrap_or_else(|| "HBTEST".to_owned());
            let name = values
                .get("name")
                .cloned()
                .or_else(|| config.asset_name.clone())
                .unwrap_or_else(|| "Heirbeat Test Asset".to_owned());
            ensure!(
                symbol.len() >= 2
                    && symbol.len() <= 6
                    && symbol
                        .bytes()
                        .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()),
                "symbol must be 2-6 uppercase ASCII letters/digits"
            );
            let decimals = values
                .get("decimals")
                .map(|s| s.parse())
                .transpose()?
                .or(config.asset_decimals)
                .unwrap_or(0u8);
            let max_supply = values
                .get("max-supply")
                .map(|s| s.parse())
                .transpose()?
                .or(config.asset_max_supply)
                .unwrap_or(1_000_000u64);
            ensure!(max_supply > 0, "--max-supply must be positive");
            println!("preflight=create-faucet owner={owner} symbol={symbol} name={name} decimals={decimals} max_supply={max_supply}");
            ensure!(
                yes,
                "no faucet created; review preflight and rerun with --yes"
            );
            let faucet = if !force {
                match config.inherited_faucet.as_deref() {
                    Some(existing) => parse_id(existing)?,
                    None => {
                        let id = create_durable_faucet(owner, &name, &symbol, decimals, max_supply)
                            .await?;
                        config.inherited_faucet = Some(id.to_string());
                        config.asset_name = Some(name.to_owned());
                        config.asset_symbol = Some(symbol.to_owned());
                        config.asset_decimals = Some(decimals);
                        config.asset_max_supply = Some(max_supply);
                        config
                            .public_ids
                            .insert("faucet_account".into(), id.to_string());
                        config.save(&config_path)?;
                        id
                    }
                }
            } else {
                let id = create_durable_faucet(owner, &name, &symbol, decimals, max_supply).await?;
                config.inherited_faucet = Some(id.to_string());
                config.asset_name = Some(name.to_owned());
                config.asset_symbol = Some(symbol.to_owned());
                config.asset_decimals = Some(decimals);
                config.asset_max_supply = Some(max_supply);
                config
                    .public_ids
                    .insert("faucet_account".into(), id.to_string());
                config.save(&config_path)?;
                id
            };
            ensure!(
                config
                    .asset_symbol
                    .as_deref()
                    .map_or(true, |saved| saved == symbol),
                "configured faucet symbol differs from --symbol"
            );
            verify_durable_faucet(faucet, max_supply).await?;
            let mut faucet_client = client().await?;
            faucet_client.sync_state().await?;
            let tracked = faucet_client
                .get_account_header(faucet)
                .await?
                .is_some_and(|(_, status)| matches!(status, AccountStatus::Tracked));
            if tracked {
                println!("faucet_deployment=already_committed");
            } else {
                let (tx, note) = deploy_durable_faucet(faucet, owner).await?;
                config
                    .public_ids
                    .insert("faucet_deployment_transaction".into(), tx);
                config
                    .public_ids
                    .insert("faucet_bootstrap_note".into(), note);
                config.save(&config_path)?;
            }
        }
        "deploy-vault" => {
            let owner = configured_id(&config.owner, "owner")?;
            let beneficiary = configured_id(&config.beneficiary, "beneficiary")?;
            let faucet = configured_id(&config.inherited_faucet, "inherited faucet")?;
            let timeout: u32 = values
                .get("timeout")
                .map(|s| s.parse())
                .transpose()?
                .or(config.timeout_blocks)
                .context("--timeout or configured timeout is required")?;
            ensure_positive_timeout(timeout)?;
            ensure!(config.timeout_blocks.map_or(true, |saved| saved == timeout), "requested timeout differs from durable config; use configure to update it before deployment");
            config.timeout_blocks = Some(timeout);
            config.poll_seconds = policy.poll_seconds;
            config.timeout_seconds = policy.timeout_seconds;
            ensure!(
                config.vault.is_none(),
                "a vault is already configured; deploy-vault will not replace it"
            );
            let keys = FilesystemKeyStore::new(state_dir().join(".miden/keystore"))?;
            for (label, account) in [("owner", owner), ("beneficiary", beneficiary)] {
                ensure!(
                    !keys.get_keys_for_account(&account).await?.is_empty(),
                    "{label} signer is missing from the durable keystore"
                );
            }
            let mut client = client().await?;
            client.sync_state().await?;
            let inherited_faucet = client.get_account(faucet).await?.context(
                "configured inherited faucet is not tracked; create or configure it first",
            )?;
            ensure!(
                inherited_faucet.is_public() && FungibleFaucet::try_from(&inherited_faucet).is_ok(),
                "configured inherited account is not a public fungible faucet"
            );
            println!("preflight=deploy-vault owner={owner} beneficiary={beneficiary} faucet={faucet} timeout_blocks={timeout}");
            ensure!(
                yes,
                "no vault deployed; review preflight and rerun with --yes"
            );
            let vault = if let Some(pending) = config.public_ids.get("pending_vault") {
                parse_id(pending)?
            } else {
                let id = create_vault(
                    owner,
                    beneficiary,
                    faucet,
                    timeout,
                    &config_path,
                    &mut config,
                )
                .await?;
                config
                    .public_ids
                    .insert("pending_vault".into(), id.to_string());
                config.save(&config_path)?;
                id
            };
            let finalized = config.public_ids.contains_key("pending_vault")
                && verify_vault(vault, owner, beneficiary, faucet, timeout)
                    .await
                    .is_ok();
            if !finalized {
                let (config_note, sponsorship_note, owner_tx, ntx_tx) =
                    remove_bootstrap_p2id(vault, owner, beneficiary, faucet, timeout, policy)
                        .await?;
                config
                    .public_ids
                    .insert("bootstrap_cleanup_config_note".into(), config_note);
                config.public_ids.insert(
                    "bootstrap_cleanup_sponsorship_note".into(),
                    sponsorship_note,
                );
                config
                    .public_ids
                    .insert("bootstrap_cleanup_funding_transaction".into(), owner_tx);
                config
                    .public_ids
                    .insert("bootstrap_cleanup_network_transaction".into(), ntx_tx);
                verify_vault(vault, owner, beneficiary, faucet, timeout).await?;
            }
            config.vault = Some(vault.to_string());
            config.public_ids.remove("pending_vault");
            config
                .public_ids
                .insert("vault_account".into(), vault.to_string());
            config.save(&config_path)?;
        }
        "mint" => {
            let faucet = configured_id(&config.inherited_faucet, "inherited faucet")?;
            let owner = configured_id(&config.owner, "owner")?;
            let recipient = values
                .get("recipient")
                .map(|s| parse_id(s))
                .transpose()?
                .unwrap_or(owner);
            let amount: u64 = values
                .get("amount")
                .context("mint requires --amount")?
                .parse()?;
            ensure!(amount > 0, "--amount must be positive");
            println!("preflight=mint faucet={faucet} recipient={recipient} amount={amount}");
            ensure!(
                yes,
                "no mint submitted; review preflight and rerun with --yes"
            );
            let (_, note) = fund_account_native(owner, faucet, 151).await?;
            let (tx, mint_note, consume_tx) =
                mint_faucet_asset(faucet, recipient, amount, &note).await?;
            config.public_ids.insert("mint_transaction".into(), tx);
            config.public_ids.insert("mint_note".into(), mint_note);
            config
                .public_ids
                .insert("mint_consumption_transaction".into(), consume_tx);
            config.save(&config_path)?;
        }
        "deposit" | "heartbeat" | "claim" => {
            config.poll_seconds = policy.poll_seconds;
            config.timeout_seconds = policy.timeout_seconds;
            let amount = if command == "deposit" {
                values
                    .get("amount")
                    .context("deposit requires --amount")?
                    .parse()?
            } else {
                0
            };
            submit_feature_command(
                command,
                &config_path,
                &mut config,
                amount,
                dry_run,
                yes,
                policy,
                json,
            )
            .await?;
        }
        "consume" => {
            let beneficiary = configured_id(&config.beneficiary, "beneficiary")?;
            let vault = configured_id(&config.vault, "vault")?;
            let faucet = configured_id(&config.inherited_faucet, "inherited faucet")?;
            let keys = FilesystemKeyStore::new(state_dir().join(".miden/keystore"))?;
            ensure!(
                !keys.get_keys_for_account(&beneficiary).await?.is_empty(),
                "configured beneficiary signer is missing from the durable keystore"
            );
            let note_text = values
                .get("note")
                .or(config.payout_note_id.as_ref())
                .context("consume requires --note or a configured payout note")?;
            let note_id = miden_protocol::note::NoteId::try_from_hex(note_text)?;
            inspect_public_payout(note_id, vault, beneficiary, faucet).await?;
            println!(
                "preflight=consume beneficiary={beneficiary} vault={vault} payout_note={note_id}"
            );
            ensure!(
                yes,
                "payout not consumed; review preflight and rerun with --yes"
            );
            let tx = consume_public_payout(beneficiary, vault, faucet, note_id).await?;
            config
                .public_ids
                .insert("payout_consumption_transaction".into(), tx);
            config.save(&config_path)?;
        }
        "fund-fees" => {
            let sender = values
                .get("sender")
                .map(|s| parse_id(s))
                .transpose()?
                .unwrap_or(configured_id(&config.owner, "owner")?);
            let target = parse_id(
                values
                    .get("target")
                    .context("fund-fees requires --target")?,
            )?;
            let amount = values
                .get("amount")
                .context("fund-fees requires --amount")?
                .parse()?;
            ensure!(amount > 0, "--amount must be positive");
            println!("preflight=fund-fees sender={sender} target={target} amount={amount}");
            ensure!(yes, "no fee-funding note created; rerun with --yes");
            let (tx, note) = fund_account_native(sender, target, amount).await?;
            config
                .public_ids
                .insert("native_fee_funding_transaction".into(), tx);
            config
                .public_ids
                .insert("native_fee_funding_note".into(), note);
            config.save(&config_path)?;
        }
        _ => bail!("unknown command {command:?}; run with --help"),
    }
    Ok(())
}

fn print_cli_help() {
    println!("Heirbeat testnet lifecycle CLI (Miden v0.16)\n\nCommands:\n  configure [--owner ID] [--beneficiary ID] [--faucet ID] [--vault ID] [--timeout BLOCKS]\n  status [--json]\n  create-faucet [--symbol HBTEST] [--name NAME] [--decimals N] [--max-supply N] --yes\n  deploy-vault [--timeout BLOCKS] --yes\n  mint --amount N [--recipient ID] --yes\n  deposit --amount N [--dry-run | --yes]\n  heartbeat [--dry-run | --yes]\n  claim [--dry-run | --yes]\n  consume [--note NOTE_ID] --yes\n  fund-fees --target ACCOUNT_ID --amount N [--sender ACCOUNT_ID] --yes\n  verify [--json]\n\nGlobal options: --config PATH --poll-seconds N --timeout-seconds N --force\nDefault state: .local/testnet-v016/heirbeat.json; secrets remain in .local/testnet-v016/.miden/keystore");
}

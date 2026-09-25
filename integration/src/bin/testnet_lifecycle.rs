use std::time::{Duration, SystemTime, UNIX_EPOCH};
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
    keystore::{FilesystemKeyStore, Keystore},
    rpc::{Endpoint, GrpcClient, NodeRpcClient, VerifyingRpcClient},
    store::{AccountStatus, NoteFilter, TransactionFilter},
    transaction::TransactionRequestBuilder,
    transaction::TransactionStatus,
};
use miden_client_sqlite_store::SqliteStore;
use miden_mast_package::Package;
use miden_protocol::{
    account::auth::{AuthScheme, AuthSecretKey},
    address::NetworkId,
    asset::TokenSymbol,
    asset::{Asset, AssetAmount, FungibleAsset},
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
        NetworkAccountConfigNote, NetworkAccountTarget, NoteExecutionHint, P2idNote,
        P2idNoteStorage,
    },
    testing::note::NoteBuilder,
    tx_script::{ExpirationTransactionScript, SendFungibleFaucetNotesTransactionScript},
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

async fn durable_preflight() -> Result<()> {
    let mut client = client().await?;
    let sync = client.sync_state().await?;
    let keys = FilesystemKeyStore::new(state_dir().join(".miden/keystore"))?;
    let owner = parse_id("0xa61714a99ec7619109e397cbac32cd")?;
    let beneficiary = parse_id("0x4181277bcf64381105ee61baadb5bc")?;
    for (label, id) in [("owner", owner), ("beneficiary", beneficiary)] {
        let (_, status) = client
            .get_account_header(id)
            .await?
            .with_context(|| format!("{label} is not present in the durable client store"))?;
        ensure!(
            matches!(status, AccountStatus::Tracked),
            "{label} is not tracked: {status}"
        );
        let secret_keys = keys.get_keys_for_account(&id).await?;
        ensure!(
            !secret_keys.is_empty(),
            "{label} signing key is missing from the durable keystore"
        );
        println!("{label}_id={id} account_status={status} durable_signer=true");
    }
    let owner_account = client
        .get_account(owner)
        .await?
        .context("owner account state is missing")?;
    let fee_asset = FungibleAsset::new(parse_id(FEE_FAUCET)?, 1)?.id();
    println!("durable_store={}", client.store_identifier());
    println!("synced_block={}", sync.block_num);
    println!(
        "owner_native_fee_balance={}",
        owner_account.vault().get_balance(fee_asset)?
    );
    let beneficiary_account = client
        .get_account(beneficiary)
        .await?
        .context("beneficiary account state is missing")?;
    println!(
        "beneficiary_native_fee_balance={}",
        beneficiary_account.vault().get_balance(fee_asset)?
    );
    println!(
        "keystore_path={}",
        state_dir().join(".miden/keystore").display()
    );
    Ok(())
}

async fn create_durable_faucet() -> Result<()> {
    let mut client = client().await?;
    let sync = client.sync_state().await?;
    let owner = parse_id("0xa61714a99ec7619109e397cbac32cd")?;
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
    let faucet = FungibleFaucet::builder()
        .name(TokenName::new("Heirbeat Test Asset v2")?)
        // v0.16 TokenSymbol accepts uppercase ASCII letters only, so use HBTESTV for this v2 test token.
        .symbol(TokenSymbol::try_from("HBTESTV")?)
        .decimals(0)
        .max_supply(AssetAmount::from(1_000_000u32))
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
    println!("faucet_name=Heirbeat Test Asset v2");
    println!("faucet_symbol=HBTESTV");
    println!("faucet_decimals=0");
    println!("faucet_max_supply=1000000");
    println!("faucet_mint_policy=allow_all");
    println!("faucet_auth=single_signature_falcon512_poseidon2");
    println!("faucet_local_store_status=New");
    println!("faucet_signer_persisted=true");
    println!("created_after_sync_block={}", sync.block_num);
    println!("next=restart process, run verify-faucet {faucet_id}, then deploy-faucet {faucet_id}");
    Ok(())
}

async fn verify_durable_faucet(faucet_id: AccountId) -> Result<()> {
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
        faucet.max_supply() == AssetAmount::from(1_000_000u32),
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

async fn deploy_durable_faucet(faucet_id: AccountId) -> Result<()> {
    let mut client = client().await?;
    client.sync_state().await?;
    let owner = parse_id("0xa61714a99ec7619109e397cbac32cd")?;
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
    Ok(())
}

async fn mint_faucet_asset(faucet_id: AccountId, amount: u64, fee_note_hex: &str) -> Result<()> {
    let mut client = client().await?;
    client.sync_state().await?;
    let owner = parse_id("0xa61714a99ec7619109e397cbac32cd")?;
    let keys = FilesystemKeyStore::new(state_dir().join(".miden/keystore"))?;
    ensure!(
        !keys.get_keys_for_account(&faucet_id).await?.is_empty(),
        "faucet signing key is unavailable"
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
        .target(owner)
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
        .get_account(owner)
        .await?
        .context("owner account is not tracked")?
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
            owner,
            TransactionRequestBuilder::new()
                .input_notes([(minted_note, None)])
                .expected_ntx_scripts(vec![P2idNote::script()])
                .build()?,
        )
        .await?;
    client.sync_state().await?;
    let consume_block = committed_block(&mut client, consume_tx).await?;
    let owner_after = client
        .get_account(owner)
        .await?
        .context("owner state disappeared after probe note consumption")?
        .vault()
        .get_balance(asset.id())?;
    let faucet_after = client
        .get_account(faucet_id)
        .await?
        .context("faucet state disappeared after mint")?;
    let faucet_after = FungibleFaucet::try_from(&faucet_after)?;
    ensure!(
        owner_after.as_u64() == owner_before.as_u64() + amount,
        "owner balance did not increase by exactly {amount}: {owner_before} -> {owner_after}"
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
        consumed_record.consumer_account() == Some(owner),
        "mint note was not consumed by the owner"
    );
    println!("faucet_id={faucet_id}");
    println!("faucet_fee_funding_note_id={fee_funding_id}");
    println!("faucet_native_fee_before_probe={fee_balance_before}");
    println!("faucet_native_fee_topup=151");
    println!("mint_transaction={mint_tx}");
    println!("mint_committed_block={mint_block}");
    println!("mint_note_id={}", note.id());
    println!("mint_amount={amount}");
    println!("mint_recipient={owner}");
    println!("mint_consumption_transaction={consume_tx}");
    println!("mint_consumption_block={consume_block}");
    println!("owner_balance_before={owner_before}");
    println!("owner_balance_after={owner_after}");
    println!("faucet_supply_after={}", faucet_after.token_supply());
    Ok(())
}

async fn consume_mint_probe(
    faucet_id: AccountId,
    note_hex: &str,
    fee_note_hex: &str,
) -> Result<()> {
    let mut client = client().await?;
    client.sync_state().await?;
    let owner = parse_id("0xa61714a99ec7619109e397cbac32cd")?;
    let note_id = miden_protocol::note::NoteId::try_from_hex(note_hex)?;
    let fee_note_id = miden_protocol::note::NoteId::try_from_hex(fee_note_hex)?;
    let faucet_asset = FungibleAsset::new(faucet_id, 1)?;
    let owner_before = client
        .get_account(owner)
        .await?
        .context("owner account is not tracked")?
        .vault()
        .get_balance(faucet_asset.id())?;
    let note_record = tracked_note_for_consumption(&client, note_id).await?;
    let fee_note_record = tracked_note_for_consumption(&client, fee_note_id).await?;
    let txid = client
        .submit_new_transaction(
            owner,
            TransactionRequestBuilder::new()
                .input_notes([(note_record, None), (fee_note_record, None)])
                .expected_ntx_scripts(vec![P2idNote::script()])
                .build()?,
        )
        .await?;
    client.sync_state().await?;
    let mut records = client
        .get_transactions(TransactionFilter::Ids(vec![txid]))
        .await?;
    let record = records
        .pop()
        .context("probe-note consumption transaction is not tracked")?;
    let committed = match record.status {
        TransactionStatus::Committed { block_number, .. } => block_number,
        status => {
            println!("probe_note_consumption_transaction={txid}");
            println!("probe_note_consumption_status={status}");
            return Ok(());
        }
    };
    let owner_after = client
        .get_account(owner)
        .await?
        .context("owner account disappeared")?
        .vault()
        .get_balance(faucet_asset.id())?;
    let faucet_account = client
        .get_account(faucet_id)
        .await?
        .context("faucet account disappeared")?;
    let faucet = FungibleFaucet::try_from(&faucet_account)?;
    let consumed = client
        .get_input_note(note_id)
        .await?
        .context("consumed probe note is missing")?;
    ensure!(
        consumed.consumer_account() == Some(owner),
        "probe note was not consumed by the owner"
    );
    ensure!(
        owner_after.as_u64() == owner_before.as_u64() + 10,
        "owner did not receive exactly ten units: {owner_before} -> {owner_after}"
    );
    ensure!(
        faucet.token_supply() == AssetAmount::from(10u32),
        "faucet supply is not ten after probe mint"
    );
    println!("faucet_id={faucet_id}");
    println!("probe_note_id={note_id}");
    println!("probe_note_consumption_transaction={txid}");
    println!("probe_note_consumption_block={committed}");
    println!("probe_note_amount=10");
    println!("owner_probe_balance_before={owner_before}");
    println!("owner_probe_balance_after={owner_after}");
    println!("faucet_supply_after={}", faucet.token_supply());
    println!("probe_note_consumed_by={owner}");
    Ok(())
}

async fn verify_mint_probe(faucet_id: AccountId, note_hex: &str) -> Result<()> {
    let mut client = client().await?;
    let sync = client.sync_state().await?;
    let owner = parse_id("0xa61714a99ec7619109e397cbac32cd")?;
    let note_id = miden_protocol::note::NoteId::try_from_hex(note_hex)?;
    let faucet_asset = FungibleAsset::new(faucet_id, 1)?;
    let owner_account = client
        .get_account(owner)
        .await?
        .context("owner account is not tracked")?;
    let owner_balance = owner_account.vault().get_balance(faucet_asset.id())?;
    let faucet_account = client
        .get_account(faucet_id)
        .await?
        .context("faucet account is not tracked")?;
    let faucet = FungibleFaucet::try_from(&faucet_account)?;
    let note = client
        .get_input_note(note_id)
        .await?
        .context("probe note is not tracked by the owner")?;
    ensure!(
        note.consumer_account() == Some(owner),
        "probe note has not been consumed by the owner"
    );
    ensure!(
        owner_balance >= AssetAmount::from(10u32),
        "owner has not received ten probe units"
    );
    ensure!(
        faucet.token_supply() == AssetAmount::from(10u32),
        "faucet supply is not exactly ten"
    );
    println!("faucet_id={faucet_id}");
    println!("probe_note_id={note_id}");
    println!("probe_note_consumed_by={owner}");
    println!("owner_probe_balance={owner_balance}");
    println!("faucet_supply={}", faucet.token_supply());
    println!(
        "faucet_native_fee_balance={}",
        faucet_account
            .vault()
            .get_balance(FungibleAsset::new(parse_id(FEE_FAUCET)?, 1)?.id())?
    );
    println!(
        "owner_native_fee_balance={}",
        owner_account
            .vault()
            .get_balance(FungibleAsset::new(parse_id(FEE_FAUCET)?, 1)?.id())?
    );
    println!("synced_block={}", sync.block_num);
    Ok(())
}

async fn fund_account_native_fees(target: AccountId, amount: u64) -> Result<()> {
    let mut client = client().await?;
    let synced = client.sync_state().await?;
    let beneficiary = parse_id("0x4181277bcf64381105ee61baadb5bc")?;
    let fee_faucet = parse_id(FEE_FAUCET)?;
    let keys = FilesystemKeyStore::new(state_dir().join(".miden/keystore"))?;
    ensure!(
        !keys.get_keys_for_account(&beneficiary).await?.is_empty(),
        "beneficiary signer is missing from the durable keystore"
    );
    let mut serial_rng = rng();
    let note: Note = P2idNote::builder()
        .sender(beneficiary)
        .target(target)
        .asset(FungibleAsset::new(fee_faucet, amount)?)
        .note_type(NoteType::Public)
        .generate_serial_number(&mut serial_rng)
        .build()?
        .into();
    let txid = client
        .submit_new_transaction(
            beneficiary,
            TransactionRequestBuilder::new()
                .own_output_notes([note.clone()])
                .expected_ntx_scripts(vec![P2idNote::script()])
                .build()?,
        )
        .await?;
    let _ = client.sync_state().await?;
    println!("native_fee_funding_sender={beneficiary}");
    println!("native_fee_funding_target={target}");
    println!("native_fee_funding_amount={amount}");
    println!("native_fee_funding_transaction={txid}");
    println!("native_fee_funding_note_id={}", note.id());
    println!("previous_sync_block={}", synced.block_num);
    Ok(())
}

async fn consume_native_fee_note(target: AccountId, note_hex: &str) -> Result<()> {
    let mut client = client().await?;
    client.sync_state().await?;
    let note_id = miden_protocol::note::NoteId::try_from_hex(note_hex)?;
    let fee_faucet = parse_id(FEE_FAUCET)?;
    let note = tracked_note_for_consumption(&client, note_id).await?;
    let txid = client
        .submit_new_transaction(
            target,
            TransactionRequestBuilder::new()
                .input_notes([(note, None)])
                .expected_ntx_scripts(vec![P2idNote::script()])
                .build()?,
        )
        .await?;
    let committed = committed_block(&mut client, txid).await?;
    let account = client
        .get_account(target)
        .await?
        .context("target account disappeared after native fee note consumption")?;
    let native_balance = account
        .vault()
        .get_balance(FungibleAsset::new(fee_faucet, 1)?.id())?;
    let consumed = client
        .get_input_note(note_id)
        .await?
        .context("native fee note record disappeared")?;
    ensure!(
        consumed.consumer_account() == Some(target),
        "native fee note was not consumed by its target"
    );
    println!("native_fee_note_id={note_id}");
    println!("native_fee_consumption_transaction={txid}");
    println!("native_fee_consumption_block={committed}");
    println!("native_fee_target={target}");
    println!("native_fee_balance_after={native_balance}");
    Ok(())
}

async fn consume_faucet_bootstrap(
    faucet_id: AccountId,
    p2id_note_hex: &str,
    sponsorship_note_hex: &str,
    fee_note_hex: &str,
) -> Result<()> {
    let mut client = client().await?;
    let sync = client.sync_state().await?;
    let keys = FilesystemKeyStore::new(state_dir().join(".miden/keystore"))?;
    ensure!(
        !keys.get_keys_for_account(&faucet_id).await?.is_empty(),
        "durable faucet signer is unavailable"
    );
    let p2id_id = miden_protocol::note::NoteId::try_from_hex(p2id_note_hex)?;
    let sponsorship_id = miden_protocol::note::NoteId::try_from_hex(sponsorship_note_hex)?;
    let fee_note_id = miden_protocol::note::NoteId::try_from_hex(fee_note_hex)?;
    let (header, account_status) = client
        .get_account_header(faucet_id)
        .await?
        .context("local faucet account is missing")?;
    if matches!(account_status, AccountStatus::Tracked) {
        let account = client
            .get_account(faucet_id)
            .await?
            .context("deployed faucet account is missing")?;
        let faucet = FungibleFaucet::try_from(&account)?;
        println!("faucet_id={faucet_id}");
        println!("faucet_already_deployed=true");
        println!("account_status=Tracked");
        println!("token_supply={}", faucet.token_supply());
        println!("synced_block={}", sync.block_num);
        return Ok(());
    }

    let in_flight = client
        .get_transactions(TransactionFilter::All)
        .await?
        .into_iter()
        .find(|tx| {
            tx.details.account_id == faucet_id && matches!(tx.status, TransactionStatus::Pending)
        });
    let txid = if let Some(pending) = in_flight {
        println!("faucet_deployment_pending_transaction={}", pending.id);
        pending.id
    } else {
        let p2id_note = tracked_note_for_consumption(&client, p2id_id).await?;
        let fee_note = tracked_note_for_consumption(&client, fee_note_id).await?;
        let txid = client
            .submit_new_transaction(
                faucet_id,
                TransactionRequestBuilder::new()
                    .input_notes([(p2id_note, None), (fee_note, None)])
                    .expected_ntx_scripts(vec![P2idNote::script()])
                    .build()?,
            )
            .await?;
        println!("faucet_deployment_transaction={txid}");
        txid
    };

    let sync = client.sync_state().await?;
    let mut records = client
        .get_transactions(TransactionFilter::Ids(vec![txid]))
        .await?;
    let transaction = records
        .pop()
        .with_context(|| format!("faucet deployment transaction {txid} is not tracked"))?;
    match transaction.status {
        TransactionStatus::Committed { block_number, .. } => {
            let (_, status) = client
                .get_account_header(faucet_id)
                .await?
                .context("committed faucet is missing from store")?;
            ensure!(
                matches!(status, AccountStatus::Tracked),
                "faucet deployment committed but account status is {status}"
            );
            let account = client
                .get_account(faucet_id)
                .await?
                .context("committed faucet state is missing")?;
            let faucet = FungibleFaucet::try_from(&account)?;
            ensure!(account.is_public(), "deployed faucet is not public");
            ensure!(
                faucet.token_supply() == AssetAmount::ZERO,
                "faucet supply is not initially zero"
            );
            ensure!(
                faucet.max_supply() == AssetAmount::from(1_000_000u32),
                "faucet maximum supply changed"
            );
            ensure!(
                !keys.get_keys_for_account(&faucet_id).await?.is_empty(),
                "faucet signer disappeared after deployment"
            );
            println!("faucet_id={faucet_id}");
            println!("deployment_transaction={txid}");
            println!("unused_fee_sponsorship_note={sponsorship_id}");
            println!("unused_fee_sponsorship_reason=single-signature faucet does not run AuthNetworkAccount::collect_sponsored_fees; direct native P2ID is required");
            println!("deployment_block={block_number}");
            println!("deployment_sync_block={}", sync.block_num);
            println!("account_status=Tracked");
            println!("public=true");
            println!("token_name={:?}", faucet.token_name());
            println!("token_symbol={}", faucet.symbol());
            println!("decimals={}", faucet.decimals());
            println!("supply={}", faucet.token_supply());
            println!("max_supply={}", faucet.max_supply());
            println!("durable_signer_available=true");
        }
        TransactionStatus::Pending => {
            println!("faucet_deployment_transaction={txid}");
            println!("faucet_deployment_status=Pending");
            println!("synced_block={}", sync.block_num);
            println!("rerun the same bootstrap-note command after more blocks; it will not resubmit a pending transaction");
        }
        status => bail!("faucet deployment transaction {txid} was discarded: {status}"),
    }
    let _ = header;
    Ok(())
}

async fn fund_account_native(sender: AccountId, target: AccountId, amount: u64) -> Result<()> {
    let mut client = client().await?;
    let sync = client.sync_state().await?;
    let fee_faucet = parse_id(FEE_FAUCET)?;
    let keys = FilesystemKeyStore::new(state_dir().join(".miden/keystore"))?;
    ensure!(
        !keys.get_keys_for_account(&sender).await?.is_empty(),
        "native fee funding sender key is missing from the durable keystore"
    );
    let asset = FungibleAsset::new(fee_faucet, amount)?;
    let mut note_rng = rng();
    let note: Note = P2idNote::builder()
        .sender(sender)
        .target(target)
        .asset(asset)
        .note_type(NoteType::Public)
        .generate_serial_number(&mut note_rng)
        .build()?
        .into();
    let txid = client
        .submit_new_transaction(
            sender,
            TransactionRequestBuilder::new()
                .own_output_notes([note.clone()])
                .expected_ntx_scripts(vec![P2idNote::script()])
                .build()?,
        )
        .await?;
    println!("native_fee_funding_transaction={txid}");
    println!("native_fee_funding_note_id={}", note.id());
    println!("native_fee_funding_sender={sender}");
    println!("native_fee_funding_target={target}");
    println!("faucet_fee_funding_amount={amount}");
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
    Ok(())
}

async fn audit_asset(faucet_id: AccountId) -> Result<()> {
    let mut client = client().await?;
    let sync = client.sync_state().await?;
    println!("synced_block={}", sync.block_num);
    audit_asset_records(&client, faucet_id).await
}

async fn audit_asset_db(faucet_id: AccountId, db_path: PathBuf) -> Result<()> {
    let client = client_from_paths(db_path, state_dir().join(".miden/keystore")).await?;
    println!("store_mode=local_snapshot_no_sync");
    audit_asset_records(&client, faucet_id).await
}

async fn audit_asset_records(
    client: &miden_client::Client<FilesystemKeyStore>,
    faucet_id: AccountId,
) -> Result<()> {
    let asset_id = FungibleAsset::new(faucet_id, 1)?.id();
    let account_headers = client.get_account_headers().await?;
    println!("tracked_account_count={}", account_headers.len());
    for (header, status) in account_headers {
        let Some(account) = client.get_account(header.id()).await? else {
            continue;
        };
        let balance = account.vault().get_balance(asset_id)?;
        println!(
            "account_asset_balance account={} status={} amount={}",
            header.id(),
            status,
            balance
        );
    }

    let input_notes = client.get_input_notes(NoteFilter::All).await?;
    let mut matching_inputs = 0;
    for note in input_notes {
        let matching = note
            .assets()
            .iter_fungible()
            .any(|asset| asset.faucet_id() == faucet_id);
        if matching {
            matching_inputs += 1;
            println!(
                "input_note id={:?} amount_assets={:?} sender={:?} recipient_digest={} state={:?} created_at={:?} consumer={:?}",
                note.id(),
                note.assets(),
                note.metadata().map(|metadata| metadata.sender()),
                note.recipient(),
                note.state(),
                note.created_at(),
                note.consumer_account()
            );
        }
    }
    println!("matching_input_note_count={matching_inputs}");

    let output_notes = client.get_output_notes(NoteFilter::All).await?;
    let mut matching_outputs = 0;
    for note in output_notes {
        let matching = note
            .assets()
            .iter_fungible()
            .any(|asset| asset.faucet_id() == faucet_id);
        if matching {
            matching_outputs += 1;
            println!(
                "output_note id={} amount_assets={:?} sender={} recipient_digest={} script_root={:?} state={:?} expected_height={}",
                note.id(),
                note.assets(),
                note.metadata().sender(),
                note.recipient_digest(),
                note.script_root(),
                note.state(),
                note.expected_height()
            );
        }
    }
    println!("matching_output_note_count={matching_outputs}");

    let transactions = client.get_transactions(TransactionFilter::All).await?;
    let mut matching_transactions = 0;
    for tx in transactions {
        let matching_outputs = tx.details.output_notes.iter().filter(|note| {
            note.assets()
                .iter_fungible()
                .any(|asset| asset.faucet_id() == faucet_id)
        });
        for note in matching_outputs {
            matching_transactions += 1;
            println!(
                "asset_transaction id={} account={} reference_block={} status={:?} output_note={} assets={:?}",
                tx.id,
                tx.details.account_id,
                tx.details.block_num,
                tx.status,
                note.id(),
                note.assets()
            );
        }
    }
    println!("matching_transaction_output_count={matching_transactions}");
    Ok(())
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

async fn inspect_inherited_faucet(faucet_id: AccountId) -> Result<()> {
    let endpoint = Endpoint::testnet();
    let rpc = VerifyingRpcClient::new(GrpcClient::new(&endpoint, 10_000));
    let (header, _) = rpc.get_block_header_by_number(None, false).await?;
    let account = rpc
        .get_account_details(faucet_id)
        .await?
        .context("configured inherited faucet has no public on-chain account state")?;
    let faucet = FungibleFaucet::try_from(&account)
        .context("configured account does not expose the stable fungible faucet component")?;
    let policy_root = account
        .storage()
        .get_item(TokenPolicyManager::active_mint_policy_slot())?;
    let has_mint_signing_key = FilesystemKeyStore::new(state_dir().join(".miden/keystore"))?
        .get_keys_for_account(&faucet_id)
        .await
        .map(|keys| !keys.is_empty())
        .unwrap_or(false);
    let network_style = NetworkAccount::new(account.clone()).is_ok();
    let singlesig_auth_slot_present = account
        .storage()
        .get(AuthSingleSig::public_key_slot())
        .is_some();
    println!("sync_block={}", header.block_num());
    println!("faucet_id={}", account.id());
    println!("faucet_is_public={}", account.is_public());
    println!("faucet_is_network_account={network_style}");
    println!("single_signature_auth_slot_present={singlesig_auth_slot_present}");
    println!("fungible_faucet_component=present");
    println!("token_name={:?}", faucet.token_name());
    println!("token_symbol={}", faucet.symbol());
    println!("decimals={}", faucet.decimals());
    println!("token_supply={}", faucet.token_supply());
    println!("max_supply={}", faucet.max_supply());
    println!("active_mint_policy_root={policy_root:?}");
    println!(
        "mint_policy_allow_all={}",
        policy_root == MintPolicy::allow_all().root().as_word()
    );
    println!(
        "mint_policy_owner_only={}",
        policy_root == MintPolicy::owner_only().root().as_word()
    );
    println!("durable_signing_key_available={has_mint_signing_key}");

    let history = rpc
        .sync_transactions(BlockNumber::GENESIS, header.block_num(), vec![faucet_id])
        .await?;
    println!("faucet_transaction_count={}", history.len());
    for transaction in history {
        println!(
            "faucet_transaction id={} block={} output_count={}",
            transaction.transaction_header.id(),
            transaction.block_num,
            transaction.transaction_header.output_notes().len()
        );
        for output in transaction.transaction_header.output_notes() {
            let id = output.id();
            for fetched in rpc.get_notes_by_id(&[id]).await? {
                match fetched {
                    miden_client::rpc::domain::note::FetchedNote::Public(note, proof) => {
                        let assets = note.assets().iter_fungible().collect::<Vec<_>>();
                        let amount = assets
                            .iter()
                            .filter(|asset| asset.faucet_id() == faucet_id)
                            .map(|asset| asset.amount().as_u64())
                            .sum::<u64>();
                        if amount > 0 {
                            let nullifier = note.nullifier();
                            let matching_nullifiers = rpc
                                .sync_nullifiers(
                                    &[nullifier.prefix()],
                                    BlockNumber::GENESIS,
                                    header.block_num(),
                                )
                                .await?;
                            let consumed_at = matching_nullifiers
                                .iter()
                                .find(|update| update.nullifier == nullifier)
                                .map(|update| update.block_num);
                            let status = rpc
                                .get_network_note_status(id)
                                .await
                                .map(|status| status.status.to_string())
                                .unwrap_or_else(|error| format!("unavailable: {error}"));
                            let recipient_account =
                                if note.recipient().script().root() == P2idNote::script_root() {
                                    P2idNoteStorage::try_from(note.recipient().storage().items())
                                        .map(|storage| storage.target())
                                        .context("invalid P2ID note storage")?
                                } else {
                                    bail!("100-unit faucet output is not a P2ID note")
                                };
                            println!(
                                "faucet_asset_note id={} mint_transaction={} amount={} sender={} recipient_account={} recipient_digest={} script_root={} note_type={:?} committed_block={} nullifier_consumed_at={:?} network_status={}",
                                id,
                                transaction.transaction_header.id(),
                                amount,
                                note.metadata().sender(),
                                recipient_account,
                                note.recipient().digest(),
                                note.recipient().script().root(),
                                note.metadata().note_type(),
                                proof.location().block_num(),
                                consumed_at,
                                status
                            );

                            let recipient_details =
                                rpc.get_account_details(recipient_account).await?;
                            let current_store_has_recipient_key =
                                FilesystemKeyStore::new(state_dir().join(".miden/keystore"))?
                                    .get_keys_for_account(&recipient_account)
                                    .await
                                    .map(|keys| !keys.is_empty())
                                    .unwrap_or(false);
                            let old_store_has_recipient_key = FilesystemKeyStore::new(
                                PathBuf::from("/tmp/heirbeat-testnet-v016/.miden/keystore"),
                            )?
                            .get_keys_for_account(&recipient_account)
                            .await
                            .map(|keys| !keys.is_empty())
                            .unwrap_or(false);
                            println!(
                                "mint_recipient_signing_key_current_store={} old_store={}",
                                current_store_has_recipient_key, old_store_has_recipient_key
                            );
                            match recipient_details {
                                Some(details) => {
                                    println!(
                                        "mint_recipient_account id={} public={} current_asset_balance={}",
                                        recipient_account,
                                        details.is_public(),
                                        details.vault().get_balance(FungibleAsset::new(faucet_id, 1)?.id())?
                                    );
                                }
                                None => println!(
                                    "mint_recipient_account id={} exists=false",
                                    recipient_account
                                ),
                            }

                            let recipient_history = rpc
                                .sync_transactions(
                                    BlockNumber::GENESIS,
                                    header.block_num(),
                                    vec![recipient_account],
                                )
                                .await?;
                            let consuming_transactions = recipient_history
                                .iter()
                                .filter(|record| {
                                    record
                                        .trusted_consumed_note_refs()
                                        .any(|(_, note_id)| note_id == id)
                                })
                                .collect::<Vec<_>>();
                            for record in &consuming_transactions {
                                println!(
                                    "mint_note_consumed_by transaction={} account={} block={}",
                                    record.transaction_header.id(),
                                    recipient_account,
                                    record.block_num
                                );
                            }
                            println!(
                                "recipient_transactions={} matching_consumers={}",
                                recipient_history.len(),
                                consuming_transactions.len()
                            );
                        }
                    }
                    miden_client::rpc::domain::note::FetchedNote::Private(
                        id,
                        metadata,
                        _,
                        proof,
                    ) => {
                        println!(
                            "faucet_private_output_note id={} sender={} committed_block={} asset_details=not_public",
                            id,
                            metadata.sender(),
                            proof.location().block_num()
                        );
                    }
                }
            }
        }
    }
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

async fn tracked_note_for_consumption(
    client: &miden_client::Client<FilesystemKeyStore>,
    note_id: miden_protocol::note::NoteId,
) -> Result<Note> {
    if let Some(record) = client.get_input_note(note_id).await? {
        ensure!(
            record.is_committed(),
            "input note {note_id} is not committed"
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
    Ok(record.try_into()?)
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
    let bootstrap_note_block = committed_block(&mut client, bootstrap_note_tx).await?;
    let deploy_request = TransactionRequestBuilder::new()
        .input_notes([(feature_note, None), (sponsorship_note, None)])
        .expected_ntx_scripts(vec![P2idNote::script(), FeeSponsorshipNote::script()])
        .build()?;
    let txid = client.submit_new_transaction(id, deploy_request).await?;
    let deployment_sync = client.sync_state().await?;
    let deployment_block = committed_block(&mut client, txid).await?;
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
    let mut bootstrap_roots = expected_roots.clone();
    bootstrap_roots.insert(p2id);
    ensure!(
        network_account.allowed_notes().allowed_script_roots() == &expected_roots
            || network_account.allowed_notes().allowed_script_roots() == &bootstrap_roots,
        "vault note allowlist differs from exact bootstrap/post-cleanup roots"
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
    println!("public_chain_block={}", chain_header.block_num());
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
    println!(
        "allowlist_stage={}",
        if network_account.allowed_notes().allowed_script_roots() == &expected_roots {
            "hardened"
        } else {
            "bootstrap_pending_cleanup"
        }
    );
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
    let owner_block = committed_block(&mut client, owner_tx).await?;

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
    let config_block = committed_block(&mut client, config_tx).await?;
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

async fn account_history(account_id: AccountId) -> Result<()> {
    let rpc = VerifyingRpcClient::new(GrpcClient::new(&Endpoint::testnet(), 10_000));
    let (header, _) = rpc.get_block_header_by_number(None, false).await?;
    let history = rpc
        .sync_transactions(BlockNumber::GENESIS, header.block_num(), vec![account_id])
        .await?;
    println!("account_id={account_id}");
    println!("synced_block={}", header.block_num());
    println!("transaction_count={}", history.len());
    for record in history {
        println!(
            "transaction_id={} block={} output_count={}",
            record.transaction_header.id(),
            record.block_num,
            record.transaction_header.output_notes().len()
        );
        for output in record.transaction_header.output_notes() {
            let note_id = output.id();
            let details = rpc.get_notes_by_id(&[note_id]).await?;
            for detail in details {
                match detail {
                    miden_client::rpc::domain::note::FetchedNote::Public(note, _) => println!(
                        "output_note_id={note_id} transaction_id={} sender={} script_root={} assets={:?}",
                        record.transaction_header.id(),
                        note.metadata().sender(),
                        note.recipient().script().root(),
                        note.assets()
                    ),
                    _ => println!("output_note_id={note_id} transaction_id={} note_details=not_public", record.transaction_header.id()),
                }
            }
        }
    }
    Ok(())
}

async fn inspect_vault_state(
    vault_id: AccountId,
    owner: AccountId,
    beneficiary: AccountId,
    asset_faucet: AccountId,
) -> Result<()> {
    let mut client = client().await?;
    let sync = client.sync_state().await?;
    let account = client
        .get_account(vault_id)
        .await?
        .context("vault account is missing after sync")?;
    let network_account = NetworkAccount::new(account.clone())?;
    let inherited = account
        .vault()
        .get_balance(FungibleAsset::new(asset_faucet, 1)?.id())?;
    let native_faucet = parse_id(FEE_FAUCET)?;
    let native = account
        .vault()
        .get_balance(FungibleAsset::new(native_faucet, 1)?.id())?;
    let stored_owner = account
        .storage()
        .get_item(&StorageSlotName::new(slot("owner"))?)?;
    let stored_beneficiary = account
        .storage()
        .get_item(&StorageSlotName::new(slot("beneficiary"))?)?;
    ensure!(stored_owner == owner_word(owner), "vault owner differs");
    ensure!(
        stored_beneficiary == owner_word(beneficiary),
        "vault beneficiary differs"
    );
    println!("sync_block={}", sync.block_num);
    println!("vault_id={vault_id}");
    println!("network_account_recognized=true");
    println!("owner={owner}");
    println!("beneficiary={beneficiary}");
    println!(
        "last_check_in={:?}",
        account
            .storage()
            .get_item(&StorageSlotName::new(slot("last_check_in"))?)?
    );
    println!(
        "claimed={:?}",
        account
            .storage()
            .get_item(&StorageSlotName::new(slot("claimed"))?)?
    );
    println!("inherited_faucet={asset_faucet}");
    println!("inherited_balance={inherited}");
    println!("native_fee_faucet={native_faucet}");
    println!("native_fee_balance={native}");
    println!(
        "note_allowlist={:?}",
        network_account.allowed_notes().allowed_script_roots()
    );
    println!(
        "transaction_script_allowlist={:?}",
        network_account.allowed_tx_scripts().allowed_script_roots()
    );
    Ok(())
}

async fn inspect_network_notes(note_ids: &[String]) -> Result<()> {
    let mut client = client().await?;
    let sync = client.sync_state().await?;
    let rpc = VerifyingRpcClient::new(GrpcClient::new(&Endpoint::testnet(), 10_000));
    let (header, _) = rpc.get_block_header_by_number(None, false).await?;
    println!("synced_block={}", sync.block_num);
    println!("public_chain_block={}", header.block_num());

    for note_hex in note_ids {
        let note_id = miden_protocol::note::NoteId::try_from_hex(note_hex)?;
        let input_record = client.get_input_note(note_id).await?;
        let output_record = client.get_output_note(note_id).await?;
        println!("note_id={note_id}");
        println!("local_input_note_tracked={}", input_record.is_some());
        println!("local_output_note_tracked={}", output_record.is_some());
        if let Some(record) = &input_record {
            println!("local_input_note_committed={}", record.is_committed());
            println!("local_input_note_consumer={:?}", record.consumer_account());
        }
        if let Some(record) = &output_record {
            println!("local_output_note_committed={}", record.is_committed());
        }

        let fetched = rpc.get_notes_by_id(&[note_id]).await?;
        if fetched.is_empty() {
            println!("chain_note_found=false");
        }
        for fetched_note in fetched {
            match fetched_note {
                miden_client::rpc::domain::note::FetchedNote::Public(note, proof) => {
                    let nullifier = note.nullifier();
                    let nullifier_updates = rpc
                        .sync_nullifiers(
                            &[nullifier.prefix()],
                            BlockNumber::GENESIS,
                            header.block_num(),
                        )
                        .await?;
                    let consumed_at = nullifier_updates
                        .iter()
                        .find(|update| update.nullifier == nullifier)
                        .map(|update| update.block_num);
                    let network_target = NetworkAccountTarget::try_from(note.attachments()).ok();
                    println!("chain_note_found=true");
                    println!("note_type={:?}", note.metadata().note_type());
                    println!("note_sender={}", note.metadata().sender());
                    println!("note_script_root={}", note.recipient().script().root());
                    println!("note_assets={:?}", note.assets());
                    println!("note_committed_block={}", proof.location().block_num());
                    println!("note_nullifier={nullifier}");
                    println!("note_nullifier_consumed_at={consumed_at:?}");
                    println!("network_account_target_attachment={network_target:?}");
                    if note.recipient().script().root() == FeeSponsorshipNote::script_root() {
                        let storage = FeeSponsorshipNoteStorage::try_from(
                            note.recipient().storage().items(),
                        )?;
                        println!("sponsorship_feature_note_id={}", storage.feature_note_id());
                        println!("sponsorship_reclaimer={}", storage.reclaimer());
                        println!("sponsorship_reclaim_height={:?}", storage.reclaim_height());
                    }
                }
                _ => println!("chain_note_found=true note_visibility=not_public"),
            }
        }

        match rpc.get_network_note_status(note_id).await {
            Ok(status) => {
                println!("network_builder_status={}", status.status);
                println!("network_builder_attempt_count={}", status.attempt_count);
                println!("network_builder_last_error={:?}", status.last_error);
                println!(
                    "network_builder_last_attempt_block={:?}",
                    status.last_attempt_block_num
                );
            }
            Err(error) => println!("network_builder_status_error={error}"),
        }
    }
    Ok(())
}

async fn inspect_network_deposit_construction(
    sender: AccountId,
    vault: AccountId,
    asset_faucet: AccountId,
    amount: u64,
    sponsorship_amount: u64,
) -> Result<()> {
    ensure!(amount > 0, "deposit amount must be positive");
    ensure!(
        vault == parse_id("0x39fcc854fe715ad1446afb9859df04")?,
        "this construction diagnostic is pinned to the current Heirbeat vault"
    );
    let mut client = client().await?;
    client.sync_state().await?;
    let account = client
        .get_account(vault)
        .await?
        .context("Heirbeat vault is not tracked in the durable client store")?;
    let network_account = NetworkAccount::new(account)?;
    let script = NoteScript::from_package(&package("deposit-note")?)?;
    ensure!(
        network_account
            .allowed_notes()
            .allowed_script_roots()
            .contains(&script.root()),
        "deposit-note root is not allowlisted by the vault"
    );

    let target = NetworkAccountTarget::new(vault, NoteExecutionHint::Always)?;
    let mut note_rng = rng();
    let builder = NoteBuilder::new(sender, rng())
        .tag(NoteTag::with_account_target(vault).into())
        .note_type(NoteType::Public)
        .script(script.clone())
        .add_assets([FungibleAsset::new(asset_faucet, amount)?.into()])
        .note_storage([vault.suffix(), vault.prefix().as_felt()])?
        .attachment(target);
    let feature_note: Note = builder.build()?;
    let wrapped = miden_standards::note::AccountTargetNetworkNote::new(feature_note.clone())?;
    ensure!(
        wrapped.target_account_id() == vault,
        "canonical network target attachment does not name the current vault"
    );
    ensure!(
        feature_note.recipient().script().root() == script.root(),
        "constructed feature note does not use deposit-note"
    );

    let sponsorship: Note = FeeSponsorshipNote::builder()
        .sender(sender)
        .target_account(vault)
        .feature_note_id(feature_note.id())
        .asset(FungibleAsset::new(
            parse_id(FEE_FAUCET)?,
            sponsorship_amount,
        )?)
        .generate_serial_number(&mut note_rng)
        .build()?
        .into();
    let sponsorship_storage =
        FeeSponsorshipNoteStorage::try_from(sponsorship.recipient().storage().items())?;
    ensure!(
        sponsorship_storage.feature_note_id() == feature_note.id(),
        "sponsorship note does not bind to the constructed deposit note"
    );

    println!("submitted=false");
    println!("sender={sender}");
    println!("target_account={}", wrapped.target_account_id());
    println!("target_attachment={:?}", wrapped.target());
    println!("routing_tag={:?}", feature_note.metadata().tag());
    println!("deposit_note_id={}", feature_note.id());
    println!("deposit_script_root={}", script.root());
    println!("deposit_root_allowlisted=true");
    println!("deposit_assets={:?}", feature_note.assets());
    println!(
        "deposit_note_type={:?}",
        feature_note.metadata().note_type()
    );
    println!(
        "deposit_recipient_storage={:?}",
        feature_note.recipient().storage()
    );
    println!("sponsorship_note_id={}", sponsorship.id());
    println!(
        "sponsorship_script_root={}",
        sponsorship.recipient().script().root()
    );
    println!("sponsorship_assets={:?}", sponsorship.assets());
    println!(
        "sponsorship_feature_note_id={}",
        sponsorship_storage.feature_note_id()
    );
    println!("sponsorship_reclaimer={}", sponsorship_storage.reclaimer());
    println!(
        "sponsorship_reclaim_height={:?}",
        sponsorship_storage.reclaim_height()
    );
    Ok(())
}

async fn submit_targeted_deposit_funding(
    sender: AccountId,
    vault: AccountId,
    asset_faucet: AccountId,
    amount: u64,
) -> Result<()> {
    const SPONSORSHIP_AMOUNT: u64 = 150;
    ensure!(amount > 0, "deposit amount must be positive");
    let mut client = client().await?;
    let sync = client.sync_state().await?;
    let account = client
        .get_account(vault)
        .await?
        .context("Heirbeat vault is not tracked in the durable client store")?;
    let network_account = NetworkAccount::new(account)?;
    let script = NoteScript::from_package(&package("deposit-note")?)?;
    ensure!(
        network_account
            .allowed_notes()
            .allowed_script_roots()
            .contains(&script.root()),
        "deposit-note root is not allowlisted by the vault"
    );
    let target = NetworkAccountTarget::new(vault, NoteExecutionHint::Always)?;
    let mut serial_rng = rng();
    let feature_note: Note = NoteBuilder::new(sender, rng())
        .tag(NoteTag::with_account_target(vault).into())
        .note_type(NoteType::Public)
        .script(script.clone())
        .add_assets([FungibleAsset::new(asset_faucet, amount)?.into()])
        .note_storage([vault.suffix(), vault.prefix().as_felt()])?
        .attachment(target)
        .build()?;
    let network_note = miden_standards::note::AccountTargetNetworkNote::new(feature_note.clone())?;
    ensure!(
        network_note.target_account_id() == vault,
        "constructed feature note is not targeted at the vault"
    );
    let fee_faucet = parse_id(FEE_FAUCET)?;
    let sponsorship_note: Note = FeeSponsorshipNote::builder()
        .sender(sender)
        .target_account(vault)
        .feature_note_id(feature_note.id())
        .asset(FungibleAsset::new(fee_faucet, SPONSORSHIP_AMOUNT)?)
        .generate_serial_number(&mut serial_rng)
        .build()?
        .into();
    let keys = FilesystemKeyStore::new(state_dir().join(".miden/keystore"))?;
    ensure!(
        !keys.get_keys_for_account(&sender).await?.is_empty(),
        "deposit funding signer is unavailable"
    );
    let txid = client
        .submit_new_transaction(
            sender,
            TransactionRequestBuilder::new()
                .own_output_notes([feature_note.clone(), sponsorship_note.clone()])
                .expected_ntx_scripts(vec![script, FeeSponsorshipNote::script()])
                .build()?,
        )
        .await?;
    let committed = committed_block(&mut client, txid).await?;
    println!("submitted_owner_funding_transaction_only=true");
    println!("starting_sync_block={}", sync.block_num);
    println!("owner_transaction_id={txid}");
    println!("owner_transaction_committed_block={committed}");
    println!("deposit_note_id={}", feature_note.id());
    println!("deposit_note_target={}", network_note.target_account_id());
    println!("deposit_target_attachment={:?}", network_note.target());
    println!(
        "deposit_note_root={}",
        feature_note.recipient().script().root()
    );
    println!("deposit_amount={amount}");
    println!("sponsorship_note_id={}", sponsorship_note.id());
    println!("sponsorship_amount={SPONSORSHIP_AMOUNT}");
    println!("sponsorship_feature_note_id={}", feature_note.id());
    println!("next=inspect-network-notes <deposit-note-id> <sponsorship-note-id>");
    Ok(())
}

async fn submit_targeted_check_in_funding(owner: AccountId, vault_id: AccountId) -> Result<()> {
    const SPONSORSHIP_AMOUNT: u64 = 150;
    let mut client = client().await?;
    let sync = client.sync_state().await?;
    let vault = client
        .get_account(vault_id)
        .await?
        .context("Heirbeat vault is not tracked in the durable store")?;
    let network_account = NetworkAccount::new(vault.clone())?;
    let beneficiary = parse_id("0x4181277bcf64381105ee61baadb5bc")?;
    let asset_faucet = parse_id("0x4020542183b9643120d0192be38793")?;
    ensure!(
        vault
            .storage()
            .get_item(&StorageSlotName::new(slot("owner"))?)?
            == owner_word(owner),
        "configured vault owner does not match heartbeat sender"
    );
    ensure!(
        vault
            .storage()
            .get_item(&StorageSlotName::new(slot("beneficiary"))?)?
            == owner_word(beneficiary),
        "vault beneficiary changed"
    );
    ensure!(
        vault
            .storage()
            .get_item(&StorageSlotName::new(slot("asset_faucet"))?)?
            == owner_word(asset_faucet),
        "vault inherited faucet changed"
    );
    ensure!(
        vault
            .storage()
            .get_item(&StorageSlotName::new(slot("timeout_blocks"))?)?[0]
            == Felt::from(10u32),
        "vault timeout is not 10"
    );
    ensure!(
        vault
            .storage()
            .get_item(&StorageSlotName::new(slot("last_check_in"))?)?
            == Word::default(),
        "vault has already been checked in; refusing to create another heartbeat"
    );
    ensure!(
        vault
            .storage()
            .get_item(&StorageSlotName::new(slot("claimed"))?)?
            == Word::default(),
        "vault is already claimed"
    );
    let inherited_asset_id = FungibleAsset::new(asset_faucet, 1)?.id();
    ensure!(
        vault.vault().get_balance(inherited_asset_id)? == AssetAmount::from(100u32),
        "vault inherited balance is not exactly 100"
    );

    let script = NoteScript::from_package(&package("check-in-note")?)?;
    ensure!(
        network_account
            .allowed_notes()
            .allowed_script_roots()
            .contains(&script.root()),
        "check-in root is not allowlisted"
    );
    let target = NetworkAccountTarget::new(vault_id, NoteExecutionHint::Always)?;
    let mut serial_rng = rng();
    let heartbeat_note: Note = NoteBuilder::new(owner, rng())
        .tag(NoteTag::with_account_target(vault_id).into())
        .note_type(NoteType::Public)
        .script(script.clone())
        .attachment(target)
        .build()?;
    let network_note =
        miden_standards::note::AccountTargetNetworkNote::new(heartbeat_note.clone())?;
    ensure!(
        network_note.target_account_id() == vault_id,
        "heartbeat targets the wrong account"
    );
    ensure!(
        heartbeat_note.assets().is_empty(),
        "check-in note must carry no assets"
    );
    let sponsorship_note: Note = FeeSponsorshipNote::builder()
        .sender(owner)
        .target_account(vault_id)
        .feature_note_id(heartbeat_note.id())
        .asset(FungibleAsset::new(
            parse_id(FEE_FAUCET)?,
            SPONSORSHIP_AMOUNT,
        )?)
        .generate_serial_number(&mut serial_rng)
        .build()?
        .into();
    let sponsorship_storage =
        FeeSponsorshipNoteStorage::try_from(sponsorship_note.recipient().storage().items())?;
    ensure!(
        sponsorship_storage.feature_note_id() == heartbeat_note.id(),
        "sponsorship is not paired to the heartbeat note"
    );
    let keys = FilesystemKeyStore::new(state_dir().join(".miden/keystore"))?;
    ensure!(
        !keys.get_keys_for_account(&owner).await?.is_empty(),
        "owner signer is unavailable"
    );

    let owner_tx = client
        .submit_new_transaction(
            owner,
            TransactionRequestBuilder::new()
                .own_output_notes([heartbeat_note.clone(), sponsorship_note.clone()])
                .expected_ntx_scripts(vec![script, FeeSponsorshipNote::script()])
                .build()?,
        )
        .await?;
    let committed = committed_block(&mut client, owner_tx).await?;
    println!("starting_sync_block={}", sync.block_num);
    println!("owner={owner}");
    println!("vault={vault_id}");
    println!("owner_funding_transaction_id={owner_tx}");
    println!("owner_funding_committed_block={committed}");
    println!("heartbeat_note_id={}", heartbeat_note.id());
    println!(
        "heartbeat_script_root={}",
        heartbeat_note.recipient().script().root()
    );
    println!("heartbeat_target_attachment={:?}", network_note.target());
    println!("heartbeat_note_is_public=true");
    println!("heartbeat_assets_empty=true");
    println!("sponsorship_note_id={}", sponsorship_note.id());
    println!("sponsorship_amount={SPONSORSHIP_AMOUNT}");
    println!(
        "sponsorship_feature_note_id={}",
        sponsorship_storage.feature_note_id()
    );
    println!("network_account_transaction_submitted=false");
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

async fn execute_heirbeat_note(
    kind: &str,
    sender: AccountId,
    vault: AccountId,
    asset_faucet: AccountId,
    amount: u64,
    sponsorship_amount: u64,
) -> Result<()> {
    ensure!(
        sponsorship_amount > 0,
        "sponsorship amount must be positive"
    );
    let script_name = match kind {
        "check-in" => "check-in-note",
        "claim" => "claim-note",
        "deposit" => "deposit-note",
        _ => bail!("stage must be check-in, claim, or deposit"),
    };
    let mut client = client().await?;
    let sync = client.sync_state().await?;
    let rpc = VerifyingRpcClient::new(GrpcClient::new(&Endpoint::testnet(), 10_000));
    let (header, _) = rpc.get_block_header_by_number(None, false).await?;
    let script = NoteScript::from_package(&package(script_name)?)?;
    let mut note_rng = rng();
    let mut builder = NoteBuilder::new(sender, rng())
        .tag(NoteTag::with_account_target(vault).into())
        .script(script.clone());
    if kind == "deposit" {
        ensure!(amount > 0, "deposit amount must be positive");
        let asset: Asset = FungibleAsset::new(asset_faucet, amount)?.into();
        builder = builder
            .add_assets([asset])
            .note_storage([vault.suffix(), vault.prefix().as_felt()])?;
    } else {
        ensure!(amount == 0, "only deposit notes may carry assets");
    }
    let feature_note: Note = builder.build()?;
    let feature_note_id = feature_note.id();
    let fee_faucet = parse_id(FEE_FAUCET)?;
    let sponsorship_note: Note = FeeSponsorshipNote::builder()
        .sender(sender)
        .target_account(vault)
        .feature_note_id(feature_note_id)
        .asset(FungibleAsset::new(fee_faucet, sponsorship_amount)?)
        .generate_serial_number(&mut note_rng)
        .build()?
        .into();
    let sponsorship_note_id = sponsorship_note.id();
    let keys = FilesystemKeyStore::new(state_dir().join(".miden/keystore"))?;
    ensure!(
        !keys.get_keys_for_account(&sender).await?.is_empty(),
        "feature-note sender key is unavailable"
    );
    let fee_balance_before = client
        .get_account(sender)
        .await?
        .context("feature-note sender is not tracked")?
        .vault()
        .get_balance(FungibleAsset::new(fee_faucet, 1)?.id())?;
    let funding_tx = client
        .submit_new_transaction(
            sender,
            TransactionRequestBuilder::new()
                .own_output_notes([feature_note.clone(), sponsorship_note.clone()])
                .expected_ntx_scripts(vec![script.clone(), FeeSponsorshipNote::script()])
                .build()?,
        )
        .await?;
    let funding_block = committed_block(&mut client, funding_tx).await?;
    let mut expected_scripts = vec![script, FeeSponsorshipNote::script()];
    if kind == "claim" {
        expected_scripts.push(P2idNote::script());
    }
    let vault_tx = client
        .submit_new_transaction(
            vault,
            TransactionRequestBuilder::new()
                .input_notes([(feature_note, None), (sponsorship_note, None)])
                .expected_ntx_scripts(expected_scripts)
                .build()?,
        )
        .await?;
    let vault_block = committed_block(&mut client, vault_tx).await?;
    let updated = client
        .get_account(vault)
        .await?
        .context("Heirbeat account missing after feature-note execution")?;
    println!("kind={kind}");
    println!("starting_sync_block={}", sync.block_num);
    println!("current_node_block={}", header.block_num());
    println!(
        "verification_base_fee={}",
        header.fee_parameters().verification_base_fee()
    );
    println!("sender_native_fee_balance_before={fee_balance_before}");
    println!("feature_note_id={feature_note_id}");
    println!("sponsorship_note_id={sponsorship_note_id}");
    println!("feature_funding_transaction_id={funding_tx}");
    println!("feature_funding_committed_block={funding_block}");
    println!("vault_transaction_id={vault_tx}");
    println!("vault_committed_block={vault_block}");
    println!(
        "vault_last_check_in={:?}",
        updated
            .storage()
            .get_item(&StorageSlotName::new(slot("last_check_in"))?)?
    );
    println!(
        "vault_claimed={:?}",
        updated
            .storage()
            .get_item(&StorageSlotName::new(slot("claimed"))?)?
    );
    println!(
        "vault_inherited_balance={}",
        updated
            .vault()
            .get_balance(FungibleAsset::new(asset_faucet, 1)?.id())?
    );
    println!("feature_note_consumed=true");
    println!("sponsorship_note_consumed=true");
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    match args.first().map(String::as_str) {
        Some("decode-account") if args.len() == 2 => {
            let (network, account) = AccountId::from_bech32(&args[1])?;
            println!("account_id={account}");
            println!("network={network:?}");
            Ok(())
        }
        Some("encode-testnet-account") if args.len() == 2 => {
            println!("account_bech32={}", parse_id(&args[1])?.to_bech32(NetworkId::Testnet));
            Ok(())
        }
        Some("preflight") if args.len() == 1 => durable_preflight().await,
        Some("create-faucet") if args.len() == 1 => create_durable_faucet().await,
        Some("verify-faucet") if args.len() == 2 => {
            verify_durable_faucet(parse_id(&args[1])?).await
        },
        Some("deploy-faucet") if args.len() == 2 => {
            deploy_durable_faucet(parse_id(&args[1])?).await
        },
        Some("consume-faucet-bootstrap") if args.len() == 4 => {
            bail!("consume-faucet-bootstrap now requires faucet, P2ID note, sponsorship note, and direct-fee P2ID note")
        },
        Some("consume-faucet-bootstrap") if args.len() == 5 => {
            consume_faucet_bootstrap(parse_id(&args[1])?, &args[2], &args[3], &args[4]).await
        },
        Some("fund-native") if args.len() == 4 => {
            fund_account_native(parse_id(&args[1])?, parse_id(&args[2])?, args[3].parse()?).await
        },
        Some("mint-asset") if args.len() == 4 => {
            mint_faucet_asset(parse_id(&args[1])?, args[2].parse()?, &args[3]).await
        },
        Some("consume-mint-probe") if args.len() == 4 => {
            consume_mint_probe(parse_id(&args[1])?, &args[2], &args[3]).await
        }
        Some("verify-mint-probe") if args.len() == 3 => {
            verify_mint_probe(parse_id(&args[1])?, &args[2]).await
        }
        Some("fund-account-native-fees") if args.len() == 3 => {
            fund_account_native_fees(parse_id(&args[1])?, args[2].parse()?).await
        }
        Some("consume-native-fee-note") if args.len() == 3 => {
            consume_native_fee_note(parse_id(&args[1])?, &args[2]).await
        }
        Some("status") => status().await,
        Some("inspect-faucet") if args.len() == 2 => {
            inspect_inherited_faucet(parse_id(&args[1])?).await
        },
        Some("audit-asset") if args.len() == 2 => audit_asset(parse_id(&args[1])?).await,
        Some("audit-asset-db") if args.len() == 3 => {
            audit_asset_db(parse_id(&args[1])?, PathBuf::from(&args[2])).await
        },
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
        Some("account-history") if args.len() == 2 => {
            account_history(parse_id(&args[1])?).await
        },
        Some("inspect-vault-state") if args.len() == 5 => {
            inspect_vault_state(
                parse_id(&args[1])?,
                parse_id(&args[2])?,
                parse_id(&args[3])?,
                parse_id(&args[4])?,
            )
            .await
        },
        Some("inspect-network-notes") if args.len() == 3 => {
            inspect_network_notes(&args[1..]).await
        }
        Some("inspect-network-deposit") if args.len() == 5 => {
            inspect_network_deposit_construction(
                parse_id(&args[1])?,
                parse_id(&args[2])?,
                parse_id(&args[3])?,
                args[4].parse()?,
                150,
            )
            .await
        }
        Some("submit-targeted-deposit") if args.len() == 5 => {
            submit_targeted_deposit_funding(
                parse_id(&args[1])?,
                parse_id(&args[2])?,
                parse_id(&args[3])?,
                args[4].parse()?,
            )
            .await
        }
        Some("submit-targeted-check-in") if args.len() == 3 => {
            submit_targeted_check_in_funding(parse_id(&args[1])?, parse_id(&args[2])?).await
        }
        Some(stage @ ("check-in" | "claim")) if args.len() == 3 => {
            send_note(stage, parse_id(&args[1])?, parse_id(&args[2])?, None, 0).await
        },
        Some("deposit") if args.len() == 5 => {
            send_note("deposit", parse_id(&args[1])?, parse_id(&args[2])?, Some(parse_id(&args[3])?), args[4].parse()?).await
        },
        Some("execute-deposit") if args.len() == 6 => {
            execute_heirbeat_note("deposit", parse_id(&args[1])?, parse_id(&args[2])?, parse_id(&args[3])?, args[4].parse()?, args[5].parse()?).await
        },
        Some("execute-check-in") if args.len() == 5 => {
            execute_heirbeat_note("check-in", parse_id(&args[1])?, parse_id(&args[2])?, parse_id(&args[3])?, 0, args[4].parse()?).await
        },
        Some("execute-claim") if args.len() == 5 => {
            execute_heirbeat_note("claim", parse_id(&args[1])?, parse_id(&args[2])?, parse_id(&args[3])?, 0, args[4].parse()?).await
        },
        _ => bail!("usage: testnet_lifecycle preflight | create-faucet | verify-faucet <faucet> | deploy-faucet <faucet> | fund-faucet-deployment <faucet> <amount> | consume-faucet-bootstrap <faucet> <p2id-note-id> <sponsorship-note-id> <direct-fee-p2id-note-id> | mint-asset <faucet> <amount> <committed-native-fee-note-id> | status | inspect-faucet <faucet> | audit-asset <faucet> | audit-asset-db <faucet> <db-copy> | create-vault <owner> <beneficiary> <asset-faucet> <timeout> | verify-vault <vault> <owner> <beneficiary> <asset-faucet> | remove-bootstrap-p2id <vault> <owner> <beneficiary> <asset-faucet> | consume-config-notes <vault> <config-note-id> <sponsorship-note-id> | block-transactions <block> <account> | transactions [tx-id ...] | check-in <owner> <vault> | claim <beneficiary> <vault> | deposit <owner> <vault> <asset-faucet> <amount>"),
    }
}

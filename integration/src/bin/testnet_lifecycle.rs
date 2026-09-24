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
    keystore::{FilesystemKeyStore, Keystore},
    rpc::{Endpoint, GrpcClient, NodeRpcClient, VerifyingRpcClient},
    store::{AccountStatus, NoteFilter, TransactionFilter},
    transaction::TransactionRequestBuilder,
    transaction::TransactionStatus,
};
use miden_client_sqlite_store::SqliteStore;
use miden_mast_package::Package;
use miden_protocol::{
    asset::{Asset, AssetAmount, FungibleAsset},
    block::BlockNumber,
    note::{Note, NoteScript, NoteTag, NoteType},
    utils::serde::Deserializable,
    Felt, Word,
};
use miden_standards::{
    account::{
        access::AccessControl,
        auth::{
            AuthNetworkAccount, AuthSingleSig, NetworkAccount, NetworkAccountNoteAllowlist,
            NetworkAccountTxScriptAllowlist,
        },
        faucets::FungibleFaucet,
        fees::{BasicConstantFeePolicy, FeePolicyManager},
        policies::{MintPolicy, TokenPolicyManager},
        wallets::BasicWallet,
    },
    note::{
        FeeSponsorshipNote, NetworkAccountConfig, NetworkAccountConfigNote, P2idNote,
        P2idNoteStorage,
    },
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
        Some(stage @ ("check-in" | "claim")) if args.len() == 3 => {
            send_note(stage, parse_id(&args[1])?, parse_id(&args[2])?, None, 0).await
        },
        Some("deposit") if args.len() == 5 => {
            send_note("deposit", parse_id(&args[1])?, parse_id(&args[2])?, Some(parse_id(&args[3])?), args[4].parse()?).await
        },
        _ => bail!("usage: testnet_lifecycle status | inspect-faucet <faucet> | audit-asset <faucet> | audit-asset-db <faucet> <db-copy> | create-vault <owner> <beneficiary> <asset-faucet> <timeout> | verify-vault <vault> <owner> <beneficiary> <asset-faucet> | remove-bootstrap-p2id <vault> <owner> <beneficiary> <asset-faucet> | consume-config-notes <vault> <config-note-id> <sponsorship-note-id> | block-transactions <block> <account> | transactions [tx-id ...] | check-in <owner> <vault> | claim <beneficiary> <vault> | deposit <owner> <vault> <asset-faucet> <amount>"),
    }
}

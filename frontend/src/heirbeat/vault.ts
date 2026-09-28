import { AccountId, BasicFungibleFaucetComponent, Endpoint, RpcClient, wordToBigInt } from "@miden-sdk/miden-sdk";
import type { MidenClient } from "@miden-sdk/miden-sdk";
import { parseVaultAccountId, VaultReadError, type VaultReadDiagnostic } from "../domain/open-vault";
import type { VaultSnapshot } from "../domain/types";

const SLOT_PREFIX = "heirbeat_vault::heirbeat_vault::";
const NETWORK_NOTE_SLOT = "miden::standards::auth::network_account::allowed_note_scripts";
const NETWORK_TX_SLOT = "miden::standards::auth::network_account::allowed_tx_scripts";

type ImportedAccount = NonNullable<Awaited<ReturnType<MidenClient["accounts"]["getOrImport"]>>>;
type AccountStorageView = ReturnType<ImportedAccount["storage"]>;

function storedAccountId(storage: AccountStorageView, name: string): string {
  const word = storage.getItem(`${SLOT_PREFIX}${name}`);
  if (!word) throw new Error(`Vault storage is missing ${name}.`);
  const values = word.toFelts();
  const id = AccountId.fromPrefixSuffix(values[3], values[2]);
  try { return id.toString(); } finally { id.free(); }
}

function roots(storage: AccountStorageView, slot: string): string[] {
  return (storage.getMapEntries(slot) ?? [])
    .map((entry) => ({
      key: entry.key,
      value: entry.value,
    }))
    .filter((entry) => !/^0x0+$/i.test(entry.value))
    .map((entry) => entry.key.toLowerCase())
    .sort();
}

function storedValue(item: NonNullable<ReturnType<AccountStorageView["getItem"]>>): bigint {
  // The browser JS wrapper returns StorageResult, while the underlying WASM
  // AccountStorage type (used by the Node declarations) returns a Word.
  const wrapped = item as unknown as { toBigInt?: () => bigint; word?: Parameters<typeof wordToBigInt>[0] };
  if (wrapped.toBigInt) return wrapped.toBigInt();
  return wordToBigInt(wrapped.word ?? item as Parameters<typeof wordToBigInt>[0]);
}

export async function readVault(client: MidenClient, accountId: string, currentReferenceBlock: number, nativeFeeFaucet: string): Promise<VaultSnapshot> {
  const id = AccountId.fromHex(accountId);
  // This snapshot reads public state only. `getDetails()` also fetches public
  // key commitments; that lookup fails for the imported test Network Account,
  // so read the public account object directly instead.
  try {
    const account = await client.accounts.getOrImport(id);
    if (!account) throw new Error("The supplied account could not be imported from the network.");
    if (!account.isNetworkAccount()) throw new Error("The supplied account is not a Network Account.");
    return decodeVaultAccount(account, id.toString(), currentReferenceBlock, nativeFeeFaucet);
  } finally { id.free(); }
}

/** Reads a public Network Account through a fresh RPC wrapper and returns plain domain data. */
export async function readVaultFromRpc(endpoint: string, accountId: string): Promise<{ snapshot: VaultSnapshot; syncedBlock: number; diagnostics: VaultReadDiagnostic[] }> {
  let stage = "initialize_client";
  let rpc: RpcClient | undefined;
  let id: AccountId | undefined;
  let header: Awaited<ReturnType<RpcClient["getBlockHeaderByNumber"]>> | undefined;
  let feeFaucet: AccountId | undefined;
  let fetched: Awaited<ReturnType<RpcClient["getAccountDetails"]>> | undefined;
  let account: ReturnType<NonNullable<typeof fetched>["account"]> | undefined;
  let operationError: unknown;
  try {
    rpc = new RpcClient(new Endpoint(endpoint));
    stage = "parse_account_id";
    id = AccountId.fromHex(parseVaultAccountId(accountId));
    stage = "sync_client";
    header = await rpc.getBlockHeaderByNumber(undefined, false);
    const syncedBlock = header.blockNum();
    feeFaucet = header.feeFaucetId();

    stage = "import_or_get_account";
    fetched = await rpc.getAccountDetails(id);

    stage = "read_account";
    account = fetched.account();
    if (!account) throw new Error("Account not found on Miden Testnet.");
    if (!account.isNetworkAccount()) throw new Error("The supplied account is not a Network Account.");

    stage = "decode_vault_state";
    const snapshot = decodeVaultAccount(account as unknown as ImportedAccount, id.toString(), syncedBlock, feeFaucet.toString());

    stage = "read_faucet_metadata";
    const metadataResult = await readFaucetMetadata(rpc, snapshot.faucet);
    const diagnostics: VaultReadDiagnostic[] = metadataResult.diagnostic ? [metadataResult.diagnostic] : [];
    const metadata = metadataResult.metadata;
    if (metadata) {
      snapshot.inheritedAssetSymbol = metadata.symbol;
      snapshot.inheritedAssetName = metadata.name;
      snapshot.inheritedAssetDecimals = metadata.decimals;
    }
    return { snapshot, syncedBlock, diagnostics };
  } catch (cause) {
    operationError = cause;
    if (cause instanceof VaultReadError) throw cause;
    throw new VaultReadError(stage, cause);
  } finally {
    const cleanupErrors: VaultReadDiagnostic[] = [];
    const dispose = (name: string, action: (() => void) | undefined) => {
      if (!action) return;
      try { action(); }
      catch (cause) { cleanupErrors.push(new VaultReadError(`dispose_cleanup:${name}`, cause)); }
    };
    dispose("account", account ? () => account!.free() : undefined);
    dispose("fetched_account", fetched ? () => fetched!.free() : undefined);
    dispose("fee_faucet_id", feeFaucet ? () => feeFaucet!.free() : undefined);
    dispose("block_header", header ? () => header!.free() : undefined);
    dispose("account_id", id ? () => id!.free() : undefined);
    dispose("rpc_client", rpc ? () => rpc!.free() : undefined);
    if (operationError === undefined && cleanupErrors.length > 0) {
      throw cleanupErrors[0];
    }
  }
}

/** Faucet display metadata is auxiliary; failures stay visible in developer details. */
async function readFaucetMetadata(rpc: RpcClient, faucetId: string): Promise<{ metadata?: { symbol: string; name: string; decimals: number }; diagnostic?: VaultReadDiagnostic }> {
  let id: AccountId | undefined;
  let fetched: Awaited<ReturnType<RpcClient["getAccountDetails"]>> | undefined;
  let account: ReturnType<NonNullable<typeof fetched>["account"]> | undefined;
  let component: BasicFungibleFaucetComponent | undefined;
  let symbol: ReturnType<BasicFungibleFaucetComponent["symbol"]> | undefined;
  let stage = "parse_faucet_account_id";
  let metadata: { symbol: string; name: string; decimals: number } | undefined;
  let diagnostic: VaultReadDiagnostic | undefined;
  try {
    id = AccountId.fromHex(faucetId);
    stage = "get_faucet_account";
    fetched = await rpc.getAccountDetails(id);
    stage = "read_faucet_account";
    account = fetched.account();
    if (account?.isFaucet()) {
      stage = "decode_faucet_metadata";
      // SDK 0.16.3's generated binding calls account.__destroy_into_raw()
      // before handing the pointer to Rust. Ownership transfers even if the
      // Rust call throws, so this wrapper must never be explicitly freed here.
      const transferredAccount = account;
      account = undefined;
      component = BasicFungibleFaucetComponent.fromAccount(transferredAccount);
      symbol = component.symbol();
      metadata = { symbol: symbol.toString(), name: component.tokenName(), decimals: component.decimals() };
    }
  } catch (cause) {
    diagnostic = new VaultReadError(`read_faucet_metadata:${stage}`, cause);
  }
  const dispose = (name: string, action: (() => void) | undefined) => {
    if (!action) return;
    try { action(); }
    catch (cause) { diagnostic ??= new VaultReadError(`read_faucet_metadata:dispose_${name}`, cause); }
  };
  dispose("symbol", symbol ? () => symbol!.free() : undefined);
  dispose("component", component ? () => component!.free() : undefined);
  dispose("account", account ? () => account!.free() : undefined);
  dispose("fetched_account", fetched ? () => fetched!.free() : undefined);
  dispose("account_id", id ? () => id!.free() : undefined);
  return diagnostic ? { diagnostic } : { metadata };
}

function decodeVaultAccount(account: ImportedAccount, accountId: string, currentReferenceBlock: number, nativeFeeFaucet: string): VaultSnapshot {
  const storage = account.storage();
  const vault = account.vault();
  try {
    const faucet = storedAccountId(storage, "asset_faucet");
    const value = (name: string) => {
      const item = storage.getItem(`${SLOT_PREFIX}${name}`);
      if (!item) throw new Error(`Vault storage is missing ${name}.`);
      return storedValue(item);
    };
    const inheritedFaucetId = AccountId.fromHex(faucet);
    const nativeFeeFaucetId = AccountId.fromHex(nativeFeeFaucet);
    try {
      return {
        accountId,
        owner: storedAccountId(storage, "owner"),
        beneficiary: storedAccountId(storage, "beneficiary"),
        faucet,
        nativeFeeFaucet,
        timeoutBlocks: value("timeout_blocks"),
        lastCheckIn: value("last_check_in"),
        activated: value("activated") === 1n,
        claimed: value("claimed") === 1n,
        inheritedBalance: vault.getBalance(inheritedFaucetId),
        nativeBalance: vault.getBalance(nativeFeeFaucetId),
        noteAllowlist: roots(storage, NETWORK_NOTE_SLOT),
        transactionScriptAllowlist: roots(storage, NETWORK_TX_SLOT),
        currentReferenceBlock,
      };
    } finally {
      inheritedFaucetId.free();
      nativeFeeFaucetId.free();
    }
  } finally {
    (storage as unknown as { free?: () => void }).free?.();
    (vault as unknown as { free?: () => void }).free?.();
  }
}

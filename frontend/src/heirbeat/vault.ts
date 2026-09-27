import { AccountId, Endpoint, RpcClient, wordToBigInt } from "@miden-sdk/miden-sdk";
import type { MidenClient } from "@miden-sdk/miden-sdk";
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

/** Reads a public Network Account directly through a fresh RPC wrapper, without a cached client. */
export async function readVaultFromRpc(endpoint: string, accountId: string): Promise<{ snapshot: VaultSnapshot; syncedBlock: number }> {
  const rpc = new RpcClient(new Endpoint(endpoint));
  let id: AccountId | undefined;
  let header: Awaited<ReturnType<RpcClient["getBlockHeaderByNumber"]>> | undefined;
  let feeFaucet: AccountId | undefined;
  let fetched: Awaited<ReturnType<RpcClient["getAccountDetails"]>> | undefined;
  let account: ReturnType<NonNullable<typeof fetched>["account"]> | undefined;
  try {
    id = AccountId.fromHex(accountId);
    header = await rpc.getBlockHeaderByNumber(undefined, false);
    const syncedBlock = header.blockNum();
    feeFaucet = header.feeFaucetId();
    fetched = await rpc.getAccountDetails(id);
    account = fetched.account();
    if (!account) throw new Error("The supplied account is not publicly readable from this RPC endpoint.");
    if (!account.isNetworkAccount()) throw new Error("The supplied account is not a Network Account.");
    const snapshot = decodeVaultAccount(account as unknown as ImportedAccount, id.toString(), syncedBlock, feeFaucet.toString());
    return { snapshot, syncedBlock };
  } finally {
    account?.free();
    fetched?.free();
    feeFaucet?.free();
    header?.free();
    id?.free();
    rpc.free();
  }
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

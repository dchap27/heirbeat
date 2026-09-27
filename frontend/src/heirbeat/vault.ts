import { AccountId, wordToBigInt } from "@miden-sdk/miden-sdk";
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
  return AccountId.fromPrefixSuffix(values[3], values[2]).toString();
}

function roots(storage: AccountStorageView, slot: string): string[] {
  return (storage.getMapEntries(slot) ?? [])
    .filter((entry) => !/^0x0+$/.test(entry.value))
    .map((entry) => entry.key)
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
  const account = await client.accounts.getOrImport(id);
  if (!account) throw new Error("The supplied account could not be imported from the network.");
  if (!account.isNetworkAccount()) throw new Error("The supplied account is not a Network Account.");
  const storage = account.storage();
  const faucet = storedAccountId(storage, "asset_faucet");
  const value = (name: string) => {
    const item = storage.getItem(`${SLOT_PREFIX}${name}`);
    if (!item) throw new Error(`Vault storage is missing ${name}.`);
    return storedValue(item);
  };
  return {
    accountId: id.toString(),
    owner: storedAccountId(storage, "owner"),
    beneficiary: storedAccountId(storage, "beneficiary"),
    faucet,
    nativeFeeFaucet,
    timeoutBlocks: value("timeout_blocks"),
    lastCheckIn: value("last_check_in"),
    activated: value("activated") === 1n,
    claimed: value("claimed") === 1n,
    inheritedBalance: account.vault().getBalance(AccountId.fromHex(faucet)),
    nativeBalance: account.vault().getBalance(AccountId.fromHex(nativeFeeFaucet)),
    noteAllowlist: roots(storage, NETWORK_NOTE_SLOT),
    transactionScriptAllowlist: roots(storage, NETWORK_TX_SLOT),
    currentReferenceBlock,
  };
}

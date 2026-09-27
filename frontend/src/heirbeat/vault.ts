import { AccountId } from "@miden-sdk/miden-sdk";
import type { MidenClient } from "@miden-sdk/miden-sdk";
import type { VaultSnapshot } from "../domain/types";

const SLOT_PREFIX = "heirbeat_vault::heirbeat_vault::";
const NETWORK_NOTE_SLOT = "miden::standards::auth::network_account::allowed_note_scripts";
const NETWORK_TX_SLOT = "miden::standards::auth::network_account::allowed_tx_scripts";

function storedAccountId(details: Awaited<ReturnType<MidenClient["accounts"]["getDetails"]>>, name: string): string {
  const word = details.storage.getItem(`${SLOT_PREFIX}${name}`);
  if (!word) throw new Error(`Vault storage is missing ${name}.`);
  const values = word.toFelts();
  return AccountId.fromPrefixSuffix(values[3], values[2]).toString();
}

function roots(details: Awaited<ReturnType<MidenClient["accounts"]["getDetails"]>>, slot: string): string[] {
  return (details.storage.getMapEntries(slot) ?? [])
    .filter((entry) => !/^0x0+$/.test(entry.value))
    .map((entry) => entry.key)
    .sort();
}

export async function readVault(client: MidenClient, accountId: string, currentReferenceBlock: number, nativeFeeFaucet: string): Promise<VaultSnapshot> {
  const id = AccountId.fromHex(accountId);
  await client.accounts.getOrImport(id);
  const details = await client.accounts.getDetails(id);
  if (!details.account.isNetworkAccount()) throw new Error("The supplied account is not a Network Account.");
  const faucet = storedAccountId(details, "asset_faucet");
  const value = (name: string) => {
    const item = details.storage.getItem(`${SLOT_PREFIX}${name}`);
    if (!item) throw new Error(`Vault storage is missing ${name}.`);
    return item.toBigInt();
  };
  return {
    accountId: id.toString(),
    owner: storedAccountId(details, "owner"),
    beneficiary: storedAccountId(details, "beneficiary"),
    faucet,
    nativeFeeFaucet,
    timeoutBlocks: value("timeout_blocks"),
    lastCheckIn: value("last_check_in"),
    activated: value("activated") === 1n,
    claimed: value("claimed") === 1n,
    inheritedBalance: details.vault.getBalance(AccountId.fromHex(faucet)),
    nativeBalance: details.vault.getBalance(AccountId.fromHex(nativeFeeFaucet)),
    noteAllowlist: roots(details, NETWORK_NOTE_SLOT),
    transactionScriptAllowlist: roots(details, NETWORK_TX_SLOT),
    currentReferenceBlock,
  };
}

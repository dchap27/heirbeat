import { describe, expect, it, vi } from "vitest";
import { AccountId, Felt } from "@miden-sdk/miden-sdk";
import type { MidenClient } from "@miden-sdk/miden-sdk";
import { readVault } from "./vault";

const accountId = "0xc01fe4f8003940514cdfc0bb2be577";
const ownerId = "0xa61714a99ec7619109e397cbac32cd";
const beneficiaryId = "0x4181277bcf64381105ee61baadb5bc";
const faucetId = "0x4020542183b9643120d0192be38793";
const nativeFaucetId = "0x18101fa522c174b165efd4f70a0385";

function accountWord(id: string) {
  const parsed = AccountId.fromHex(id);
  return {
    toFelts: () => [new Felt(0n), new Felt(0n), parsed.suffix(), parsed.prefix()],
  };
}

function storageWord(value: bigint) {
  return {
    toBigInt: () => value,
    toFelts: () => [new Felt(value), new Felt(0n), new Felt(0n), new Felt(0n)],
  };
}

describe("read Heirbeat vault", () => {
  it("decodes an importable Network Account without fetching key commitments", async () => {
    const values: Record<string, unknown> = {
      "heirbeat_vault::heirbeat_vault::owner": accountWord(ownerId),
      "heirbeat_vault::heirbeat_vault::beneficiary": accountWord(beneficiaryId),
      "heirbeat_vault::heirbeat_vault::asset_faucet": accountWord(faucetId),
      "heirbeat_vault::heirbeat_vault::timeout_blocks": storageWord(10n),
      "heirbeat_vault::heirbeat_vault::last_check_in": storageWord(507636n),
      "heirbeat_vault::heirbeat_vault::activated": storageWord(1n),
      "heirbeat_vault::heirbeat_vault::claimed": storageWord(1n),
    };
    const storage = {
      getItem: (name: string) => values[name] as never,
      getMapEntries: (name: string) => name.includes("allowed_note_scripts")
        ? [{ key: "0xclaim", value: "0x01" }, { key: "0xconfig", value: "0x00" }]
        : [{ key: "0xexpiration", value: "0x01" }],
    };
    const account = {
      isNetworkAccount: () => true,
      storage: () => storage,
      vault: () => ({ getBalance: (asset: AccountId) => asset.toString() === faucetId ? 0n : 169n }),
    };
    const client = {
      accounts: {
        getOrImport: vi.fn().mockResolvedValue(account),
        getDetails: vi.fn().mockRejectedValue(new Error("public key commitments unavailable")),
      },
    } as unknown as MidenClient;

    const snapshot = await readVault(client, accountId, 512064, nativeFaucetId);

    expect(client.accounts.getOrImport).toHaveBeenCalledOnce();
    expect(client.accounts.getDetails).not.toHaveBeenCalled();
    expect(snapshot).toMatchObject({
      accountId,
      owner: ownerId,
      beneficiary: beneficiaryId,
      faucet: faucetId,
      nativeFeeFaucet: nativeFaucetId,
      timeoutBlocks: 10n,
      lastCheckIn: 507636n,
      activated: true,
      claimed: true,
      inheritedBalance: 0n,
      nativeBalance: 169n,
      noteAllowlist: ["0xclaim"],
      transactionScriptAllowlist: ["0xexpiration"],
      currentReferenceBlock: 512064,
    });
  });

  it("rejects non-Network Accounts", async () => {
    const client = {
      accounts: { getOrImport: vi.fn().mockResolvedValue({ isNetworkAccount: () => false }) },
    } as unknown as MidenClient;
    await expect(readVault(client, accountId, 1, nativeFaucetId)).rejects.toThrow("not a Network Account");
  });
});

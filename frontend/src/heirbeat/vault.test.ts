import { describe, expect, it, vi } from "vitest";
import { AccountId, AccountInterface, BasicFungibleFaucetComponent, Felt, NetworkId, RpcClient } from "@miden-sdk/miden-sdk";
import type { MidenClient } from "@miden-sdk/miden-sdk";
import { readVault, readVaultFromRpc } from "./vault";

const accountId = "0xc01fe4f8003940514cdfc0bb2be577";
const ownerId = "0xa61714a99ec7619109e397cbac32cd";
const beneficiaryId = "0x4181277bcf64381105ee61baadb5bc";
const faucetId = "0x4020542183b9643120d0192be38793";
const nativeFaucetId = "0x18101fa522c174b165efd4f70a0385";
const bech32AccountId = (() => {
  const id = AccountId.fromHex(accountId);
  try { return id.toBech32(NetworkId.testnet(), AccountInterface.BasicWallet); }
  finally { id.free(); }
})();

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

  it.each([accountId, bech32AccountId])("normalizes %s before the public RPC read and returns plain state", async (inputId) => {
    const data = new Map<string, unknown>([
      ["heirbeat_vault::heirbeat_vault::owner", accountWord(ownerId)],
      ["heirbeat_vault::heirbeat_vault::beneficiary", accountWord(beneficiaryId)],
      ["heirbeat_vault::heirbeat_vault::asset_faucet", accountWord(faucetId)],
      ["heirbeat_vault::heirbeat_vault::timeout_blocks", storageWord(10n)],
      ["heirbeat_vault::heirbeat_vault::last_check_in", storageWord(507636n)],
      ["heirbeat_vault::heirbeat_vault::activated", storageWord(1n)],
      ["heirbeat_vault::heirbeat_vault::claimed", storageWord(1n)],
    ]);
    const makeAccount = () => ({
      isNetworkAccount: () => true,
      isFaucet: () => false,
      storage: () => ({
        getItem: (key: string) => data.get(key) as never,
        getMapEntries: (key: string) => key.includes("allowed_note_scripts") ? [{ key: "0xclaim", value: "0x01" }] : [{ key: "0xexpiration", value: "0x01" }],
      }),
      vault: () => ({ getBalance: (asset: AccountId) => asset.toString() === faucetId ? 0n : 169n }),
      free: vi.fn(),
    });
    const vaultAccount = makeAccount();
    const metadataAccount = makeAccount();
    const makeFetched = (account: ReturnType<typeof makeAccount>) => ({ account: () => account, free: vi.fn() });
    const header = { blockNum: () => 507700, feeFaucetId: () => AccountId.fromHex(nativeFaucetId), free: vi.fn() };
    const byAccountId = vi.spyOn(RpcClient.prototype, "getAccountDetails")
      .mockImplementation(async (requested) => makeFetched(requested.toString() === accountId ? vaultAccount : metadataAccount) as never);
    const byBlock = vi.spyOn(RpcClient.prototype, "getBlockHeaderByNumber").mockResolvedValue(header as never);
    const rpcFree = vi.spyOn(RpcClient.prototype, "free").mockImplementation(() => {});
    try {
      const result = await readVaultFromRpc("https://rpc.testnet.miden.io", inputId);
      expect(result.snapshot).toMatchObject({
        accountId,
        owner: ownerId,
        beneficiary: beneficiaryId,
        faucet: faucetId,
        activated: true,
        claimed: true,
        inheritedBalance: 0n,
        nativeBalance: 169n,
      });
      expect(result.syncedBlock).toBe(507700);
      expect(result.snapshot).not.toHaveProperty("free");
      expect(result.diagnostics).toEqual([]);
      expect(byBlock).toHaveBeenCalledOnce();
      expect(byAccountId).toHaveBeenCalledTimes(2); // vault plus optional faucet metadata
      expect(rpcFree).toHaveBeenCalledOnce();
    } finally {
      byAccountId.mockRestore();
      byBlock.mockRestore();
      rpcFree.mockRestore();
    }
  });

  it("keeps metadata WASM failure out of the successful vault read and records its exact stage", async () => {
    const account = {
      isNetworkAccount: () => true,
      isFaucet: () => false,
      storage: () => ({
        getItem: (key: string) => ({
          "heirbeat_vault::heirbeat_vault::owner": accountWord(ownerId),
          "heirbeat_vault::heirbeat_vault::beneficiary": accountWord(beneficiaryId),
          "heirbeat_vault::heirbeat_vault::asset_faucet": accountWord(faucetId),
          "heirbeat_vault::heirbeat_vault::timeout_blocks": storageWord(10n),
          "heirbeat_vault::heirbeat_vault::last_check_in": storageWord(507636n),
          "heirbeat_vault::heirbeat_vault::activated": storageWord(1n),
          "heirbeat_vault::heirbeat_vault::claimed": storageWord(1n),
        } as Record<string, unknown>)[key] as never,
        getMapEntries: (key: string) => key.includes("allowed_note_scripts") ? [] : [],
      }),
      vault: () => ({ getBalance: () => 0n }),
      free: vi.fn(),
    };
    const fetched = { account: () => account, free: vi.fn() };
    const header = { blockNum: () => 507700, feeFaucetId: () => AccountId.fromHex(nativeFaucetId), free: vi.fn() };
    const details = vi.spyOn(RpcClient.prototype, "getAccountDetails")
      .mockResolvedValueOnce(fetched as never)
      .mockRejectedValueOnce(new Error("null pointer passed to rust"));
    const block = vi.spyOn(RpcClient.prototype, "getBlockHeaderByNumber").mockResolvedValue(header as never);
    const rpcFree = vi.spyOn(RpcClient.prototype, "free").mockImplementation(() => {});
    try {
      const result = await readVaultFromRpc("https://rpc.testnet.miden.io", accountId);
      expect(result.snapshot.claimed).toBe(true);
      expect(result.diagnostics).toEqual([expect.objectContaining({
        stage: "read_faucet_metadata:get_faucet_account",
        errorName: "Error",
        errorMessage: "null pointer passed to rust",
      })]);
    } finally {
      details.mockRestore(); block.mockRestore(); rpcFree.mockRestore();
    }
  });

  it("reads faucet metadata without freeing the Account wrapper consumed by fromAccount", async () => {
    const values: Record<string, unknown> = {
      "heirbeat_vault::heirbeat_vault::owner": accountWord(ownerId),
      "heirbeat_vault::heirbeat_vault::beneficiary": accountWord(beneficiaryId),
      "heirbeat_vault::heirbeat_vault::asset_faucet": accountWord(faucetId),
      "heirbeat_vault::heirbeat_vault::timeout_blocks": storageWord(10n),
      "heirbeat_vault::heirbeat_vault::last_check_in": storageWord(507636n),
      "heirbeat_vault::heirbeat_vault::activated": storageWord(1n),
      "heirbeat_vault::heirbeat_vault::claimed": storageWord(1n),
    };
    const makeAccount = (faucet: boolean) => ({
      isNetworkAccount: () => !faucet,
      isFaucet: () => faucet,
      storage: () => ({
        getItem: (key: string) => values[key] as never,
        getMapEntries: () => [],
      }),
      vault: () => ({ getBalance: () => 0n }),
      free: vi.fn(),
    });
    const vaultAccount = makeAccount(false);
    const faucetAccount = makeAccount(true);
    const fetchedVault = { account: () => vaultAccount, free: vi.fn() };
    const fetchedFaucet = { account: () => faucetAccount, free: vi.fn() };
    const symbol = { toString: () => "HBTESTV", free: vi.fn() };
    const component = {
      symbol: () => symbol,
      tokenName: () => "Heirbeat Test",
      decimals: () => 6,
      free: vi.fn(),
    };
    const fromAccount = vi.spyOn(BasicFungibleFaucetComponent, "fromAccount").mockReturnValue(component as never);
    const details = vi.spyOn(RpcClient.prototype, "getAccountDetails")
      .mockResolvedValueOnce(fetchedVault as never)
      .mockResolvedValueOnce(fetchedFaucet as never);
    const header = { blockNum: () => 507700, feeFaucetId: () => AccountId.fromHex(nativeFaucetId), free: vi.fn() };
    const block = vi.spyOn(RpcClient.prototype, "getBlockHeaderByNumber").mockResolvedValue(header as never);
    const rpcFree = vi.spyOn(RpcClient.prototype, "free").mockImplementation(() => {});
    try {
      const result = await readVaultFromRpc("https://rpc.testnet.miden.io", accountId);
      expect(result.snapshot).toMatchObject({ inheritedAssetSymbol: "HBTESTV", inheritedAssetName: "Heirbeat Test", inheritedAssetDecimals: 6 });
      expect(result.diagnostics).toEqual([]);
      expect(fromAccount).toHaveBeenCalledWith(faucetAccount);
      expect(faucetAccount.free).not.toHaveBeenCalled();
      expect(vaultAccount.free).toHaveBeenCalledOnce();
      expect(fetchedFaucet.free).toHaveBeenCalledOnce();
      expect(component.free).toHaveBeenCalledOnce();
      expect(symbol.free).toHaveBeenCalledOnce();
    } finally {
      fromAccount.mockRestore(); details.mockRestore(); block.mockRestore(); rpcFree.mockRestore();
    }
  });
});

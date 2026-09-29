import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AccountId, AccountInterface, NetworkId } from "@miden-sdk/miden-sdk";
import type { VaultSnapshot } from "../domain/types";
import { prepareCheckIn, CHECK_IN_SPONSORSHIP_AMOUNT } from "./check-in";

const owner = "0xa61714a99ec7619109e397cbac32cd";
const beneficiary = "0x4181277bcf64381105ee61baadb5bc";
const vault = "0xc01fe4f8003940514cdfc0bb2be577";
const faucet = "0x4020542183b9643120d0192be38793";
const native = "0x18101fa522c174b165efd4f70a0385";
const snapshot: VaultSnapshot = {
  accountId: vault, owner, beneficiary, faucet, nativeFeeFaucet: native,
  timeoutBlocks: 10n, lastCheckIn: 507636n, activated: true, claimed: false,
  inheritedBalance: 1n, nativeBalance: 300n, noteAllowlist: [], transactionScriptAllowlist: [],
  currentReferenceBlock: 507640, verificationBaseFee: 2n,
};
const root = resolve(import.meta.dirname, "../../..");

function ownerAddress() {
  const id = AccountId.fromHex(owner);
  try { return id.toBech32(NetworkId.testnet(), AccountInterface.BasicWallet); }
  finally { id.free(); }
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("reusable single-vault check-in request", () => {
  it("constructs the exact paired heartbeat request for an explicit vault and keeps evidence plain", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const name = new URL(String(input), "http://localhost").pathname.split("/").at(-1)?.replace(".masp", "") ?? "";
      const bytes = await readFile(resolve(root, `contracts/${name}/target/miden/release/${name}.masp`));
      return new Response(bytes, { status: 200 });
    });
    const prepared = await prepareCheckIn({
      snapshot,
      connectedAddress: ownerAddress(),
      walletAssets: [{ faucetId: native, amount: "184" }],
    });
    expect(prepared.evidence).toMatchObject({
      vaultId: vault,
      state: "preparing",
      preLastCheckIn: "507636",
      preDeadline: "507646",
      availableNative: "184",
      requiredNative: "184",
    });
    expect(prepared.evidence.featureNoteId).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(prepared.evidence.sponsorshipNoteId).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(prepared.walletRequest.type).toBe("custom");
    const payload = prepared.walletRequest.payload as { address: string; recipientAddress: string; transactionRequest: string };
    expect(payload.address).toMatch(/^mtst1/i);
    expect(payload.recipientAddress).toBe(vault);
    expect(typeof payload.transactionRequest).toBe("string");
    expect(prepared.walletRequest).not.toHaveProperty("free");
    expect(prepared).not.toHaveProperty("feature");
    expect(prepared).not.toHaveProperty("sponsorship");
  });

  it("uses the existing 150 sponsorship amount and blocks insufficient native balance before wallet request construction", async () => {
    expect(CHECK_IN_SPONSORSHIP_AMOUNT).toBe(150n);
    await expect(prepareCheckIn({
      snapshot,
      connectedAddress: owner,
      walletAssets: [{ faucetId: native, amount: "183" }],
    })).rejects.toMatchObject({ name: "CheckInPreflightError", available: 183n, required: 184n });
  });

  it("fails closed when fee data is absent or the connected account is not the owner", async () => {
    await expect(prepareCheckIn({
      snapshot: { ...snapshot, verificationBaseFee: undefined },
      connectedAddress: owner,
      walletAssets: [{ faucetId: native, amount: "500" }],
    })).rejects.toThrow(/verification base fee is unavailable/);
    await expect(prepareCheckIn({
      snapshot,
      connectedAddress: beneficiary,
      walletAssets: [{ faucetId: native, amount: "500" }],
    })).rejects.toThrow(/No owner actions/);
  });
});

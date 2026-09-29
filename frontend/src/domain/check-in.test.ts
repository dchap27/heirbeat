import { describe, expect, it } from "vitest";
import { AccountId, AccountInterface, NetworkId } from "@miden-sdk/miden-sdk";
import type { VaultSnapshot } from "./types";
import { CHECK_IN_HELP_TEXT, availableNativeFromWalletAssets, checkInEligibility, checkInExecutionResult, checkInIsUnresolved, loadCheckInRecords, requiredNativeForCheckIn, userSafeCheckInError, type CheckInOperationState } from "./check-in";
import { walletAcceptedRecord, walletFailureRecord } from "../miden/check-in";

const owner = "0xa61714a99ec7619109e397cbac32cd";
const beneficiary = "0x4181277bcf64381105ee61baadb5bc";
const vault = "0xc01fe4f8003940514cdfc0bb2be577";
const faucet = "0x4020542183b9643120d0192be38793";
const native = "0x18101fa522c174b165efd4f70a0385";

function bech32(hex: string): string {
  const id = AccountId.fromHex(hex);
  try { return id.toBech32(NetworkId.testnet(), AccountInterface.BasicWallet); }
  finally { id.free(); }
}

const active: VaultSnapshot = {
  accountId: vault, owner, beneficiary, faucet, nativeFeeFaucet: native,
  timeoutBlocks: 10n, lastCheckIn: 100n, activated: true, claimed: false,
  inheritedBalance: 3n, nativeBalance: 900n, noteAllowlist: [], transactionScriptAllowlist: [],
  currentReferenceBlock: 105, verificationBaseFee: 2n,
};

describe("single-vault check-in policy", () => {
  it("allows the owner on an active unclaimed vault", () => {
    expect(checkInEligibility(active, bech32(owner))).toEqual({ allowed: true, role: "owner" });
  });
  it("rejects beneficiary and observer identities", () => {
    expect(checkInEligibility(active, beneficiary)).toMatchObject({ allowed: false, role: "beneficiary", reason: "No owner actions are available for this wallet." });
    expect(checkInEligibility(active, "0x1234567890abcdef1234567890abcdef")).toMatchObject({ allowed: false, role: "observer" });
  });
  it("fails closed for malformed wallet identity", () => {
    expect(checkInEligibility(active, "not-an-account")).toMatchObject({ allowed: false, reason: "Unable to verify connected wallet identity." });
  });
  it("requires activation and rejects terminal claimed vaults", () => {
    expect(checkInEligibility({ ...active, activated: false }, owner).reason).toBe("Finalize this vault before checking in.");
    expect(checkInEligibility({ ...active, claimed: true }, owner).reason).toBe("This vault has already been claimed.");
  });
  it("requires a connected owner wallet", () => {
    expect(checkInEligibility(active, null).reason).toBe("Connect the vault owner's wallet to check in.");
  });
  it("states that the heartbeat affects this vault only", () => {
    expect(CHECK_IN_HELP_TEXT).toContain("this vault only");
    expect(CHECK_IN_HELP_TEXT).toContain("inactivity timer");
  });
  it("uses the established CLI reserve formula and separate sponsorship amount", () => {
    expect(requiredNativeForCheckIn(150n, 2n)).toBe(184n);
    expect(requiredNativeForCheckIn(150n, 2n, 3n)).toBe(187n);
  });
  it("reads available native wallet balance by configured faucet only", () => {
    expect(availableNativeFromWalletAssets([
      { faucetId: faucet, amount: "999" }, { faucetId: native, amount: "184" },
    ], native)).toBe(184n);
    expect(availableNativeFromWalletAssets([{ faucetId: faucet, amount: "999" }], native)).toBe(0n);
    expect(() => availableNativeFromWalletAssets([{ faucetId: native, amount: "1.5" }], native)).toThrow("invalid native");
  });
  it.each(["preparing", "wallet_review", "wallet_accepted", "feature_note_committed", "ntx_pending", "ntx_executing", "unknown"] as CheckInOperationState[])("blocks duplicate concurrent operation in %s", (state) => {
    expect(checkInIsUnresolved(state)).toBe(true);
    expect(checkInEligibility(active, owner, state)).toMatchObject({ allowed: false, role: "owner" });
  });
  it.each(["idle", "wallet_rejected", "failed", "executed"] as CheckInOperationState[])("resolves the operation lock for %s", (state) => {
    expect(checkInIsUnresolved(state)).toBe(false);
  });
  it("does not treat wallet acceptance as execution", () => {
    const record = walletAcceptedRecord({ vaultId: vault, state: "wallet_review", featureNoteId: "f", sponsorshipNoteId: "s" }, "tx-id");
    expect(record.state).toBe("wallet_accepted");
    expect(record.walletTransactionId).toBe("tx-id");
    expect(record.postLastCheckIn).toBeUndefined();
  });
  it("does not reinterpret generic NOT_GRANTED as explicit user cancellation", () => {
    const record = walletFailureRecord({ vaultId: vault, state: "wallet_review" }, new Error("NOT_GRANTED"));
    expect(record.state).toBe("unknown");
    expect(record.diagnostic?.errorMessage).toBe("NOT_GRANTED");
    expect(record.message).not.toContain("NOT_GRANTED");
  });
  it("maps explicit user rejection to canceled without claiming success", () => {
    const record = walletFailureRecord({ vaultId: vault, state: "wallet_review" }, new Error("User rejected request"));
    expect(record.state).toBe("wallet_rejected");
    expect(record.message).toBe("Check-in canceled or declined in the wallet.");
  });
  it("maps NOT_GRANTED only in the known transaction-request rejection context", () => {
    const cause = { name: "WalletTransactionError", message: "NOT_GRANTED", error: { name: "NotGrantedMidenWalletError", message: "NOT_GRANTED" } };
    expect(walletFailureRecord({ vaultId: vault, state: "wallet_review" }, cause, "transaction_request").state).toBe("wallet_rejected");
    expect(walletFailureRecord({ vaultId: vault, state: "wallet_review" }, cause, "other").state).toBe("unknown");
  });
  it("confirms execution only from a fresh increased last_check_in and derives the new deadline", () => {
    const post = { ...active, lastCheckIn: 108n, currentReferenceBlock: 108 };
    expect(checkInExecutionResult(active, post)).toEqual({ executed: true, deadline: 118n });
  });
  it("does not confirm unchanged state, claimed state, or inconsistent policy", () => {
    expect(checkInExecutionResult(active, active).executed).toBe(false);
    expect(checkInExecutionResult(active, { ...active, lastCheckIn: 101n, claimed: true }).reason).toContain("not a confirmed heartbeat");
    expect(checkInExecutionResult(active, { ...active, lastCheckIn: 101n, timeoutBlocks: 11n }).executed).toBe(false);
  });
  it("keeps raw errors for diagnostics but uses safe product copy", () => {
    expect(userSafeCheckInError("wallet_request")).not.toContain("WASM");
    expect(userSafeCheckInError("fee_preflight")).toContain("native fee balance");
  });
  it("restores unresolved evidence as plain values keyed by vault and rejects malformed storage", () => {
    const record = { vaultId: vault, state: "ntx_pending", featureNoteId: "0xfeature", sponsorshipNoteId: "0xsponsor", walletTransactionId: "0xtx" };
    const restored = loadCheckInRecords(JSON.stringify({ [vault.toLowerCase()]: record }));
    expect(restored[vault.toLowerCase()]).toEqual(record);
    expect(checkInIsUnresolved(restored[vault.toLowerCase()]!.state)).toBe(true);
    expect(loadCheckInRecords("not-json")).toEqual({});
    expect(loadCheckInRecords(JSON.stringify({ bad: record }))).toEqual({});
  });
});

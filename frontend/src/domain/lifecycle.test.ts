import { describe, expect, it } from "vitest";
import { AccountId, AccountInterface, NetworkId } from "@miden-sdk/miden-sdk";
import { deriveDeadline, deriveLifecycle, deriveRole, deriveRoleWithDiagnostic } from "./lifecycle";
import type { VaultSnapshot } from "./types";

const base: VaultSnapshot = {
  accountId: "0xvault", owner: "0xowner", beneficiary: "0xbeneficiary", faucet: "0xfaucet",
  nativeFeeFaucet: "0xfee",
  timeoutBlocks: 10n, lastCheckIn: 100n, activated: true, claimed: false,
  inheritedBalance: 4n, nativeBalance: 99n, noteAllowlist: [], transactionScriptAllowlist: [],
  currentReferenceBlock: 105,
};

describe("Heirbeat browser domain derivations", () => {
  it("uses the inclusive claim deadline", () => {
    expect(deriveDeadline(100n, 10n)).toBe(110n);
    expect(deriveLifecycle({ ...base, currentReferenceBlock: 109 }).eligible).toBe(false);
    expect(deriveLifecycle({ ...base, currentReferenceBlock: 110 }).eligible).toBe(true);
  });

  it("derives lifecycle and role without mutating chain state", () => {
    expect(deriveLifecycle(base).lifecycle).toBe("active");
    // No warning threshold is defined by product policy, so pre-deadline
    // blocks remain Active instead of inventing a warning window.
    expect(deriveLifecycle({ ...base, currentReferenceBlock: 109 }).lifecycle).toBe("active");
    expect(deriveLifecycle({ ...base, currentReferenceBlock: 110 }).lifecycle).toBe("claimable");
    expect(deriveLifecycle({ ...base, claimed: true }).lifecycle).toBe("claimed");
    expect(deriveLifecycle({ ...base, activated: false }).lifecycle).toBe("setup");
    const owner = "0xa61714a99ec7619109e397cbac32cd";
    const beneficiary = "0x4181277bcf64381105ee61baadb5bc";
    expect(deriveRole(owner.toUpperCase().replace("0X", "0x"), owner, beneficiary)).toBe("owner");
    expect(deriveRole(beneficiary, owner, beneficiary)).toBe("beneficiary");
    expect(deriveRole(null, owner, beneficiary)).toBe("observer");
    expect(deriveRole("mtst1not-a-real-account", owner, beneficiary)).toBe("observer");
    expect(deriveRoleWithDiagnostic("malformed-address", owner, beneficiary)).toMatchObject({
      role: "observer",
      diagnostic: { stage: "derive_role" },
    });
  });

  it("normalizes the wallet adapter's Bech32 address before role comparison", () => {
    const ownerId = AccountId.fromHex("0xa61714a99ec7619109e397cbac32cd");
    const bech32 = ownerId.toBech32(NetworkId.testnet(), AccountInterface.BasicWallet);
    expect(deriveRole(bech32, ownerId.toString(), "0x4181277bcf64381105ee61baadb5bc")).toBe("owner");
  });
});

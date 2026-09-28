import { describe, expect, it } from "vitest";
import { AccountId, AccountInterface, NetworkId } from "@miden-sdk/miden-sdk";
import { classifyVaultReadError, formatAssetAmount, parseVaultAccountId, parseVaultLocation, userSafeVaultError, VaultReadError } from "./open-vault";

describe("explicit vault access", () => {
  const hex = "0xc01fe4f8003940514cdfc0bb2be577";

  it("validates and canonicalizes a hex AccountId before lookup", () => {
    expect(parseVaultAccountId(` ${hex.toUpperCase().replace("0X", "0x")} `)).toBe(hex);
  });

  it("accepts a valid Bech32 AccountId", () => {
    const accountId = AccountId.fromHex(hex);
    try {
      const bech32 = accountId.toBech32(NetworkId.testnet(), AccountInterface.BasicWallet);
      expect(parseVaultAccountId(bech32)).toBe(hex);
    } finally {
      accountId.free();
    }
  });

  it("rejects malformed account ids before RPC access", () => {
    expect(() => parseVaultAccountId("not-an-account")).toThrow();
    expect(() => parseVaultAccountId("")).toThrow("Enter a vault Account ID.");
  });

  it("parses explicit share links without implying discovery", () => {
    expect(parseVaultLocation("/", `?vault=${hex}`)).toEqual({ accountId: hex, requested: true });
    expect(parseVaultLocation(`/vault/${hex}`, "")).toEqual({ accountId: hex, requested: true });
    expect(parseVaultLocation("/", "")).toEqual({ accountId: null, requested: false });
  });

  it("classifies missing, incompatible, and transport errors separately", () => {
    expect(classifyVaultReadError(new Error("Account not found"))).toBe("not_found");
    expect(classifyVaultReadError(new Error("not a Heirbeat vault"))).toBe("incompatible_account");
    expect(classifyVaultReadError(new Error("RPC deadline exceeded"))).toBe("rpc_error");
  });

  it("classifies WASM/runtime failures separately and retains stage plus original error", () => {
    const failure = new VaultReadError("decode_vault_state", new Error("null pointer passed to rust"));
    expect(classifyVaultReadError(failure)).toBe("sdk_error");
    expect(userSafeVaultError("sdk_error")).not.toContain("null pointer");
    expect(failure).toMatchObject({ stage: "decode_vault_state", errorName: "Error", errorMessage: "null pointer passed to rust" });
  });

  it("formats raw asset units using faucet decimals without floating-point conversion", () => {
    expect(formatAssetAmount(100_000_000_000_000_000_001n, 18)).toBe("100.000000000000000001");
    expect(formatAssetAmount(1234000n, 4)).toBe("123.4");
    expect(formatAssetAmount(100n)).toBe("100");
  });
});

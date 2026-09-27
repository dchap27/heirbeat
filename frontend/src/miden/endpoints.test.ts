import { describe, expect, it } from "vitest";
import { KNOWN_VAULT_ID, TESTNET_ENDPOINTS } from "./endpoints";

describe("testnet endpoint configuration", () => {
  it("uses the stable v0.16 endpoint documented by Miden", () => {
    expect(TESTNET_ENDPOINTS).toEqual(["https://rpc.testnet.miden.io"]);
    expect(KNOWN_VAULT_ID).toBe("0xc01fe4f8003940514cdfc0bb2be577");
  });
});

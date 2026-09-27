import { describe, expect, it } from "vitest";
import { Endpoint, RpcClient } from "@miden-sdk/miden-sdk";

describe("Miden Web SDK NTX status API", () => {
  it("exposes network-note status on the public standalone RpcClient", () => {
    const rpc = new RpcClient(new Endpoint("https://rpc.testnet.miden.io"));
    try {
      expect(typeof rpc.getNetworkNoteStatus).toBe("function");
    } finally {
      rpc.free();
    }
  });
});

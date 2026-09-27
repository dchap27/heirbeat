import { describe, expect, it } from "vitest";
import { Endpoint, RpcClient } from "@miden-sdk/miden-sdk";

describe("Miden Web SDK block-header API", () => {
  it("exposes block-header reads on the standalone RpcClient", () => {
    const rpc = new RpcClient(new Endpoint("https://rpc.testnet.miden.io"));
    try {
      expect(typeof rpc.getBlockHeaderByNumber).toBe("function");
    } finally {
      rpc.free();
    }
  });
});

import { MidenClient } from "@miden-sdk/miden-sdk";

export async function getBlockHeader(client: MidenClient, blockNumber: number) {
  type Raw = { getBlockHeaderByNumber(block: number): Promise<import("@miden-sdk/miden-sdk").BlockHeader> };
  type InternalClient = MidenClient & { _withInnerWebClient<T>(fn: (raw: Raw) => Promise<T>): Promise<T> };
  const internal = client as InternalClient;
  if (typeof internal._withInnerWebClient !== "function") {
    throw new Error("This Web SDK build does not expose the block-header read bridge.");
  }
  return internal._withInnerWebClient((raw) => raw.getBlockHeaderByNumber(blockNumber));
}

export async function createReadOnlyClient(endpoint: string): Promise<MidenClient> {
  const client = await MidenClient.create({
    rpcUrl: endpoint,
    autoSync: false,
    storeName: `heirbeat-browser-spike-${new URL(endpoint).host}`,
  });
  await client.syncChain();
  return client;
}

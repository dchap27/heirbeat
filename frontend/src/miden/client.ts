import { Endpoint, MidenClient, RpcClient } from "@miden-sdk/miden-sdk";

export async function getBlockHeader(endpoint: string, blockNumber: number) {
  // Block headers are exposed by the standalone public RpcClient, not by the
  // WebClient wrapped by MidenClient._withInnerWebClient().
  const rpc = new RpcClient(new Endpoint(endpoint));
  try {
    return await rpc.getBlockHeaderByNumber(blockNumber, false);
  } finally {
    rpc.free();
  }
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

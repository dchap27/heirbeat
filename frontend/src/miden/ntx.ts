import { Endpoint, NoteId, RpcClient } from "@miden-sdk/miden-sdk";

export interface NtxStatusResult {
  status: string;
  attemptCount: number;
  lastAttemptBlockNum: number | undefined;
  lastError: string | undefined;
}

/**
 * Query NTX status through the Web SDK's public standalone RPC client. Keep this
 * transport detail isolated here so UI components do not depend on SDK internals.
 */
export async function readNtxStatus(endpoint: string, noteId: string): Promise<NtxStatusResult> {
  const rpc = new RpcClient(new Endpoint(endpoint));
  try {
    const status = await rpc.getNetworkNoteStatus(NoteId.fromHex(noteId));
    try {
      return {
        status: status.status,
        attemptCount: status.attemptCount,
        lastAttemptBlockNum: status.lastAttemptBlockNum,
        lastError: status.lastError,
      };
    } finally {
      status.free();
    }
  } finally {
    rpc.free();
  }
}

import { Endpoint, NoteId, RpcClient } from "@miden-sdk/miden-sdk";

export type OperationResult = {
  stage: string;
  outcome: "ok" | "error";
  value?: unknown;
  errorName?: string;
  errorMessage?: string;
};

export type NoteInspection = {
  label: string;
  noteId: string;
  networkStatus?: string;
  inclusionFound?: boolean;
  classification: "not_found" | "committed_unconsumed" | "pending" | "nullifier_inflight" | "discarded" | "nullifier_committed" | "query_error";
  operations: OperationResult[];
};

export type VaultInspection = {
  syncedBlock: number;
  accountId: string;
  activated: boolean;
  claimed: boolean;
  inheritedBalance: bigint;
  owner: string;
  beneficiary: string;
  faucet: string;
  noteAllowlist: string[];
  transactionScriptAllowlist: string[];
};

export type PreviewChainEvidence = {
  noteQueries: Array<{ noteId: string; result: NoteInspection["classification"]; operations: OperationResult[] }>;
  transactionHistory: "not_available_from_public_rpc";
};

type PreviewRpc = {
  getNetworkNoteStatus(noteId: NoteId): Promise<{ status: string; free(): void }>;
  getNotesById(noteIds: NoteId[]): Promise<Array<{ noteId: { toString(): string }; free(): void }>>;
  free(): void;
};
type RpcFactory = (endpoint: string) => PreviewRpc;

const createRpc: RpcFactory = (endpoint) => new RpcClient(new Endpoint(endpoint));

function errorResult(stage: string, cause: unknown): OperationResult {
  const error = cause as { name?: string; message?: string };
  return {
    stage,
    outcome: "error",
    errorName: error?.name ?? "UnknownError",
    errorMessage: error?.message ?? String(cause),
  };
}

function isNotFound(operation?: OperationResult): boolean {
  return operation?.outcome === "error"
    && /(?:resource|note) (?:was )?not found|not found in (?:the )?network|unknown note/i.test(operation.errorMessage ?? "");
}

function classify(ops: OperationResult[], networkStatus?: string, inclusionFound?: boolean): NoteInspection["classification"] {
  switch (networkStatus) {
    case "Pending": return "pending";
    case "NullifierInflight": return "nullifier_inflight";
    case "Discarded": return "discarded";
    case "NullifierCommitted": return "nullifier_committed";
  }
  if (inclusionFound) return "committed_unconsumed";
  const status = ops.find((op) => op.stage.endsWith("get_network_note_status_call"));
  const notes = ops.find((op) => op.stage.endsWith("get_notes_by_id_call"));
  if (status?.outcome === "error" && !isNotFound(status)) return "query_error";
  if (notes?.outcome === "error" && !isNotFound(notes)) return "query_error";
  if (notes?.outcome === "ok" && inclusionFound === false) return "not_found";
  if (isNotFound(status) || isNotFound(notes)) return "not_found";
  return "query_error";
}

async function runOperation<T>(
  label: string,
  method: "getNetworkNoteStatus" | "getNotesById",
  endpoint: string,
  noteIdHex: string,
  rpcFactory: RpcFactory,
): Promise<{ results: OperationResult[]; value?: T }> {
  const results: OperationResult[] = [];
  let id: NoteId | undefined;
  let rpc: PreviewRpc | undefined;
  let output: T | undefined;
  let noteIdHandedToGetNotesById = false;
  const prefix = `${label}_${method === "getNetworkNoteStatus" ? "get_network_note_status" : "get_notes_by_id"}`;
  try {
    id = NoteId.fromHex(noteIdHex);
    results.push({ stage: `${label}_parse_note_id_${method}`, outcome: "ok", value: "fresh NoteId parsed from immutable hex string" });
  } catch (cause) {
    results.push(errorResult(`${label}_parse_note_id_${method}`, cause));
    return { results };
  }
  try {
    rpc = rpcFactory(endpoint);
    results.push({ stage: `${prefix}_create_rpc_client`, outcome: "ok" });
  } catch (cause) {
    results.push(errorResult(`${prefix}_create_rpc_client`, cause));
  }
  if (rpc) {
    try {
      if (method === "getNetworkNoteStatus") {
        const status = await rpc.getNetworkNoteStatus(id);
        try {
          const statusValue = status.status;
          output = statusValue as T;
          results.push({ stage: `${prefix}_call`, outcome: "ok", value: statusValue });
        } finally {
          try { status.free(); results.push({ stage: `${prefix}_free_result`, outcome: "ok" }); }
          catch (cause) { results.push(errorResult(`${prefix}_free_result`, cause)); }
        }
      } else {
        // In the installed 0.16.3 browser runtime, getNotesById invalidates
        // the NoteId wrapper. The generated glue transports the JS object via
        // externref, but the observed post-call wrapper cannot be manually
        // freed. Keep the NoteId alive through the awaited call, then delegate
        // its cleanup to the SDK/WASM wrapper lifecycle.
        noteIdHandedToGetNotesById = true;
        const notes = await rpc.getNotesById([id]);
        try {
          const noteIds = notes.map((note) => note.noteId.toString());
          output = noteIds as T;
          results.push({ stage: `${prefix}_call`, outcome: "ok", value: noteIds });
        } finally {
          for (const [index, note] of notes.entries()) {
            try { note.free(); results.push({ stage: `${prefix}_free_result_${index}`, outcome: "ok" }); }
            catch (cause) { results.push(errorResult(`${prefix}_free_result_${index}`, cause)); }
          }
        }
      }
    } catch (cause) {
      results.push(errorResult(`${prefix}_call`, cause));
    }
  }
  if (noteIdHandedToGetNotesById) {
    results.push({ stage: `${prefix}_note_id_cleanup_deferred`, outcome: "ok", value: "getNotesById invalidates the wrapper; manual free skipped" });
  } else if (id) {
    try { id.free(); results.push({ stage: `${prefix}_free_note_id`, outcome: "ok" }); }
    catch (cause) { results.push(errorResult(`${prefix}_free_note_id`, cause)); }
  }
  try { rpc?.free(); if (rpc) results.push({ stage: `${prefix}_free_rpc_client`, outcome: "ok" }); }
  catch (cause) { results.push(errorResult(`${prefix}_free_rpc_client`, cause)); }
  return { results, ...(output !== undefined ? { value: output } : {}) };
}

/**
 * Note IDs enter this API only as strings. Each SDK call gets a new RpcClient
 * and a newly parsed NoteId that remains alive until that call has completed.
 */
export async function inspectNoteIndependently(
  endpoint: string,
  label: string,
  noteId: string,
  rpcFactory: RpcFactory = createRpc,
): Promise<NoteInspection> {
  const operations: OperationResult[] = [];
  const status = await runOperation<string>(label, "getNetworkNoteStatus", endpoint, noteId, rpcFactory);
  operations.push(...status.results);
  const notes = await runOperation<string[]>(label, "getNotesById", endpoint, noteId, rpcFactory);
  operations.push(...notes.results);
  const networkStatus = status.value;
  const returnedIds = notes.value;
  const inclusionFound = returnedIds?.some((returnedId) => returnedId.toLowerCase() === noteId.toLowerCase());
  return {
    label,
    noteId,
    ...(networkStatus ? { networkStatus } : {}),
    ...(inclusionFound !== undefined ? { inclusionFound } : {}),
    classification: classify(operations, networkStatus, inclusionFound),
    operations,
  };
}

/** Compatibility wrapper for the diagnostic P2ID preflight; each note is still isolated. */
export async function inspectPreviewEvidence(endpoint: string, noteIds: string[]): Promise<PreviewChainEvidence> {
  const noteQueries = await Promise.all(noteIds.map((noteId, index) =>
    inspectNoteIndependently(endpoint, `note_${index + 1}`, noteId)));
  return {
    noteQueries: noteQueries.map(({ noteId, classification, operations }) => ({ noteId, result: classification, operations })),
    transactionHistory: "not_available_from_public_rpc",
  };
}

/** Reads status for a known historical note as a transport/binding control probe. */
export async function probeKnownNetworkNoteStatus(
  endpoint: string,
  noteId: string,
  rpcFactory: RpcFactory = createRpc,
): Promise<OperationResult[]> {
  return (await runOperation<string>("historical_heartbeat", "getNetworkNoteStatus", endpoint, noteId, rpcFactory)).results;
}

import { describe, expect, it, vi } from "vitest";
import { NoteId } from "@miden-sdk/miden-sdk";
import {
  inspectNoteIndependently,
  probeKnownNetworkNoteStatus,
} from "./preview-evidence";
import { mapPreviewResult } from "./wallet-preview";

const knownId = "0x92da7ad5fad0defb64bf847dc49f7320b443bbcbeb1d4f71a9fadc318254f680";
const featureId = `0x${"11".repeat(32)}`;
const sponsorshipId = `0x${"22".repeat(32)}`;

function rpcFor(args: {
  status?: string;
  statusError?: Error;
  returnedIds?: string[];
  notesError?: Error;
  consumeIds?: boolean;
}) {
  const free = vi.fn();
  const statusFree = vi.fn();
  const noteFree = vi.fn();
  const seenIds: string[] = [];
  const argumentTypes: string[] = [];
  const rpc = {
    getNetworkNoteStatus: vi.fn(async (id: NoteId) => {
      seenIds.push(id.toString());
      argumentTypes.push(id.constructor.name);
      if (args.statusError) throw args.statusError;
      return { status: args.status ?? "NullifierCommitted", free: statusFree };
    }),
    getNotesById: vi.fn(async (ids: NoteId[]) => {
      ids.forEach((id) => { seenIds.push(id.toString()); argumentTypes.push(id.constructor.name); });
      if (args.notesError) throw args.notesError;
      if (args.consumeIds) ids.forEach((id) => id.free());
      return (args.returnedIds ?? []).map((id) => ({ noteId: { toString: () => id }, free: noteFree }));
    }),
    free,
  };
  return { rpc, free, statusFree, noteFree, seenIds, argumentTypes };
}

describe("isolated post-cancel RPC evidence", () => {
  it("parses a plain string and queries a known committed heartbeat status", async () => {
    const mock = rpcFor({ status: "NullifierCommitted" });
    const result = await probeKnownNetworkNoteStatus("https://rpc.testnet.miden.io", knownId, () => mock.rpc);
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "historical_heartbeat_parse_note_id_getNetworkNoteStatus", outcome: "ok" }),
      expect.objectContaining({ stage: "historical_heartbeat_get_network_note_status_call", outcome: "ok", value: "NullifierCommitted" }),
    ]));
    expect(mock.rpc.getNetworkNoteStatus).toHaveBeenCalledOnce();
    expect(mock.seenIds).toEqual([knownId]);
    expect(mock.argumentTypes).toEqual(["NoteId"]);
    expect(mock.statusFree).toHaveBeenCalledOnce();
    expect(mock.free).toHaveBeenCalledOnce();
  });

  it("reports a nonexistent note cleanly when status is not found and inclusion returns empty", async () => {
    const mock = rpcFor({ statusError: new Error("Resource not found"), returnedIds: [], consumeIds: true });
    const result = await inspectNoteIndependently("https://rpc.testnet.miden.io", "feature", featureId, () => mock.rpc);
    expect(result.classification).toBe("not_found");
    expect(result.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "feature_get_network_note_status_call", outcome: "error", errorMessage: "Resource not found" }),
      expect.objectContaining({ stage: "feature_get_notes_by_id_call", outcome: "ok", value: [] }),
    ]));
    expect(mock.rpc.getNotesById.mock.calls[0]?.[0]).toHaveLength(1);
    expect(mock.argumentTypes).toContain("NoteId");
    expect(result.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "feature_get_notes_by_id_note_id_cleanup_deferred", outcome: "ok" }),
    ]));
    expect(result.operations.some((operation) => operation.stage === "feature_get_notes_by_id_free_note_id")).toBe(false);
  });

  it("keeps the committed-note control case valid when getNotesById consumes its NoteId", async () => {
    const mock = rpcFor({ status: "NullifierCommitted", returnedIds: [knownId], consumeIds: true });
    const result = await inspectNoteIndependently("endpoint", "historical", knownId, () => mock.rpc);
    expect(result.classification).toBe("nullifier_committed");
    expect(result.networkStatus).toBe("NullifierCommitted");
    expect(result.inclusionFound).toBe(true);
    expect(result.operations.some((operation) => operation.outcome === "error")).toBe(false);
  });

  it("isolates feature and sponsorship calls with fresh clients and fresh NoteIds", async () => {
    const mocks = [
      rpcFor({ status: "Pending" }), rpcFor({ returnedIds: [featureId] }),
      rpcFor({ status: "NullifierInflight" }), rpcFor({ returnedIds: [sponsorshipId] }),
    ];
    const clients = mocks.map((mock) => mock.rpc);
    const factory = vi.fn(() => clients.shift()!);

    const featureResult = await inspectNoteIndependently("endpoint", "feature", featureId, factory);
    const sponsorshipResult = await inspectNoteIndependently("endpoint", "sponsorship", sponsorshipId, factory);

    expect(factory).toHaveBeenCalledTimes(4);
    expect(featureResult.classification).toBe("pending");
    expect(sponsorshipResult.classification).toBe("nullifier_inflight");
    expect(featureResult.noteId).toBe(featureId);
    expect(sponsorshipResult.noteId).toBe(sponsorshipId);
    expect(featureResult.operations.every((operation) => !(operation.value instanceof NoteId))).toBe(true);
    expect(sponsorshipResult.operations.every((operation) => !(operation.value instanceof NoteId))).toBe(true);
    expect(() => JSON.stringify([featureResult, sponsorshipResult])).not.toThrow();
  });

  it("pinpoints a null-pointer RPC failure to one operation without suppressing the other query", async () => {
    const mock = rpcFor({ statusError: new TypeError("null pointer passed to rust"), returnedIds: [] });
    const result = await inspectNoteIndependently("endpoint", "sponsorship", sponsorshipId, () => mock.rpc);
    expect(result.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "sponsorship_get_network_note_status_call", outcome: "error", errorName: "TypeError", errorMessage: "null pointer passed to rust" }),
      expect.objectContaining({ stage: "sponsorship_get_notes_by_id_call", outcome: "ok", value: [] }),
    ]));
    expect(result.classification).toBe("query_error");
  });

  it("keeps RPC transport errors distinct from absent notes", async () => {
    const mock = rpcFor({ statusError: new Error("deadline exceeded"), notesError: new Error("connection reset") });
    const result = await inspectNoteIndependently("endpoint", "feature", featureId, () => mock.rpc);
    expect(result.classification).toBe("query_error");
    expect(result.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "feature_get_network_note_status_call", errorMessage: "deadline exceeded" }),
      expect.objectContaining({ stage: "feature_get_notes_by_id_call", errorMessage: "connection reset" }),
    ]));
  });

  it("does not infer chain submission from Cancel plus no transaction ID", () => {
    const walletResult = mapPreviewResult(null, new Error("NOT_GRANTED"), true);
    expect(walletResult.transactionId).toBeNull();
    expect(walletResult.submissionAssessment).toBe("no_transaction_id_chain_status_unconfirmed");
  });
});

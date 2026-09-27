import { NoteId } from "@miden-sdk/miden-sdk";
import type { MidenClient, NetworkNoteStatusInfo } from "@miden-sdk/miden-sdk";

/**
 * The raw WASM WebClient exposes GetNetworkNoteStatus; MidenClient currently has
 * no public resource method, so this uses its explicitly internal serialized bridge.
 */
export async function readNtxStatus(client: MidenClient, noteId: string): Promise<NetworkNoteStatusInfo> {
  type Raw = { getNetworkNoteStatus(id: NoteId): Promise<NetworkNoteStatusInfo> };
  type InternalClient = MidenClient & {
    _withInnerWebClient<T>(fn: (raw: Raw) => Promise<T>): Promise<T>;
  };
  const internal = client as InternalClient;
  if (typeof internal._withInnerWebClient !== "function") {
    throw new Error("This Web SDK build does not expose its internal network-note status bridge.");
  }
  return internal._withInnerWebClient((raw) => raw.getNetworkNoteStatus(NoteId.fromHex(noteId)));
}

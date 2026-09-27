import {
  AccountId,
  FeltArray,
  FungibleAsset,
  Note,
  NoteAssets,
  NoteMetadata,
  NoteRecipient,
  NoteScript,
  NoteStorage,
  NoteTag,
  NoteType,
} from "@miden-sdk/miden-sdk";
import { ConsumeTransaction } from "@miden-sdk/miden-wallet-adapter";
import type { VaultSnapshot } from "../domain/types";
import { buildFeaturePair } from "../heirbeat/feature-notes";
import { normalizeAccountId } from "../domain/lifecycle";
import { makeWalletTransactionRequest } from "./wallet-request";

export const TERMINAL_PREVIEW_VAULT = "0xc01fe4f8003940514cdfc0bb2be577";
export const PREVIEW_SPONSORSHIP_AMOUNT = 1n;
export const PREVIEW_P2ID_AMOUNT = 1n;
export const HEARTBEAT_PREVIEW_DESCRIPTION = "Diagnostic heartbeat uses the connected non-owner wallet as the feature-note sender and targets the already-claimed, empty terminal vault.";

export type PreviewResult = {
  state: "preflight_failed" | "awaiting_wallet_decision" | "wallet_returned_transaction_id" | "wallet_rejected_or_failed" | "wallet_returned_no_id";
  callStarted: boolean;
  transactionId: string | null;
  submissionAssessment: "not_invoked" | "awaiting_wallet_decision" | "wallet_reports_queued_or_submitted" | "adapter_reports_not_submitted_chain_check_pending" | "no_transaction_id_chain_status_unconfirmed";
  message: string;
  error?: string;
};

export function pendingPreviewResult(): PreviewResult {
  return {
    state: "awaiting_wallet_decision",
    callStarted: true,
    transactionId: null,
    submissionAssessment: "awaiting_wallet_decision",
    message: "Wallet request is open or awaiting a response. Reject/cancel it; no submission result is known yet.",
  };
}

export interface HeartbeatPreviewSafety {
  safe: boolean;
  reason?: string;
  vaultMatches: boolean;
  activated: boolean;
  claimed: boolean;
  empty: boolean;
  connectedAccountDiffersFromOwner: boolean;
  enabled: boolean;
}

/** Diagnostic-only gate: wrong sender and terminal vault prevent valid Heirbeat state transitions. */
export function heartbeatPreviewSafety(snapshot: VaultSnapshot, connectedAccount: string | null | undefined): HeartbeatPreviewSafety {
  const disabled = (reason: string): HeartbeatPreviewSafety => ({
    safe: false,
    reason,
    vaultMatches: false,
    activated: false,
    claimed: false,
    empty: false,
    connectedAccountDiffersFromOwner: false,
    enabled: false,
  });
  try {
    if (!connectedAccount) return disabled("Connect a wallet before preparing the diagnostic preview.");
    const connectedId = normalizeAccountId(connectedAccount);
    const ownerId = normalizeAccountId(snapshot.owner);
    const checks = {
      vaultMatches: snapshot.accountId.toLowerCase() === TERMINAL_PREVIEW_VAULT,
      activated: snapshot.activated,
      claimed: snapshot.claimed,
      empty: snapshot.inheritedBalance === 0n,
      connectedAccountDiffersFromOwner: connectedId !== ownerId,
    };
    const enabled = Object.values(checks).every(Boolean);
    return {
      safe: enabled,
      ...(enabled ? {} : { reason: "Preview requires the known activated, claimed, empty vault and a connected account different from its configured owner." }),
      ...checks,
      enabled,
    };
  } catch {
    return disabled("Unable to verify connected account identity.");
  }
}

export function assertTerminalHeartbeatPreview(snapshot: VaultSnapshot, connectedAccount: string): void {
  const safety = heartbeatPreviewSafety(snapshot, connectedAccount);
  if (!safety.enabled) throw new Error("Heartbeat preview requires the known activated, claimed, empty vault and a connected account different from its configured owner.");
}

/** Maps the adapter's resolve-with-id / reject contract without claiming a rejection is confirmed on chain. */
export function mapPreviewResult(result: { transactionId?: string } | null, error?: unknown, callStarted = true): PreviewResult {
  if (result?.transactionId) {
    return {
      state: "wallet_returned_transaction_id",
      callStarted: true,
      transactionId: result.transactionId,
      submissionAssessment: "wallet_reports_queued_or_submitted",
      message: "The wallet returned a transaction ID. Treat this as submitted/queued; stop and do not retry.",
    };
  }
  const errorMessage = error instanceof Error ? error.message : error === undefined ? undefined : String(error);
  if (!callStarted) {
    return {
      state: "preflight_failed",
      callStarted: false,
      transactionId: null,
      submissionAssessment: "not_invoked",
      message: "Preflight failed before the wallet was called; no wallet request was made.",
      ...(errorMessage ? { error: errorMessage } : {}),
    };
  }
  if (!errorMessage) {
    return {
      state: "wallet_returned_no_id",
      callStarted: true,
      transactionId: null,
      submissionAssessment: "no_transaction_id_chain_status_unconfirmed",
      message: "The wallet returned no transaction ID. This alone does not prove chain non-submission; resync and inspect note IDs.",
    };
  }
  if (/wallet returned no transaction id.*transaction was not submitted/i.test(errorMessage)) {
    return {
      state: "wallet_returned_no_id",
      callStarted: true,
      transactionId: null,
      submissionAssessment: "adapter_reports_not_submitted_chain_check_pending",
      message: "The installed adapter reports that no transaction was submitted because no transaction ID was returned. Resync and inspect note IDs to verify the chain state.",
      error: errorMessage,
    };
  }
  return {
    state: "wallet_rejected_or_failed",
    callStarted: true,
    transactionId: null,
    submissionAssessment: "no_transaction_id_chain_status_unconfirmed",
    message: "The wallet call rejected or failed without returning a transaction ID. Cancellation is not distinguished from other wallet errors; resync and inspect note IDs.",
    error: errorMessage,
  };
}

/** Creates a canonical-looking but never-committed public P2ID fixture for request parsing only. */
export function buildDisposableP2idPreview(args: { sender: string; beneficiary: string; faucet: string }): {
  note: Note;
  request: ConsumeTransaction;
  noteId: string;
  amount: bigint;
  committedOnChain: false;
} {
  const sender = AccountId.fromHex(normalizeAccountId(args.sender));
  const beneficiary = AccountId.fromHex(normalizeAccountId(args.beneficiary));
  const faucet = AccountId.fromHex(args.faucet);
  const note = new Note(
    new NoteAssets([new FungibleAsset(faucet, PREVIEW_P2ID_AMOUNT)]),
    new NoteMetadata(sender, NoteType.Public, NoteTag.withAccountTarget(beneficiary)),
    NoteRecipient.fromScript(NoteScript.p2id(), new NoteStorage(new FeltArray([beneficiary.suffix(), beneficiary.prefix()]))),
  );
  const noteId = note.id().toString();
  const request = new ConsumeTransaction(faucet.toString(), noteId, "public", Number(PREVIEW_P2ID_AMOUNT), note.serialize());
  return { note, request, noteId, amount: PREVIEW_P2ID_AMOUNT, committedOnChain: false };
}

export function canStartPreview(attempted: boolean, busy: boolean): boolean {
  return !attempted && !busy;
}

export function canPreviewDisposableP2id(noteLookup: "not_found" | "committed_unconsumed" | "pending" | "nullifier_inflight" | "discarded" | "nullifier_committed" | "query_error" | undefined): boolean {
  return noteLookup === "not_found";
}

export async function buildTerminalHeartbeatPreview(snapshot: VaultSnapshot, connectedAccount: string) {
  assertTerminalHeartbeatPreview(snapshot, connectedAccount);
  const connectedAccountHex = normalizeAccountId(connectedAccount);
  const pair = await buildFeaturePair({
    kind: "heartbeat",
    sender: connectedAccountHex,
    vault: snapshot.accountId,
    inheritedFaucet: snapshot.faucet,
    nativeFaucet: snapshot.nativeFeeFaucet,
    sponsorshipAmount: PREVIEW_SPONSORSHIP_AMOUNT,
  });
  return {
    pair,
    walletRequest: makeWalletTransactionRequest(connectedAccount, snapshot.accountId, pair.request),
  };
}

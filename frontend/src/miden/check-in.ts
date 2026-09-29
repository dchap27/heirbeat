import type { Asset } from "@miden-sdk/miden-wallet-adapter";
import type { Transaction } from "@miden-sdk/miden-wallet-adapter";
import { availableNativeFromWalletAssets, checkInEligibility, checkInExecutionResult, requiredNativeForCheckIn, type CheckInRecord } from "../domain/check-in";
import type { VaultSnapshot } from "../domain/types";
import { buildFeaturePair } from "../heirbeat/feature-notes";
import { readVaultFromRpc } from "../heirbeat/vault";
import { normalizeAccountId } from "../domain/lifecycle";
import { inspectNoteIndependently } from "./preview-evidence";
import { makeWalletTransactionRequest } from "./wallet-request";

export const CHECK_IN_SPONSORSHIP_AMOUNT = 150n;

export interface PreparedCheckIn {
  walletRequest: Transaction;
  evidence: CheckInRecord;
}

/** Constructs the proven single-vault two-note heartbeat request and returns only plain evidence plus the wallet's serialized envelope. */
export async function prepareCheckIn(args: {
  snapshot: VaultSnapshot;
  connectedAddress: string | null;
  walletAssets: Asset[];
}): Promise<PreparedCheckIn> {
  const { snapshot, connectedAddress, walletAssets } = args;
  const eligible = checkInEligibility(snapshot, connectedAddress);
  if (!eligible.allowed || !connectedAddress) throw new Error(eligible.reason ?? "Check-in is not available.");
  if (snapshot.verificationBaseFee === undefined) throw new Error("Current verification base fee is unavailable; refusing to guess a fee requirement.");
  const available = availableNativeFromWalletAssets(walletAssets, snapshot.nativeFeeFaucet);
  const required = requiredNativeForCheckIn(CHECK_IN_SPONSORSHIP_AMOUNT, snapshot.verificationBaseFee);
  if (available < required) {
    throw new CheckInPreflightError(available, required);
  }

  const pair = await buildFeaturePair({
    kind: "heartbeat",
    sender: normalizeAccountId(connectedAddress),
    vault: snapshot.accountId,
    inheritedFaucet: snapshot.faucet,
    nativeFaucet: snapshot.nativeFeeFaucet,
    sponsorshipAmount: CHECK_IN_SPONSORSHIP_AMOUNT,
  });
  try {
    const walletRequest = makeWalletTransactionRequest(connectedAddress, snapshot.accountId, pair.request);
    return {
      walletRequest,
      evidence: {
        vaultId: snapshot.accountId,
        state: "preparing",
        featureNoteId: pair.info.featureId,
        sponsorshipNoteId: pair.info.sponsorshipId,
        preLastCheckIn: snapshot.lastCheckIn.toString(),
        preDeadline: (snapshot.lastCheckIn + snapshot.timeoutBlocks).toString(),
        availableNative: available.toString(),
        requiredNative: required.toString(),
      },
    };
  } finally {
    // The adapter's CustomTransaction serialized TransactionRequest synchronously.
    pair.request.free();
    pair.feature.free();
    pair.sponsorship.free();
  }
}

export class CheckInPreflightError extends Error {
  readonly available: bigint;
  readonly required: bigint;
  constructor(available: bigint, required: bigint) {
    super(`Owner has insufficient native fee balance for check-in sponsorship. Required: ${required}, available: ${available}. Fund the owner wallet and retry.`);
    this.name = "CheckInPreflightError";
    this.available = available;
    this.required = required;
  }
}

/** Read-only evidence refresh. Every note query uses the previously proven isolated browser RPC helper. */
export async function refreshCheckInStatus(endpoint: string, before: VaultSnapshot, record: CheckInRecord): Promise<{
  record: CheckInRecord;
  snapshot?: VaultSnapshot;
}> {
  if (!record.featureNoteId || !record.sponsorshipNoteId) throw new Error("Check-in note evidence is incomplete.");
  const [feature, sponsorship] = await Promise.all([
    inspectNoteIndependently(endpoint, "feature_note", record.featureNoteId),
    inspectNoteIndependently(endpoint, "sponsorship_note", record.sponsorshipNoteId),
  ]);
  const base: CheckInRecord = {
    ...record,
    featureNoteStatus: feature.networkStatus ?? feature.classification,
    sponsorshipNoteStatus: sponsorship.networkStatus ?? sponsorship.classification,
    ntxStatus: feature.networkStatus,
  };
  const rawFailure = [...feature.operations, ...sponsorship.operations].find((operation) => operation.outcome === "error");
  if (rawFailure) base.diagnostic = { stage: rawFailure.stage, errorName: rawFailure.errorName ?? "Error", errorMessage: rawFailure.errorMessage ?? "Status query failed." };

  if (record.state === "wallet_rejected" && feature.classification === "not_found" && sponsorship.classification === "not_found") {
    return { record: { ...base, state: "wallet_rejected", message: "Check-in canceled; neither request note was found on Miden." } };
  }
  if (feature.networkStatus === "Discarded") return { record: { ...base, state: "failed", message: "Miden discarded this check-in request. Review diagnostics before retrying." } };
  if (feature.networkStatus === "Pending") return { record: { ...base, state: "ntx_pending", message: "The heartbeat note is waiting for Network Account execution." } };
  if (feature.networkStatus === "NullifierInflight") return { record: { ...base, state: "ntx_executing", message: "Miden is executing the heartbeat for this vault." } };

  if (feature.classification === "committed_unconsumed" || feature.inclusionFound) {
    return { record: { ...base, state: "feature_note_committed", message: "The feature note is committed; Network Account execution is not yet confirmed." } };
  }
  if (feature.networkStatus !== "NullifierCommitted") {
    if (feature.classification === "query_error" || sponsorship.classification === "query_error") {
      return { record: { ...base, state: "unknown", message: "Unable to determine the network status. Retry this read-only status check." } };
    }
    return { record: { ...base, state: record.walletTransactionId ? "wallet_accepted" : "unknown", message: "The wallet request is known, but the feature note is not yet committed." } };
  }

  try {
    const fresh = await readVaultFromRpc(endpoint, before.accountId);
    const operationBaseline = record.preLastCheckIn === undefined ? before : { ...before, lastCheckIn: BigInt(record.preLastCheckIn) };
    const confirmation = checkInExecutionResult(operationBaseline, fresh.snapshot);
    if (confirmation.executed) {
      return {
        record: {
          ...base,
          state: "executed",
          postLastCheckIn: fresh.snapshot.lastCheckIn.toString(),
          postDeadline: confirmation.deadline!.toString(),
          message: "Check-in confirmed from fresh vault state.",
        },
        snapshot: fresh.snapshot,
      };
    }
    return { record: { ...base, state: "unknown", message: confirmation.reason ?? "The feature note was processed, but fresh vault state has not confirmed the check-in." }, snapshot: fresh.snapshot };
  } catch (cause) {
    const error = cause as { name?: string; message?: string; stage?: string };
    return {
      record: {
        ...base,
        state: "unknown",
        message: "The note was processed, but the vault could not be refreshed. Retry this read-only status check.",
        diagnostic: { stage: error.stage ?? "status_refresh:read_vault", errorName: error.name ?? "Error", errorMessage: error.message ?? String(cause) },
      },
    };
  }
}

export function walletFailureRecord(record: CheckInRecord, cause: unknown, context: "transaction_request" | "other" = "other"): CheckInRecord {
  const error = cause as { name?: string; message?: string; error?: { name?: string; message?: string } };
  const message = error?.error?.message ?? error?.message ?? String(cause);
  const adapterReportedCancel = context === "transaction_request"
    && error.name === "WalletTransactionError"
    && error.error?.name === "NotGrantedMidenWalletError"
    && message === "NOT_GRANTED";
  const explicitlyRejected = adapterReportedCancel || /user (?:rejected|declined|cancelled|canceled)|request rejected by user/i.test(message);
  return {
    ...record,
    state: explicitlyRejected ? "wallet_rejected" : "unknown",
    message: explicitlyRejected ? "Check-in canceled or declined in the wallet." : "The wallet request did not complete. Check its status before retrying.",
    diagnostic: { stage: "wallet_request", errorName: error?.error?.name ?? error?.name ?? "Error", errorMessage: message },
  };
}

export function walletAcceptedRecord(record: CheckInRecord, transactionId: string): CheckInRecord {
  return {
    ...record,
    state: "wallet_accepted",
    walletTransactionId: transactionId,
    message: "The wallet returned a transaction ID. This is not yet a confirmed check-in.",
  };
}

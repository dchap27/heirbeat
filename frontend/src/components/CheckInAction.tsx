import { useRef, useState } from "react";
import type { Asset } from "@miden-sdk/miden-wallet-adapter";
import type { Transaction } from "@miden-sdk/miden-wallet-adapter";
import { checkInEligibility, checkInIsUnresolved, CHECK_IN_HELP_TEXT, requiredNativeForCheckIn, userSafeCheckInError, type CheckInRecord } from "../domain/check-in";
import type { VaultSnapshot } from "../domain/types";
import { CHECK_IN_SPONSORSHIP_AMOUNT, CheckInPreflightError, prepareCheckIn, refreshCheckInStatus, walletAcceptedRecord, walletFailureRecord } from "../miden/check-in";

export const CHECK_IN_STATE_LABELS: Record<CheckInRecord["state"], string> = {
  idle: "Idle", preparing: "Preparing request", wallet_review: "Wallet review", wallet_rejected: "Canceled",
  wallet_accepted: "Wallet accepted", feature_note_committed: "Feature note committed", ntx_pending: "Waiting for network execution",
  ntx_executing: "Executing on Miden", executed: "Confirmed", failed: "Failed", unknown: "Status unknown",
};

function friendlyNoteStatus(status?: string): string {
  if (!status) return "Not yet verified";
  if (status === "not_found") return "Not found yet";
  if (status === "committed_unconsumed") return "Committed";
  if (status === "nullifier_committed") return "Consumed";
  if (status === "nullifier_inflight") return "Processing";
  if (status === "ntx_pending" || status === "Pending") return "Waiting for execution";
  if (status === "discarded" || status === "Discarded") return "Discarded";
  if (status === "query_error") return "Status unavailable";
  return "Status received";
}

export function CheckInAction({
  snapshot, endpoint, connectedAccount, walletConnected, requestAssets, requestTransaction, record, onRecord, onSnapshot,
}: {
  snapshot: VaultSnapshot;
  endpoint: string;
  connectedAccount: string | null;
  walletConnected: boolean;
  requestAssets?: () => Promise<Asset[]>;
  requestTransaction?: (transaction: Transaction) => Promise<string>;
  record?: CheckInRecord;
  onRecord: (record: CheckInRecord | undefined) => void;
  onSnapshot: (snapshot: VaultSnapshot) => void;
}) {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [safeError, setSafeError] = useState<string | null>(null);
  const eligibility = checkInEligibility(snapshot, walletConnected ? connectedAccount : null, record?.state ?? "idle");
  const available = record?.availableNative;
  const required = record?.requiredNative ?? (snapshot.verificationBaseFee === undefined
    ? undefined
    : requiredNativeForCheckIn(CHECK_IN_SPONSORSHIP_AMOUNT, snapshot.verificationBaseFee).toString());
  const operationResolved = !record || !checkInIsUnresolved(record.state);
  const canStart = eligibility.allowed && !busy && operationResolved && snapshot.verificationBaseFee !== undefined && !!requestAssets && !!requestTransaction;

  async function start() {
    if (!canStart || inFlight.current || !requestAssets || !requestTransaction) return;
    inFlight.current = true;
    setBusy(true);
    setSafeError(null);
    let evidence: CheckInRecord = {
      vaultId: snapshot.accountId,
      state: "preparing",
      preLastCheckIn: snapshot.lastCheckIn.toString(),
      preDeadline: (snapshot.lastCheckIn + snapshot.timeoutBlocks).toString(),
    };
    let stage = "fee_preflight";
    let walletInvoked = false;
    onRecord(evidence);
    try {
      stage = "wallet_assets";
      const walletAssets = await requestAssets();
      stage = "fee_preflight";
      stage = "prepare_request";
      const prepared = await prepareCheckIn({ snapshot, connectedAddress: connectedAccount, walletAssets });
      evidence = { ...prepared.evidence, state: "wallet_review" };
      onRecord(evidence);
      stage = "wallet_request";
      walletInvoked = true;
      const transactionId = await requestTransaction(prepared.walletRequest);
      evidence = walletAcceptedRecord(evidence, transactionId);
      onRecord(evidence);
      stage = "status_refresh";
      const refreshed = await refreshCheckInStatus(endpoint, snapshot, evidence);
      onRecord(refreshed.record);
      if (refreshed.snapshot) onSnapshot(refreshed.snapshot);
    } catch (cause) {
      if (!walletInvoked) {
        const feeError = cause instanceof CheckInPreflightError;
        const error = cause as { name?: string; message?: string };
        const errorStage = feeError ? "fee_preflight" : stage;
        const failed: CheckInRecord = {
          ...evidence,
          state: "failed",
          ...(feeError ? { availableNative: cause.available.toString(), requiredNative: cause.required.toString() } : {}),
          message: userSafeCheckInError(errorStage),
          diagnostic: { stage: errorStage, errorName: error.name ?? "Error", errorMessage: error.message ?? String(cause) },
        };
        onRecord(failed);
        setSafeError(failed.message ?? null);
      } else {
        const mapped = walletFailureRecord(evidence, cause, "transaction_request");
        if (walletInvoked && stage === "wallet_request" && mapped.featureNoteId && mapped.sponsorshipNoteId) {
          onRecord(mapped);
          try {
            const checked = await refreshCheckInStatus(endpoint, snapshot, mapped);
            onRecord(checked.record);
            if (checked.snapshot) onSnapshot(checked.snapshot);
            setSafeError(checked.record.message ?? userSafeCheckInError("wallet_request"));
          } catch (statusCause) {
            const diagnostic = statusCause as { name?: string; message?: string };
            const unresolved: CheckInRecord = {
              ...mapped,
              state: "unknown",
              message: userSafeCheckInError("status_refresh"),
              diagnostic: { stage: "status_refresh", errorName: diagnostic.name ?? "Error", errorMessage: diagnostic.message ?? String(statusCause) },
            };
            onRecord(unresolved);
            setSafeError(unresolved.message ?? null);
          }
        } else {
          onRecord(mapped);
          setSafeError(mapped.message ?? userSafeCheckInError("wallet_request"));
        }
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function refresh() {
    if (!record || busy || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setSafeError(null);
    try {
      const result = await refreshCheckInStatus(endpoint, snapshot, record);
      onRecord(result.record);
      if (result.snapshot) onSnapshot(result.snapshot);
    } catch (cause) {
      const error = cause as { name?: string; message?: string };
      const failed = {
        ...record,
        state: "unknown" as const,
        message: userSafeCheckInError("status_refresh"),
        diagnostic: { stage: "status_refresh", errorName: error.name ?? "Error", errorMessage: error.message ?? String(cause) },
      };
      onRecord(failed);
      setSafeError(failed.message ?? null);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function clearUnresolved() {
    if (!record || !checkInIsUnresolved(record.state)) return;
    if (window.confirm("Clear this local check-in record? This does not cancel a transaction or note that may still execute on Miden.")) onRecord(undefined);
  }

  return <section className="product-card actions-card check-in-card" aria-labelledby="check-in-title">
    <div className="section-kicker">Owner action · this vault only</div>
    <h2 id="check-in-title">Keep this vault protected</h2>
    <p>{CHECK_IN_HELP_TEXT}</p>
    <div className="check-in-preflight" aria-label="Check-in preflight">
      <span>Last check-in <strong>Block {snapshot.lastCheckIn}</strong></span>
      <span>Claim eligibility <strong>Block {snapshot.lastCheckIn + snapshot.timeoutBlocks}</strong></span>
      <span>Current block <strong>{snapshot.currentReferenceBlock}</strong></span>
      <span>Current verification base fee <strong>{snapshot.verificationBaseFee?.toString() ?? "Unavailable"}</strong></span>
      <span>Native fee balance <strong>{available === undefined ? "Check wallet before review" : `${available} units`}</strong></span>
      <span>Required for sponsorship + fee reserve <strong>{required === undefined ? "Unavailable" : `${required} units`}</strong></span>
    </div>
    {!eligibility.allowed && <p className="field-help" role="status">{eligibility.reason}</p>}
    {eligibility.allowed && snapshot.verificationBaseFee === undefined && <p className="field-help" role="status">Current network fee data is unavailable; check-in is disabled rather than guessing.</p>}
    {safeError && <p className="form-status form-error" role="alert">{safeError}</p>}
    <button className="button button-primary" onClick={() => void start()} disabled={!canStart}>
      {busy && record?.state === "preparing" ? "Preparing…" : "Check in to this vault"}
    </button>
    {record && <div className="check-in-operation" aria-live="polite">
      <div className={`execution-state operation-${record.state}`}>{CHECK_IN_STATE_LABELS[record.state]}</div>
      <p>{record.message}</p>
      {record.state === "wallet_review" && <p>The wallet is reviewing the request. Approval is not a confirmed check-in.</p>}
      {record.featureNoteId && <p>Feature note: {friendlyNoteStatus(record.featureNoteStatus)}</p>}
      {record.sponsorshipNoteId && <p>Sponsorship note: {friendlyNoteStatus(record.sponsorshipNoteStatus)}</p>}
      {record.state === "executed" && <p>New last check-in: block {record.postLastCheckIn} · eligibility: block {record.postDeadline}</p>}
      {(record.diagnostic || record.featureNoteId || record.sponsorshipNoteId) && <details className="developer-details"><summary>Developer diagnostics</summary>
        <code>{JSON.stringify(record, (_, value) => typeof value === "bigint" ? value.toString() : value, 2)}</code>
      </details>}
      {record.featureNoteId && !["executed", "failed", "wallet_rejected"].includes(record.state) && <button className="button button-secondary" onClick={() => void refresh()} disabled={busy}>Retry status check</button>}
      {checkInIsUnresolved(record.state) && <button className="button button-quiet" onClick={clearUnresolved} disabled={busy}>Clear unresolved local record…</button>}
    </div>}
  </section>;
}

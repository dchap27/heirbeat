import { useEffect, useRef, useState } from "react";
import type { Asset, Transaction } from "@miden-sdk/miden-wallet-adapter";
import { normalizeAccountId } from "../domain/lifecycle";
import { NATIVE_FEE_FAUCET_ID, TESTNET_ENDPOINTS } from "../miden/endpoints";
import { prepareBootstrapFundingWalletRequest, type PreparedBootstrapFundingWalletRequest } from "../miden/bootstrap-requests";
import { BOOTSTRAP_PREVIEW_OWNER_ID, BOOTSTRAP_PREVIEW_VAULT_ID, completeBootstrapFundingPreflight, mapBootstrapWalletOutcome, nativeBalanceFromWalletAssets, preflightBootstrapPublic, type BootstrapFundingPreflight, type BootstrapPostCancelEvidence, type BootstrapPublicPreflight, verifyBootstrapAfterCancel } from "../miden/bootstrap-funding-preview";

type BalanceState = "idle" | "checking_public_preflight" | "request_pending" | "granted" | "rejected_or_unknown" | "insufficient" | "failed";
type TransactionState = "idle" | "preparing" | "request_pending" | "resolved_without_id" | "rejected_or_failed" | "transaction_id_returned" | "verification_complete" | "verification_incomplete";

function currentAccountId(address: string | null): string | null {
  try { return address ? normalizeAccountId(address) : null; }
  catch { return null; }
}

export function BootstrapFundingPreview({
  connectedAddress,
  walletConnected,
  requestAssets,
  requestTransaction,
}: {
  connectedAddress: string | null;
  walletConnected: boolean;
  requestAssets?: () => Promise<Asset[]>;
  requestTransaction?: (transaction: Transaction) => Promise<string>;
}) {
  const [balanceState, setBalanceState] = useState<BalanceState>("idle");
  const [transactionState, setTransactionState] = useState<TransactionState>("idle");
  const [stage, setStage] = useState<string | null>(null);
  const [request, setRequest] = useState<PreparedBootstrapFundingWalletRequest | null>(null);
  const [publicPreflight, setPublicPreflight] = useState<BootstrapPublicPreflight | null>(null);
  const [preflight, setPreflight] = useState<BootstrapFundingPreflight | null>(null);
  const [postEvidence, setPostEvidence] = useState<BootstrapPostCancelEvidence | null>(null);
  const [nativeBalance, setNativeBalance] = useState<string | null>(null);
  const [balanceAuth, setBalanceAuth] = useState<{ accountId: string; address: string; balance: string; baseFee: string; at: string } | null>(null);
  const [transactionId, setTransactionId] = useState<string | null>(null);
  const [balanceError, setBalanceError] = useState<{ name: string; message: string } | null>(null);
  const [transactionError, setTransactionError] = useState<{ name: string; message: string } | null>(null);
  const [cancelConfirmed, setCancelConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef<"balance" | "transaction" | "verification" | null>(null);
  const [balanceInvocation, setBalanceInvocation] = useState<{ invoked: boolean; attemptedAt: string | null; method: "requestAssets" | null }>({ invoked: false, attemptedAt: null, method: null });
  const [transactionInvocation, setTransactionInvocation] = useState<{ invoked: boolean; attemptedAt: string | null; method: "requestTransaction" | null; preflightPassed: boolean }>({ invoked: false, attemptedAt: null, method: null, preflightPassed: false });

  const canonicalAddress = currentAccountId(connectedAddress);
  const balanceAuthorizationCurrent = !!balanceAuth && walletConnected
    && canonicalAddress === balanceAuth.accountId
    && connectedAddress === balanceAuth.address;

  useEffect(() => {
    if (balanceAuth && (!walletConnected || canonicalAddress !== balanceAuth.accountId || connectedAddress !== balanceAuth.address)) {
      setBalanceAuth(null);
      setNativeBalance(null);
      setPublicPreflight(null);
      setPreflight(null);
      setBalanceState("idle");
      setTransactionState("idle");
      setTransactionId(null);
      setPostEvidence(null);
    }
  }, [balanceAuth, canonicalAddress, connectedAddress, walletConnected]);

  if (!import.meta.env.DEV) return null;

  async function authorizeBalance() {
    if (inFlight.current || busy || !walletConnected || !connectedAddress || !requestAssets) return;
    inFlight.current = "balance";
    setBusy(true);
    setBalanceState("checking_public_preflight");
    setTransactionState("idle");
    setStage("verify_owner");
    setRequest(null);
    setPublicPreflight(null);
    setPreflight(null);
    setPostEvidence(null);
    setNativeBalance(null);
    setBalanceAuth(null);
    setTransactionId(null);
    setBalanceError(null);
    setTransactionError(null);
    setCancelConfirmed(false);
    setBalanceInvocation({ invoked: false, attemptedAt: null, method: null });
    setTransactionInvocation({ invoked: false, attemptedAt: null, method: null, preflightPassed: false });
    let activeStage = "verify_owner";
    try {
      const ownerId = currentAccountId(connectedAddress);
      if (!ownerId || ownerId !== BOOTSTRAP_PREVIEW_OWNER_ID) {
        throw Object.assign(new Error("Connect the configured owner wallet to continue."), { stage: "verify_owner" });
      }
      activeStage = "construct_request";
      const prepared = prepareBootstrapFundingWalletRequest({
        vaultHex: BOOTSTRAP_PREVIEW_VAULT_ID,
        senderAccountIdHex: ownerId,
        senderWalletAddress: connectedAddress,
        nativeFaucetHex: NATIVE_FEE_FAUCET_ID,
      });
      setRequest(prepared);
      activeStage = "public_preflight";
      setStage(activeStage);
      const checked = await preflightBootstrapPublic({ endpoint: TESTNET_ENDPOINTS[0], connectedAddress, request: prepared });
      setPublicPreflight(checked);

      // This is the only place requestAssets is called: directly from this explicit button action,
      // after owner, vault, note, fee faucet, scripts, amounts, and pairing have all passed.
      activeStage = "balance_authorization";
      setStage(activeStage);
      setBalanceInvocation({ invoked: true, attemptedAt: new Date().toISOString(), method: "requestAssets" });
      setBalanceState("request_pending");
      const assets = await requestAssets();
      const balance = nativeBalanceFromWalletAssets(assets, checked.nativeFeeFaucet);
      setNativeBalance(balance.toString());
      setBalanceAuth({ accountId: checked.ownerAccountId, address: connectedAddress, balance: balance.toString(), baseFee: checked.verificationBaseFee, at: new Date().toISOString() });
      try {
        const completed = completeBootstrapFundingPreflight(checked, balance);
        setPreflight(completed);
        setBalanceState("granted");
      } catch (cause) {
        const error = cause as { name?: string; message?: string; stage?: string };
        setBalanceError({ name: error.name ?? "Error", message: error.message ?? String(cause) });
        setBalanceState(error.stage === "fee_preflight" ? "insufficient" : "failed");
      }
    } catch (cause) {
      const error = cause as { name?: string; message?: string; stage?: string };
      const errorStage = error.stage ?? activeStage;
      setStage(errorStage);
      if (activeStage === "balance_authorization") {
        setBalanceError({ name: error.name ?? "Error", message: error.message ?? String(cause) });
        setBalanceState("rejected_or_unknown");
      } else {
        setBalanceError({ name: error.name ?? "Error", message: error.message ?? String(cause) });
        setBalanceState("failed");
      }
    } finally {
      inFlight.current = null;
      setBusy(false);
    }
  }

  async function previewTransaction() {
    if (inFlight.current || busy || !request || !balanceAuthorizationCurrent || !requestTransaction || !balanceAuth) return;
    inFlight.current = "transaction";
    setBusy(true);
    setTransactionState("preparing");
    setStage("refresh_public_preflight");
    setPostEvidence(null);
    setTransactionId(null);
    setTransactionError(null);
    setCancelConfirmed(false);
    setTransactionInvocation({ invoked: false, attemptedAt: null, method: null, preflightPassed: false });
    let activeStage = "refresh_public_preflight";
    try {
      const ownerId = currentAccountId(connectedAddress);
      if (!ownerId || ownerId !== balanceAuth.accountId || connectedAddress !== balanceAuth.address) {
        throw Object.assign(new Error("Wallet account changed; authorize its balance again."), { stage: "verify_owner" });
      }
      // Repeat all public gates and use the latest base fee immediately before the separate transaction action.
      const freshPublic = await preflightBootstrapPublic({ endpoint: TESTNET_ENDPOINTS[0], connectedAddress: connectedAddress!, request });
      const authorizedBalance = BigInt(balanceAuth.balance);
      const checked = completeBootstrapFundingPreflight(freshPublic, authorizedBalance);
      setPublicPreflight(freshPublic);
      setPreflight(checked);
      setStage("wallet_request_allowed");
      setTransactionState("request_pending");
      activeStage = "transaction_request";
      setTransactionInvocation({ invoked: true, attemptedAt: new Date().toISOString(), method: "requestTransaction", preflightPassed: true });
      const returnedId = await requestTransaction(request.walletRequest);
      const outcome = mapBootstrapWalletOutcome(returnedId);
      if (outcome.kind === "transaction_id_returned") {
        setTransactionId(outcome.transactionId);
        setTransactionState("transaction_id_returned");
        setStage("hard_stop_transaction_id_returned");
      } else {
        setTransactionState("resolved_without_id");
        setStage("wallet_resolved_without_transaction_id");
      }
    } catch (cause) {
      const error = cause as { name?: string; message?: string; stage?: string };
      setStage(error.stage ?? activeStage);
      setTransactionError({ name: error.name ?? "Error", message: error.message ?? String(cause) });
      if (activeStage === "transaction_request") setTransactionState("rejected_or_failed");
      else setTransactionState("idle");
    } finally {
      inFlight.current = null;
      setBusy(false);
    }
  }

  async function verifyCancel() {
    if (inFlight.current || busy || !request || !preflight || !cancelConfirmed || transactionId !== null) return;
    inFlight.current = "verification";
    setBusy(true);
    setStage("post_cancel_read_only_verification");
    setPostEvidence(null);
    try {
      const evidence = await verifyBootstrapAfterCancel({
        endpoint: TESTNET_ENDPOINTS[0],
        request: request.summary,
        manualCancelConfirmed: true,
        transactionId: null,
        vaultExecutionInvoked: false,
        publicRpcMutationInvoked: false,
        ownerNativeBefore: preflight.ownerNativeBalance,
      });
      setPostEvidence(evidence);
      setTransactionState(evidence.safeCancelConfirmed ? "verification_complete" : "verification_incomplete");
      setStage(evidence.safeCancelConfirmed ? "post_cancel_checks_passed" : "post_cancel_checks_not_conclusive");
    } catch (cause) {
      const error = cause as { name?: string; message?: string; stage?: string };
      setTransactionError({ name: error.name ?? "Error", message: error.message ?? String(cause) });
      setStage(error.stage ?? "post_cancel_read_only_verification");
      setTransactionState("verification_incomplete");
    } finally {
      inFlight.current = null;
      setBusy(false);
    }
  }

  const hardStop = transactionId !== null;
  const nativeBalanceText = balanceAuthorizationCurrent ? balanceAuth?.balance ?? "unknown" : "not authorized";
  const requiredNow = publicPreflight
    ? (BigInt(publicPreflight.sponsorshipAmount) + BigInt(publicPreflight.p2idAmount) + 17n * BigInt(publicPreflight.verificationBaseFee)).toString()
    : "unknown";
  const balanceCopy = balanceState === "request_pending"
    ? "Miden Wallet balance authorization is open; this is not approval of the bootstrap transaction."
    : balanceState === "granted"
      ? "Wallet asset visibility was authorized. No bootstrap transaction has been requested."
      : balanceState === "rejected_or_unknown"
        ? "Wallet asset authorization did not complete. No bootstrap transaction was requested."
        : balanceState === "insufficient"
          ? "The authorized native MIDEN balance is below the current required amount. Transaction preview is blocked."
          : balanceState === "failed"
            ? "Balance authorization or native-asset parsing failed. Transaction preview is blocked."
            : "Public and local safety checks run first; only then will this explicit action ask the wallet to disclose assets.";

  return <section className="bootstrap-diagnostic bootstrap-funding-preview" aria-labelledby="bootstrap-funding-preview-title">
    <p className="section-kicker">Development only · bootstrap prerequisite</p>
    <h2 id="bootstrap-funding-preview-title">Owner bootstrap funding preview</h2>
    <p>This diagnostic has two separate wallet actions. Balance visibility does not approve or create the bootstrap transaction.</p>
    <p className="diagnostic-warning"><strong>TEST ONLY — DO NOT APPROVE A TRANSACTION.</strong> The second action opens a transaction review; cancel it. This task never deploys the vault or executes a vault transaction.</p>
    <p>Expected owner: <code>{BOOTSTRAP_PREVIEW_OWNER_ID}</code><br />Undeployed vault candidate: <code>{BOOTSTRAP_PREVIEW_VAULT_ID}</code></p>
    <ul className="bootstrap-safety-list">
      <li>Wallet connected: {walletConnected ? "yes" : "no"}</li>
      <li>Connected address: {connectedAddress ?? "none"}</li>
      <li>Owner identity is checked canonically before either wallet action.</li>
      <li>Before balance authorization, the app confirms vault and both note IDs are absent, native fee faucet identity, current base fee, standard scripts, exact output count/amounts, and P2ID/sponsorship pairing.</li>
      <li>The transaction request contains only one native P2ID and its paired FeeSponsorship output. No deployment/config/activation/Heirbeat note or inherited asset is constructed.</li>
      <li>No client transaction execution or submit API is used.</li>
    </ul>
    <section aria-label="Wallet balance authorization">
      <h3>Step 1 · Authorize wallet balance check</h3>
      <p>This calls Miden Wallet's “Request Assets” API. Wallet 1.16.2 reads the connected account's fungible asset balances. Depending on the wallet's existing private-data permission, it may show a “Request Assets” approval screen or return the already-authorized data directly. This only discloses balances to the site; it does not sign a transaction, create notes, or submit a transaction.</p>
      <p>{balanceCopy}</p>
      <button className="button button-secondary" type="button" onClick={() => void authorizeBalance()} disabled={busy || hardStop || !walletConnected || !connectedAddress || !requestAssets || (balanceState === "granted" && balanceAuthorizationCurrent)}>
        {balanceState === "checking_public_preflight" ? "Checking public safety gates…" : balanceState === "request_pending" ? "Waiting for wallet balance approval…" : "Authorize wallet balance check"}
      </button>
      <div className="check-in-preflight" aria-label="Wallet balance preflight">
        <span>Public preflight passed <strong>{publicPreflight ? "yes" : "no"}</strong></span>
        <span>Balance authorization invoked <strong>{balanceInvocation.invoked ? "yes" : "no"}</strong></span>
        <span>Method <strong>{balanceInvocation.method ?? "none"}</strong></span>
        <span>Native MIDEN balance <strong>{nativeBalanceText}</strong></span>
        <span>Verification base fee <strong>{publicPreflight?.verificationBaseFee ?? "unknown"}</strong></span>
        <span>Required native amount <strong>{requiredNow}</strong></span>
        <span>Sufficient <strong>{preflight ? "yes" : balanceState === "insufficient" ? "no" : "unknown"}</strong></span>
      </div>
    </section>
    <section aria-label="Bootstrap transaction review">
      <h3>Step 2 · Preview bootstrap funding transaction</h3>
      <p>This separate action uses <code>requestTransaction</code> after a fresh public preflight and a sufficient wallet-authorized native balance. It does not repeat the asset request.</p>
      <button className="button button-primary" type="button" onClick={() => void previewTransaction()} disabled={busy || hardStop || !request || !requestTransaction || !balanceAuthorizationCurrent || !preflight || balanceState !== "granted"}>
        {transactionState === "preparing" ? "Refreshing public preflight…" : transactionState === "request_pending" ? "Waiting for transaction review…" : "Preview bootstrap funding transaction"}
      </button>
    </section>
    {!walletConnected && <p role="status">Connect the configured owner wallet to enable the diagnostic.</p>}
    <div className="check-in-operation" aria-live="polite">
      <strong>Balance authorization: {balanceState.replaceAll("_", " ")}</strong>
      <p>Transaction preview: {transactionState.replaceAll("_", " ")}</p>
      {stage && <p>Stage: {stage}</p>}
      {preflight && <div className="check-in-preflight" aria-label="Bootstrap fee calculation">
        <span>Reference block <strong>{preflight.referenceBlock}</strong></span>
        <span>Verification base fee <strong>{preflight.verificationBaseFee}</strong></span>
        <span>Native wallet balance <strong>{preflight.ownerNativeBalance}</strong></span>
        <span>P2ID output <strong>{preflight.p2idAmount}</strong></span>
        <span>Sponsorship output <strong>{preflight.sponsorshipAmount}</strong></span>
        <span>Reserved wallet fee (17× base fee) <strong>{preflight.feeReserve}</strong></span>
        <span>Total required <strong>{preflight.requiredNativeBalance}</strong></span>
      </div>}
      {request && <div className="bootstrap-preview-evidence">
        <p>Owner sender: <code>{request.summary.walletEnvelope.sender}</code></p>
        <p>Vault target: <code>{request.summary.targetVaultId}</code></p>
        <p>P2ID note ID: <code>{request.summary.featureNoteId}</code></p>
        <p>Sponsorship note ID: <code>{request.summary.sponsorshipNoteId}</code></p>
        <p>Pairing: {request.summary.sponsorshipFeatureNoteId === request.summary.featureNoteId ? "valid — sponsorship references this P2ID" : "invalid"}</p>
        <p>Outputs: {request.summary.outputNoteCount} · native outputs: {request.summary.requiredNativeOutputs}</p>
      </div>}
      {(transactionState === "resolved_without_id" || transactionState === "rejected_or_failed") && <>
        <p>Wallet call ended without a transaction ID; chain state is not established. Confirm the manual Cancel/Reject before running read-only checks.</p>
        <label className="preview-cancel-confirm"><input type="checkbox" checked={cancelConfirmed} onChange={(event) => setCancelConfirmed(event.currentTarget.checked)} /> I saw the transaction review and explicitly clicked Cancel/Reject.</label>
        <button className="button button-secondary" type="button" onClick={() => void verifyCancel()} disabled={busy || !cancelConfirmed}>I canceled the transaction review — verify read-only</button>
      </>}
      {transactionState === "rejected_or_failed" && <p>The transaction wallet request rejected or failed. That result alone does not prove cancellation or non-submission.</p>}
      {transactionState === "transaction_id_returned" && <p role="alert">A transaction ID was returned. Stop here; do not retry or continue bootstrap.</p>}
      {postEvidence && <div className="bootstrap-preview-evidence"><p>Post-cancel classification: <strong>{postEvidence.classification}</strong></p><p>Manual transaction cancel confirmed: {postEvidence.manualCancelConfirmed ? "yes" : "no"}</p><p>Vault exists: {postEvidence.vaultExists ? "yes — unexpected" : "no"}</p><p>P2ID status: {postEvidence.featureNoteStatus}</p><p>Sponsorship status: {postEvidence.sponsorshipNoteStatus}</p><p>Private owner balance re-read: {postEvidence.ownerNativeBalanceUnchanged === null ? "unavailable through public RPC; not re-requested" : postEvidence.ownerNativeBalanceUnchanged ? "unchanged" : "changed"}</p><p>{postEvidence.safeCancelConfirmed ? "Read-only evidence confirms cancellation without chain mutation." : "Evidence is incomplete or unexpected; do not retry or continue bootstrap."}</p></div>}
      {balanceError && <details className="developer-details"><summary>Balance authorization diagnostics</summary><code>{balanceError.name}: {balanceError.message}</code></details>}
      {transactionError && <details className="developer-details"><summary>Transaction preview diagnostics</summary><code>{transactionError.name}: {transactionError.message}</code></details>}
      <details className="developer-details"><summary>Plain preview evidence</summary><pre>{JSON.stringify({ balanceState, transactionState, stage, request: request?.summary ?? null, publicPreflight, preflight, nativeBalance, balanceAuth, transactionId, postEvidence, connectedAddress, canonicalConnectedAccount: canonicalAddress, expectedOwner: BOOTSTRAP_PREVIEW_OWNER_ID, balanceInvocation, transactionInvocation, manualTransactionCancelConfirmed: cancelConfirmed, walletTransactionOnly: true, vaultExecutionInvoked: false, publicRpcMutationInvoked: false }, null, 2)}</pre></details>
    </div>
  </section>;
}

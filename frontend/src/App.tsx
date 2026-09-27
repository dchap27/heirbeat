import { useEffect, useMemo, useRef, useState } from "react";
import {
  PrivateDataPermission,
  WalletAdapterNetwork,
  WalletDisconnectButton,
  WalletReadyState,
  useWallet,
} from "@miden-sdk/miden-wallet-adapter";
import type { MidenClient } from "@miden-sdk/miden-sdk";
import { deriveLifecycle, deriveRole, normalizeAccountId } from "./domain/lifecycle";
import type { VaultSnapshot } from "./domain/types";
import { buildFeaturePair, type FeatureKind } from "./heirbeat/feature-notes";
import { readVault, readVaultFromRpc } from "./heirbeat/vault";
import { createReadOnlyClient, getBlockHeader } from "./miden/client";
import { KNOWN_VAULT_ID, TESTNET_ENDPOINTS } from "./miden/endpoints";
import { readNtxStatus } from "./miden/ntx";
import { makeWalletTransactionRequest } from "./miden/wallet-request";
import {
  heartbeatPreviewSafety,
  buildTerminalHeartbeatPreview,
  buildDisposableP2idPreview,
  canStartPreview,
  canPreviewDisposableP2id,
  mapPreviewResult,
  pendingPreviewResult,
  HEARTBEAT_PREVIEW_DESCRIPTION,
  TERMINAL_PREVIEW_VAULT,
} from "./miden/wallet-preview";
import { inspectNoteIndependently, inspectPreviewEvidence, probeKnownNetworkNoteStatus } from "./miden/preview-evidence";
import { planWalletConnectStep } from "./miden/connect-flow";

function pretty(value: unknown): string {
  return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

export function App() {
  const wallet = useWallet();
  const [endpoint, setEndpoint] = useState<string>(TESTNET_ENDPOINTS[0]);
  const [vaultId, setVaultId] = useState(KNOWN_VAULT_ID);
  const [client, setClient] = useState<MidenClient | null>(null);
  const [block, setBlock] = useState<number | null>(null);
  const [nativeFeeFaucet, setNativeFeeFaucet] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<VaultSnapshot | null>(null);
  const [featureKind, setFeatureKind] = useState<FeatureKind>("heartbeat");
  const [noteId, setNoteId] = useState("0x09fa485089bbabe66442911374d4abbb48afbb6410fa39ad20bb62229ff16b00");
  const [ntxResult, setNtxResult] = useState("not queried");
  const [ntxError, setNtxError] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [networkState, setNetworkState] = useState("not initialized");
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [walletSelectionPending, setWalletSelectionPending] = useState(false);
  const [walletConnectDiagnostic, setWalletConnectDiagnostic] = useState<unknown>(null);
  const [walletPreview, setWalletPreview] = useState<{ kind: string; noteIds: string[]; result: ReturnType<typeof mapPreviewResult>; before: string[] } | null>(null);
  const [previewVerification, setPreviewVerification] = useState<unknown>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [preparedHeartbeat, setPreparedHeartbeat] = useState<{
    sender: string;
    pair: Awaited<ReturnType<typeof buildFeaturePair>>;
    walletRequest: ReturnType<typeof makeWalletTransactionRequest>;
    before: string[];
  } | null>(null);
  const [preparedP2id, setPreparedP2id] = useState<{
    recipient: string;
    fixture: ReturnType<typeof buildDisposableP2idPreview>;
    before: string[];
  } | null>(null);
  const [prepareResult, setPrepareResult] = useState<unknown>(null);
  const attemptedPreviews = useRef(new Set<string>());
  const previewBaselineTransactions = useRef<Record<string, string[]>>({});
  const pendingWalletConnect = useRef<string | null>(null);
  const clientStoreKey = useMemo(() => `heirbeat-browser-spike-${new URL(endpoint).host}`, [endpoint]);

  async function run<T>(task: () => Promise<T>, onSuccess: (result: T) => void, onError?: (message: string) => void) {
    setBusy(true);
    setError(null);
    try { onSuccess(await task()); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      onError?.(message);
    }
    finally { setBusy(false); }
  }

  async function connectSelectedWallet() {
    setWalletError(null);
    const adapter = wallet.wallet?.adapter ?? null;
    setWalletConnectDiagnostic({
      stage: "connect called after adapter selection",
      selectedWallet: adapter?.name ?? null,
      adapterConnectedBefore: adapter?.connected ?? false,
      adapterAddressBefore: adapter?.address ?? null,
      walletContextConnectedBefore: wallet.connected,
      walletContextAddressBefore: wallet.address,
    });
    const detected = wallet.wallets.find((candidate) => candidate.readyState === WalletReadyState.Installed || candidate.readyState === WalletReadyState.Loadable);
    if (!detected) {
      const message = "No supported Miden wallet was detected. Install/enable the official Miden Wallet and retry.";
      setWalletError(message);
      setError(message);
      setWalletConnectDiagnostic({ stage: "failed before connect", error: message });
      return;
    }
    try {
      await wallet.connect(PrivateDataPermission.UponRequest, WalletAdapterNetwork.Testnet);
      setError(null);
      setWalletConnectDiagnostic({
        stage: "connected",
        selectedWallet: adapter?.name ?? null,
        adapterConnected: adapter?.connected ?? false,
        adapterAddress: adapter?.address ?? null,
        walletContextConnected: wallet.connected,
        walletContextAddress: wallet.address,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setWalletError(message);
      setError(message);
      const error = cause as { name?: string; message?: string; error?: { name?: string; message?: string } };
      setWalletConnectDiagnostic({
        stage: "connect rejected",
        selectedWallet: adapter?.name ?? null,
        adapterConnected: adapter?.connected ?? false,
        adapterAddress: adapter?.address ?? null,
        walletContextConnected: wallet.connected,
        walletContextAddress: wallet.address,
        errorName: error.name ?? null,
        errorMessage: error.message ?? message,
        innerErrorName: error.error?.name ?? null,
        innerErrorMessage: error.error?.message ?? null,
      });
    }
  }

  useEffect(() => {
    const pendingName = pendingWalletConnect.current;
    if (!pendingName || wallet.wallet?.adapter.name !== pendingName) return;
    pendingWalletConnect.current = null;
    setWalletSelectionPending(false);
    void connectSelectedWallet();
  }, [wallet.wallet]);

  function connectWallet() {
    setWalletError(null);
    const detected = wallet.wallets.find((candidate) => candidate.readyState === WalletReadyState.Installed || candidate.readyState === WalletReadyState.Loadable);
    if (!detected) {
      const message = "No supported Miden wallet was detected. Install/enable the official Miden Wallet and retry.";
      setWalletError(message);
      setError(message);
      setWalletConnectDiagnostic({ stage: "failed before selection", error: message });
      return;
    }

    const step = planWalletConnectStep(wallet.wallet?.adapter.name ?? null, detected.adapter.name);
    if (step.kind === "select") {
      pendingWalletConnect.current = step.walletName;
      setWalletSelectionPending(true);
      setWalletConnectDiagnostic({
        stage: "selecting wallet; waiting for WalletProvider state",
        discoveredWallets: wallet.wallets.map(({ adapter, readyState }) => ({ name: adapter.name, readyState })),
        selectedWalletBefore: wallet.wallet?.adapter.name ?? null,
        selectedWalletRequested: step.walletName,
        connectedBefore: wallet.connected,
        addressBefore: wallet.address,
      });
      wallet.select(step.walletName);
      return;
    }

    if (step.kind === "connect") void connectSelectedWallet();
  }

  async function connectClient() {
    setNetworkState("initializing and syncing");
    setNetworkError(null);
    await run(async () => {
      const created = await createReadOnlyClient(endpoint);
      const syncedBlock = await created.getSyncHeight();
      const header = await getBlockHeader(endpoint, syncedBlock);
      return { created, syncedBlock, feeFaucet: header.feeFaucetId().toString(), baseFee: header.verificationBaseFee() };
    }, ({ created, syncedBlock, feeFaucet, baseFee }) => {
      client?.terminate();
      setClient(created);
      setBlock(syncedBlock);
      setNativeFeeFaucet(feeFaucet);
      setNetworkState("synced");
      setSnapshot(null);
      setDiagnostic({ endpoint, syncedBlock, nativeFeeFaucet: feeFaucet, verificationBaseFee: baseFee, store: clientStoreKey });
    }, (message) => {
      setNetworkState("failed");
      setNetworkError(message);
    });
  }

  async function loadVault() {
    if (!client) return setError("Connect and sync the browser client first.");
    setVaultError(null);
    await run(async () => {
      const syncedBlock = await client.getSyncHeight();
      if (!nativeFeeFaucet) throw new Error("Sync a block header before reading native fee balance.");
      const result = await readVault(client, vaultId, syncedBlock, nativeFeeFaucet);
      return { result, syncedBlock };
    }, ({ result, syncedBlock }) => {
      setSnapshot(result);
      setBlock(syncedBlock);
      setDiagnostic({ account: result.accountId, block: syncedBlock, lifecycle: deriveLifecycle(result) });
    }, setVaultError);
  }

  async function constructNotes() {
    if (!snapshot) return setError("Read a vault before constructing local notes.");
    const sender = featureKind === "claim" ? snapshot.beneficiary : snapshot.owner;
    const isDeposit = featureKind === "deposit";
    const amount = isDeposit ? 1n : undefined;
    await run(() => buildFeaturePair({
      kind: featureKind,
      sender,
      vault: snapshot.accountId,
      inheritedFaucet: snapshot.faucet,
      nativeFaucet: snapshot.nativeFeeFaucet,
      sponsorshipAmount: featureKind === "activation" ? 120n : 150n,
      ...(amount !== undefined ? { depositAmount: amount } : {}),
    }), (pair) => {
      const allowlisted = snapshot.noteAllowlist.some((root) => root.toLowerCase() === pair.info.featureRoot.toLowerCase());
      const walletRequest = makeWalletTransactionRequest(sender, snapshot.accountId, pair.request);
      const customPayload = walletRequest.payload as { transactionRequest?: string };
      setDiagnostic({
        mode: "local-only; nothing submitted",
        allowlistedOnLoadedVault: allowlisted,
        feature: pair.info,
        featureIsNetworkNote: pair.feature.isNetworkNote(),
        featureSerializedBytes: pair.feature.serialize().length,
        sponsorshipSerializedBytes: pair.sponsorship.serialize().length,
        walletRequest: {
          type: walletRequest.type,
          serializedRequestBytes: customPayload.transactionRequest?.length ?? 0,
          adapterMethodAvailable: typeof wallet.requestTransaction === "function",
        },
      });
    });
  }

  async function checkNtx() {
    if (!client || !noteId) return setError("Connect the client and enter a committed network-note ID.");
    setNtxError(null);
    await run(() => readNtxStatus(endpoint, noteId), (status) => {
      const result = `${status.status} (attempts: ${status.attemptCount}, last block: ${status.lastAttemptBlockNum})`;
      setNtxResult(result);
      setDiagnostic({ noteId, status: status.status, attemptCount: status.attemptCount, lastAttemptBlockNum: status.lastAttemptBlockNum, lastError: status.lastError });
    }, (message) => {
      setNtxResult("query failed");
      setNtxError(message);
    });
  }

  async function latestTerminalSnapshot() {
    if (!client || !nativeFeeFaucet) throw new Error("Initialize and sync the browser client first.");
    await client.syncChain();
    const currentBlock = await client.getSyncHeight();
    const latest = await readVault(client, TERMINAL_PREVIEW_VAULT, currentBlock, nativeFeeFaucet);
    setBlock(currentBlock);
    setSnapshot(latest);
    return latest;
  }

  async function localVaultTransactionIds(targetVault: string): Promise<string[]> {
    if (!client) return [];
    const records = await client.transactions.list();
    try {
      return records.filter((record) => record.accountId().toString().toLowerCase() === targetVault.toLowerCase())
        .map((record) => record.id().toString());
    } finally { records.forEach((record) => record.free()); }
  }

  async function prepareWalletPreviews() {
    if (previewBusy || busy) return;
    setPreviewBusy(true);
    setPreparedHeartbeat(null);
    setPreparedP2id(null);
    setPrepareResult(null);
    setPreviewVerification(null);
    try {
      if (!client || !wallet.connected || !wallet.address) throw new Error("Initialize/sync the browser client and connect a wallet first.");
      const fresh = await latestTerminalSnapshot();
      const heartbeatSafety = heartbeatPreviewSafety(fresh, wallet.address);
      let heartbeat: { prepared: boolean; reason?: string; featureNoteId?: string; sponsorshipNoteId?: string };
      if (heartbeatSafety.enabled) {
        const before = await localVaultTransactionIds(fresh.accountId);
        const built = await buildTerminalHeartbeatPreview(fresh, wallet.address);
        setPreparedHeartbeat({ sender: normalizeAccountId(wallet.address), ...built, before });
        heartbeat = { prepared: true, featureNoteId: built.pair.info.featureId, sponsorshipNoteId: built.pair.info.sponsorshipId };
      } else {
        heartbeat = { prepared: false, reason: "Requires the known activated, claimed, empty vault and a connected account different from its owner." };
      }

      let p2id: { prepared: boolean; reason?: string; noteId?: string; committedOnChain?: boolean };
      if (fresh.accountId.toLowerCase() !== TERMINAL_PREVIEW_VAULT || !fresh.activated || !fresh.claimed || fresh.inheritedBalance !== 0n) {
        p2id = { prepared: false, reason: "Requires the known activated, claimed, empty test vault." };
      } else {
        const before = await localVaultTransactionIds(fresh.accountId);
        const fixture = buildDisposableP2idPreview({ sender: fresh.accountId, beneficiary: wallet.address, faucet: fresh.faucet });
        const noteCheck = await inspectPreviewEvidence(endpoint, [fixture.noteId]);
        if (!canPreviewDisposableP2id(noteCheck.noteQueries[0]?.result)) {
          p2id = { prepared: false, reason: `Could not prove the synthetic note is absent from chain (${noteCheck.noteQueries[0]?.result ?? "no result"}); wallet request remains disabled.`, noteId: fixture.noteId };
        } else {
          setPreparedP2id({ recipient: normalizeAccountId(wallet.address), fixture, before });
          p2id = { prepared: true, noteId: fixture.noteId, committedOnChain: false };
        }
      }
      setPrepareResult({
        connectedAccount: wallet.address,
        configuredOwner: fresh.owner,
        configuredBeneficiary: fresh.beneficiary,
        heartbeatSafety,
        heartbeat,
        p2id,
      });
    } catch (cause) {
      setPrepareResult({ error: cause instanceof Error ? cause.message : String(cause) });
    } finally { setPreviewBusy(false); }
  }

  async function previewHeirbeatRequest() {
    if (!canStartPreview(attemptedPreviews.current.has("heirbeat"), previewBusy || busy)) return;
    setPreviewBusy(true);
    setWalletPreview(null);
    setPreviewVerification(null);
    let noteIds: string[] = [];
    let walletCallStarted = false;
    try {
      if (!wallet.connected || !wallet.address || !preparedHeartbeat) throw new Error("Connect a wallet and prepare a safe heartbeat preview first.");
      const fresh = await latestTerminalSnapshot();
      const safety = heartbeatPreviewSafety(fresh, wallet.address);
      if (!safety.enabled || normalizeAccountId(wallet.address) !== preparedHeartbeat.sender) throw new Error("Heartbeat preview safety checks changed; prepare the request again.");
      const { pair, walletRequest: request, before } = preparedHeartbeat;
      noteIds = [pair.info.featureId, pair.info.sponsorshipId];
      previewBaselineTransactions.current.heirbeat = before;
      setDiagnostic({
        mode: "manual wallet preview; do not approve",
        featureKind: "heartbeat",
        featureNoteId: pair.info.featureId,
        sponsorshipNoteId: pair.info.sponsorshipId,
        sponsorshipAmount: pair.info.sponsorshipAmount,
        target: pair.info.targetId,
        executionHint: pair.info.executionHint,
        sender: wallet.address,
        terminalVault: fresh.accountId,
        transactionRequestType: request.type,
      });
      if (!wallet.requestTransaction) throw new Error("Connected wallet adapter does not expose requestTransaction.");
      attemptedPreviews.current.add("heirbeat");
      walletCallStarted = true;
      setWalletPreview({ kind: "Heirbeat heartbeat", noteIds, result: pendingPreviewResult(), before });
      const transactionId = await wallet.requestTransaction(request);
      setWalletPreview({ kind: "Heirbeat heartbeat", noteIds, result: mapPreviewResult({ transactionId }), before });
    } catch (cause) {
      const result = mapPreviewResult(null, cause, walletCallStarted);
      setWalletPreview({ kind: "Heirbeat heartbeat", noteIds, result, before: previewBaselineTransactions.current.heirbeat ?? [] });
      if (walletCallStarted) setWalletError(result.error ?? null);
    } finally { setPreviewBusy(false); }
  }

  async function previewP2idRequest() {
    if (!canStartPreview(attemptedPreviews.current.has("p2id"), previewBusy || busy)) return;
    setPreviewBusy(true);
    setWalletPreview(null);
    setPreviewVerification(null);
    let noteIds: string[] = [];
    let walletCallStarted = false;
    try {
      if (!client || !wallet.connected || !wallet.address || !preparedP2id) throw new Error("Initialize/sync the client, connect a wallet, and prepare the safe synthetic P2ID request first.");
      const fresh = await latestTerminalSnapshot();
      if (fresh.accountId.toLowerCase() !== TERMINAL_PREVIEW_VAULT || !fresh.activated || !fresh.claimed || fresh.inheritedBalance !== 0n) {
        throw new Error("P2ID request preview requires the known terminal, empty test vault.");
      }
      if (normalizeAccountId(wallet.address) !== preparedP2id.recipient) throw new Error("Connected wallet changed; prepare the synthetic P2ID request again.");
      const { before, fixture } = preparedP2id;
      const noteCheck = await inspectPreviewEvidence(endpoint, [fixture.noteId]);
      if (!canPreviewDisposableP2id(noteCheck.noteQueries[0]?.result)) throw new Error("Synthetic P2ID note is no longer proven absent from chain; wallet call was not made.");
      previewBaselineTransactions.current.p2id = before;
      noteIds = [fixture.noteId];
      setDiagnostic({
        mode: "manual wallet preview; do not approve",
        requestType: "P2ID consume",
        noteId: fixture.noteId,
        committedOnChain: fixture.committedOnChain,
        amount: fixture.amount,
        asset: fresh.faucet,
        recipient: wallet.address,
        noteBytesIncluded: Boolean(fixture.request.noteBytes),
      });
      if (!wallet.requestConsume) throw new Error("Connected wallet adapter does not expose requestConsume.");
      attemptedPreviews.current.add("p2id");
      walletCallStarted = true;
      setWalletPreview({ kind: "synthetic P2ID consume", noteIds, result: pendingPreviewResult(), before });
      const transactionId = await wallet.requestConsume(fixture.request);
      setWalletPreview({ kind: "synthetic P2ID consume", noteIds, result: mapPreviewResult({ transactionId }), before });
    } catch (cause) {
      const result = mapPreviewResult(null, cause, walletCallStarted);
      setWalletPreview({ kind: "synthetic P2ID consume", noteIds, result, before: previewBaselineTransactions.current.p2id ?? [] });
      if (walletCallStarted) setWalletError(result.error ?? null);
    } finally { setPreviewBusy(false); }
  }

  async function verifyPreviewAfterReject() {
    if (!walletPreview) return;
    setPreviewBusy(true);
    setPreviewVerification(null);
    let vaultVerification: Record<string, unknown>;
    try {
      const { snapshot: fresh, syncedBlock: currentBlock } = await readVaultFromRpc(endpoint, TERMINAL_PREVIEW_VAULT);
      const checks = {
        correctVault: fresh.accountId.toLowerCase() === TERMINAL_PREVIEW_VAULT,
        activated: fresh.activated,
        claimed: fresh.claimed,
        inheritedBalanceZero: fresh.inheritedBalance === 0n,
        ownerUnchanged: Boolean(snapshot && fresh.owner === snapshot.owner),
        beneficiaryUnchanged: Boolean(snapshot && fresh.beneficiary === snapshot.beneficiary),
        faucetUnchanged: Boolean(snapshot && fresh.faucet === snapshot.faucet),
        noteAllowlistUnchanged: Boolean(snapshot && JSON.stringify(fresh.noteAllowlist) === JSON.stringify(snapshot.noteAllowlist)),
        transactionScriptAllowlistUnchanged: Boolean(snapshot && JSON.stringify(fresh.transactionScriptAllowlist) === JSON.stringify(snapshot.transactionScriptAllowlist)),
      };
      setSnapshot(fresh);
      setBlock(currentBlock);
      vaultVerification = {
        outcome: "success",
        syncedBlock: currentBlock,
        vaultExists: true,
        vaultAccountId: fresh.accountId,
        checks,
        allChecksPassed: Object.values(checks).every(Boolean),
      };
    } catch (cause) {
      vaultVerification = {
        outcome: "failed",
        stage: "read fresh block header and vault account over public RPC",
        errorName: (cause as { name?: string })?.name ?? "UnknownError",
        errorMessage: cause instanceof Error ? cause.message : String(cause),
      };
      setPreviewVerification({
        vault: vaultVerification,
        historicalHeartbeatStatus: { outcome: "not_run", reason: "Vault read failed independently." },
        noteQueries: { outcome: "not_run", reason: "Vault read failed independently." },
        walletReturnedTransactionId: walletPreview.result.transactionId,
        walletReturnedNoTransactionId: walletPreview.result.transactionId === null,
      });
      setPreviewBusy(false);
      return;
    }

    // Publish vault verification before note queries. A failing note API must
    // never erase a successful independent chain-state check.
    setPreviewVerification({
      vault: vaultVerification,
      historicalHeartbeatStatus: { outcome: "querying" },
      noteQueries: { outcome: "querying" },
      walletReturnedTransactionId: walletPreview.result.transactionId,
      walletReturnedNoTransactionId: walletPreview.result.transactionId === null,
      transactionHistory: "not_available_from_public_rpc",
      transactionHistoryLimitation: "Public RpcClient does not expose complete per-account transaction history.",
    });
    const capture = async (task: () => Promise<unknown>) => {
      try { return { outcome: "success", result: await task() }; }
      catch (cause) {
        return {
          outcome: "failed",
          errorName: (cause as { name?: string })?.name ?? "UnknownError",
          errorMessage: cause instanceof Error ? cause.message : String(cause),
        };
      }
    };
    const [historicalHeartbeatStatus, feature, sponsorship] = await Promise.all([
      capture(() => probeKnownNetworkNoteStatus(
        endpoint,
        "0x92da7ad5fad0defb64bf847dc49f7320b443bbcbeb1d4f71a9fadc318254f680",
      )),
      capture(() => inspectNoteIndependently(endpoint, "feature", walletPreview.noteIds[0] ?? "")),
      capture(() => inspectNoteIndependently(endpoint, "sponsorship", walletPreview.noteIds[1] ?? "")),
    ]);
    setPreviewVerification({
      vault: vaultVerification,
      historicalHeartbeatStatus,
      noteQueries: { feature, sponsorship },
      walletReturnedTransactionId: walletPreview.result.transactionId,
      walletReturnedNoTransactionId: walletPreview.result.transactionId === null,
      transactionHistory: "not_available_from_public_rpc",
      transactionHistoryLimitation: "Public RpcClient does not expose complete per-account transaction history.",
    });
    setPreviewBusy(false);
  }

  const derived = snapshot ? { ...deriveLifecycle(snapshot), role: deriveRole(wallet.address, snapshot.owner, snapshot.beneficiary) } : null;
  const detection = wallet.wallets[0]?.readyState ?? WalletReadyState.Unsupported;
  const walletDetected = wallet.wallets.some((candidate) => candidate.readyState === WalletReadyState.Installed || candidate.readyState === WalletReadyState.Loadable);
  const previewSafety = snapshot ? heartbeatPreviewSafety(snapshot, wallet.connected ? wallet.address : null) : null;

  return (
    <main className="shell">
      <header className="topbar">
        <div><p className="eyebrow">Miden v0.16 · read-only browser spike</p><h1>Heirbeat browser boundary check</h1></div>
        <div className="wallet-controls">
          {wallet.connected ? <><span className="wallet-address">{wallet.address}</span><WalletDisconnectButton /></> : <button onClick={connectWallet} disabled={wallet.connecting || walletSelectionPending || busy}>{walletSelectionPending ? "Selecting wallet…" : wallet.connecting ? "Connecting…" : "Connect Miden wallet"}</button>}
          <span className="muted">Wallet detection: {detection}</span>
        </div>
      </header>

      <p className="notice">Diagnostic only. Wallet signing stays user-controlled. The preview buttons below open wallet requests; DO NOT APPROVE. Reject/cancel in Miden Wallet.</p>
      {error && <p className="error" role="alert">{error}</p>}

      <section className="panel">
        <h2>Browser client and explicit vault read</h2>
        <div className="grid">
          <Value name="RPC endpoint" value={endpoint} />
          <Value name="Miden Web SDK runtime" value={client ? "loaded; client initialized" : "loaded; client not initialized"} />
          <Value name="IndexedDB API / client store" value={`${typeof indexedDB === "undefined" ? "unavailable" : "available"} / ${client ? "initialized" : "not initialized"}`} />
          <Value name="Sync state / reference block" value={`${networkState} / ${block ?? "unavailable"}`} />
          <Value name="Last network error" value={networkError ?? "none"} />
        </div>
        <div className="controls">
          <label>Testnet RPC<select value={endpoint} onChange={(event) => setEndpoint(event.target.value)}>{TESTNET_ENDPOINTS.map((url) => <option key={url}>{url}</option>)}</select></label>
          <button onClick={connectClient} disabled={busy}>{busy ? "Working…" : "Initialize + sync chain"}</button>
        </div>
        <div className="controls">
          <label>Vault AccountId<input value={vaultId} onChange={(event) => setVaultId(event.target.value)} /></label>
          <button onClick={loadVault} disabled={!client || busy}>Read vault state</button>
        </div>
        <p className="muted">Client store: {clientStoreKey} · synced block: {block ?? "not synced"}</p>
        {snapshot && derived && <div className="grid">
          <Value name="Lifecycle / role" value={`${derived.lifecycle} / ${derived.role}`} />
          <Value name="Owner" value={snapshot.owner} />
          <Value name="Beneficiary" value={snapshot.beneficiary} />
          <Value name="Faucet / inherited balance" value={`${snapshot.faucet} / ${snapshot.inheritedBalance}`} />
          <Value name="Timeout / last heartbeat" value={`${snapshot.timeoutBlocks} / ${snapshot.lastCheckIn}`} />
          <Value name="Deadline / remaining" value={`${derived.deadline} / ${derived.remainingBlocks}`} />
          <Value name="Activated / claimed" value={`${snapshot.activated} / ${snapshot.claimed}`} />
          <Value name="Native fee asset / balance" value={`${snapshot.nativeFeeFaucet} / ${snapshot.nativeBalance}`} />
          <Value name="Note roots" value={snapshot.noteAllowlist.join("\n")} />
          <Value name="Transaction-script roots" value={snapshot.transactionScriptAllowlist.join("\n")} />
        </div>}
        <Value name="Vault read error" value={vaultError ?? "none"} />
      </section>

      <section className="panel">
        <h2>Wallet and adapter runtime</h2>
        <div className="grid">
          <Value name="Wallet adapter context" value="initialized" />
          <Value name="Wallet detected / readiness" value={`${walletDetected} / ${detection}`} />
          <Value name="Connection state" value={wallet.connected ? "connected" : "disconnected"} />
          <Value name="Selected wallet" value={wallet.wallet?.adapter.name ?? "none"} />
          <Value name="Connected AccountId" value={wallet.address ?? "none"} />
          <Value name="Last wallet error" value={walletError ?? "none"} />
        </div>
        {walletConnectDiagnostic !== null && <>
          <h3>Connection lifecycle diagnostics</h3>
          <pre>{pretty(walletConnectDiagnostic)}</pre>
        </>}
      </section>

      <section className="panel preview-panel">
        <h2>Manual wallet request previews</h2>
        <p className="danger-notice"><strong>TEST ONLY — {previewSafety?.connectedAccountDiffersFromOwner ? "CONNECTED WALLET IS NOT THE VAULT OWNER" : "CONNECT A NON-OWNER WALLET"} — TARGET VAULT IS ALREADY CLAIMED — REJECT/CANCEL IN MIDEN WALLET — DO NOT APPROVE.</strong> These calls are never automatic and run once per page session. A wallet-returned transaction ID means the wallet accepted/queued a request; stop immediately. A rejected promise does not by itself prove that no chain event occurred.</p>
        <p className="muted">The connected wallet is not being treated as the vault owner. Heartbeat uses the connected AccountId as the note sender, so owner authorization must fail; the target is already claimed. Production authorization and protocol code are unchanged.</p>
        <div className="controls">
          <button onClick={prepareWalletPreviews} disabled={!client || !snapshot || !wallet.connected || previewBusy || busy}>Prepare local preview requests</button>
          <button onClick={previewHeirbeatRequest} disabled={!client || !snapshot || !wallet.connected || !preparedHeartbeat || previewBusy || attemptedPreviews.current.has("heirbeat")}>
            Preview Heirbeat request — REJECT IN WALLET
          </button>
          <button onClick={previewP2idRequest} disabled={!client || !snapshot || !wallet.connected || !preparedP2id || !wallet.address || (() => { try { return preparedP2id.recipient !== normalizeAccountId(wallet.address); } catch { return true; } })() || previewBusy || attemptedPreviews.current.has("p2id")}>
            Preview P2ID consume request — REJECT IN WALLET
          </button>
        </div>
        <div className="grid">
          <Value name="Safety: wallet connected" value={wallet.connected ? "✓" : "✗ Connect Miden Wallet"} />
          <Value name="Safety: terminal target loaded" value={snapshot?.accountId === TERMINAL_PREVIEW_VAULT ? "✓" : "✗ Load the known vault"} />
          <Value name="Safety: vault activated and claimed" value={snapshot?.activated && snapshot.claimed ? "✓" : "✗ Vault must be claimed"} />
          <Value name="Safety: connected sender differs from owner" value={previewSafety?.connectedAccountDiffersFromOwner ? "✓" : "✗ Owner account cannot run this diagnostic"} />
          <Value name="Heartbeat request constructed" value={preparedHeartbeat ? `✓ sender ${preparedHeartbeat.sender}` : "not prepared"} />
          <Value name="Synthetic P2ID note absent from chain" value={preparedP2id ? "✓ local 1-unit fixture; node lookup returned no committed note" : "not prepared; uncertain lookup keeps wallet request disabled"} />
        </div>
        <p className="muted">Preparation is local except for a read-only node lookup to prove the synthetic P2ID note ID is not committed. Wallet calls require a deliberate button click. The local CLI keystore is never accessed or exported.</p>
        {prepareResult !== null && <><h3>Preview preparation diagnostics</h3><pre>{pretty(prepareResult)}</pre></>}
        <p className="muted">{HEARTBEAT_PREVIEW_DESCRIPTION} If accidentally approved, the wallet transaction may still commit its feature and sponsorship notes, but the vault contract must reject the heartbeat. The P2ID preview is a local, uncommitted one-unit test note; it is not a historical payout and has no on-chain inclusion.</p>
        {walletPreview && <div className="grid">
          <Value name="Preview request type" value={walletPreview.kind} />
          <Value name="Wallet call started" value={walletPreview.result.callStarted} />
          <Value name="Wallet result" value={walletPreview.result.state} />
          <Value name="Wallet transaction ID" value={walletPreview.result.transactionId ?? "none returned"} />
          <Value name="Submission assessment" value={walletPreview.result.submissionAssessment} />
          <Value name="Result message / error" value={`${walletPreview.result.message}${walletPreview.result.error ? `\n${walletPreview.result.error}` : ""}`} />
          <Value name="Feature/test note IDs" value={walletPreview.noteIds.join("\n") || "not constructed"} />
          {walletPreview.result.transactionId === null && walletPreview.noteIds.length > 0 && <button onClick={verifyPreviewAfterReject} disabled={previewBusy}>Resync and inspect after wallet rejection</button>}
        </div>}
        {previewVerification !== null && <><h3>Post-rejection chain inspection</h3><pre>{pretty(previewVerification)}</pre></>}
      </section>

      <section className="panel">
        <h2>Local Heirbeat feature-note + sponsorship construction</h2>
        <p className="muted">Uses the current compiled .masp packages and official Web SDK note primitives. Construction computes local note IDs but does not submit them.</p>
        <div className="controls">
          <label>Operation<select value={featureKind} onChange={(event) => setFeatureKind(event.target.value as FeatureKind)}>{(["heartbeat", "deposit", "claim", "activation"] as FeatureKind[]).map((kind) => <option key={kind}>{kind}</option>)}</select></label>
          <button onClick={constructNotes} disabled={!snapshot || busy}>Construct and validate</button>
        </div>
      </section>

      <section className="panel">
        <h2>NTX status probe</h2>
        <p className="muted">Read-only GetNetworkNoteStatus via the Web SDK’s public standalone RpcClient. Historical notes may no longer be indexed; an RPC error is shown separately from a returned note status.</p>
        <div className="controls"><label>Committed note ID<input value={noteId} onChange={(event) => setNoteId(event.target.value)} placeholder="0x…" /></label><button onClick={checkNtx} disabled={!client || busy}>Query status</button></div>
        <Value name="NTX query result" value={ntxResult} />
        <Value name="NTX query error" value={ntxError ?? "none"} />
      </section>

      <section className="panel">
        <h2>Browser capability status</h2>
        <div className="grid">
          <Value name="Heartbeat note construction" value="available locally; select and validate above" />
          <Value name="Deposit note construction" value="available locally; select and validate above" />
          <Value name="Claim note construction" value="available locally; select and validate above" />
          <Value name="Activation note construction" value="available locally; select and validate above" />
          <Value name="FeeSponsorship pairing" value="built and paired by local feature-note constructor" />
          <Value name="NetworkAccountTarget" value="included by local feature-note constructor" />
          <Value name="NTX status" value="public Web SDK RpcClient; query above" />
          <Value name="P2ID consume request" value="local synthetic request targets the connected wallet; handoff stays disabled unless public RPC confirms the note ID is absent" />
          <Value name="Transaction submission" value="only the explicitly clicked preview buttons call the wallet; no app-side submission" />
          <Value name="NTX result / last error" value={`${ntxResult} / ${ntxError ?? "none"}`} />
        </div>
      </section>

      {diagnostic !== null && <section className="panel"><h2>Diagnostic output</h2><pre>{pretty(diagnostic)}</pre></section>}
      <footer>Test account defaults are public identifiers from the existing testnet setup. No account discovery, key import, or chain mutation is implemented.</footer>
    </main>
  );
}

function Value({ name, value }: { name: string; value: unknown }) {
  return <div className="value"><span>{name}</span><pre>{typeof value === "bigint" ? value.toString() : String(value)}</pre></div>;
}

import { useMemo, useState } from "react";
import {
  PrivateDataPermission,
  WalletAdapterNetwork,
  WalletDisconnectButton,
  WalletReadyState,
  useWallet,
} from "@miden-sdk/miden-wallet-adapter";
import type { MidenClient } from "@miden-sdk/miden-sdk";
import { deriveLifecycle, deriveRole } from "./domain/lifecycle";
import type { VaultSnapshot } from "./domain/types";
import { buildFeaturePair, type FeatureKind } from "./heirbeat/feature-notes";
import { readVault } from "./heirbeat/vault";
import { createReadOnlyClient, getBlockHeader } from "./miden/client";
import { KNOWN_VAULT_ID, TESTNET_ENDPOINTS } from "./miden/endpoints";
import { readNtxStatus } from "./miden/ntx";
import { makeWalletTransactionRequest } from "./miden/wallet-request";

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

  async function connectWallet() {
    setWalletError(null);
    const detected = wallet.wallets.find((candidate) => candidate.readyState === WalletReadyState.Installed || candidate.readyState === WalletReadyState.Loadable);
    if (!detected) {
      const message = "No supported Miden wallet was detected. Install/enable the official Miden Wallet and retry.";
      setWalletError(message);
      setError(message);
      return;
    }
    wallet.select(detected.adapter.name);
    try {
      await wallet.connect(PrivateDataPermission.UponRequest, WalletAdapterNetwork.Testnet);
      setError(null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setWalletError(message);
      setError(message);
    }
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
    await run(() => readNtxStatus(client, noteId), (status) => {
      const result = `${status.status} (attempts: ${status.attemptCount}, last block: ${status.lastAttemptBlockNum})`;
      setNtxResult(result);
      setDiagnostic({ noteId, status: status.status, attemptCount: status.attemptCount, lastAttemptBlockNum: status.lastAttemptBlockNum, lastError: status.lastError });
    }, (message) => {
      setNtxResult("query failed");
      setNtxError(message);
    });
  }

  const derived = snapshot ? { ...deriveLifecycle(snapshot), role: deriveRole(wallet.address, snapshot.owner, snapshot.beneficiary) } : null;
  const detection = wallet.wallets[0]?.readyState ?? WalletReadyState.Unsupported;
  const walletDetected = wallet.wallets.some((candidate) => candidate.readyState === WalletReadyState.Installed || candidate.readyState === WalletReadyState.Loadable);

  return (
    <main className="shell">
      <header className="topbar">
        <div><p className="eyebrow">Miden v0.16 · read-only browser spike</p><h1>Heirbeat browser boundary check</h1></div>
        <div className="wallet-controls">
          {wallet.connected ? <><span className="wallet-address">{wallet.address}</span><WalletDisconnectButton /></> : <button onClick={connectWallet} disabled={wallet.connecting || busy}>{wallet.connecting ? "Connecting…" : "Connect Miden wallet"}</button>}
          <span className="muted">Wallet detection: {detection}</span>
        </div>
      </header>

      <p className="notice">This spike does not submit transactions or request signatures. Signing keys remain in the user-controlled wallet.</p>
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
          <Value name="Connected AccountId" value={wallet.address ?? "none"} />
          <Value name="Last wallet error" value={walletError ?? "none"} />
        </div>
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
        <p className="muted">Read-only GetNetworkNoteStatus via the Web SDK’s internal raw-client bridge; this is not a stable high-level React API.</p>
        <div className="controls"><label>Committed note ID<input value={noteId} onChange={(event) => setNoteId(event.target.value)} placeholder="0x…" /></label><button onClick={checkNtx} disabled={!client || busy}>Query status</button></div>
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
          <Value name="NTX status" value="internal Web SDK bridge; query above" />
          <Value name="P2ID consume request" value="local validated-note helper available; wallet handoff not implemented in this diagnostic page" />
          <Value name="Transaction submission" value="disabled; no wallet request is sent" />
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

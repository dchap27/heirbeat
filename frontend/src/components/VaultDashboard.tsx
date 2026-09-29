import { useState } from "react";
import type { ReactNode } from "react";
import { deriveDeadline, deriveLifecycle, deriveRoleWithDiagnostic } from "../domain/lifecycle";
import { formatAssetAmount, shortenedAccountId, type VaultReadDiagnostic } from "../domain/open-vault";
import type { VaultLifecycleState, VaultRole, VaultSnapshot } from "../domain/types";
import { readNtxStatus } from "../miden/ntx";
import { CheckInAction, CHECK_IN_STATE_LABELS } from "./CheckInAction";
import type { CheckInRecord } from "../domain/check-in";
import type { Asset } from "@miden-sdk/miden-wallet-adapter";
import type { Transaction } from "@miden-sdk/miden-wallet-adapter";

const lifecycleLabels: Record<VaultLifecycleState, string> = {
  setup: "Setup",
  active: "Active",
  warning: "Warning",
  claimable: "Claimable",
  claimPending: "Claim pending",
  claimed: "Claimed",
  unknown: "Unknown",
};

const roleLabels: Record<VaultRole, string> = { owner: "Owner", beneficiary: "Beneficiary", observer: "Observer" };

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return <button className="copy-button" type="button" onClick={() => void copy()} aria-label={`Copy ${label}`} title={`Copy ${label}`}>
    {copied ? "Copied" : "Copy"}
  </button>;
}

export function VaultHeader({ snapshot, role, onClose }: { snapshot: VaultSnapshot; role: VaultRole; onClose: () => void }) {
  const lifecycle = deriveLifecycle(snapshot).lifecycle;
  return <div className="vault-heading">
    <div>
      <div className="vault-heading-top">
        <span className={`status-badge status-${lifecycle}`}><span className="status-indicator" aria-hidden="true" />{lifecycleLabels[lifecycle]}</span>
        <span className="role-badge">{roleLabels[role]}</span>
      </div>
      <h1>Your inheritance vault</h1>
      <div className="account-line"><code>{shortenedAccountId(snapshot.accountId)}</code><CopyButton value={snapshot.accountId} label="vault Account ID" /></div>
    </div>
    <button className="button button-quiet" onClick={onClose}>Open another vault</button>
  </div>;
}

export function VaultStatusCard({ snapshot }: { snapshot: VaultSnapshot }) {
  const derived = deriveLifecycle(snapshot);
  const label = lifecycleLabels[derived.lifecycle];
  return <section className="product-card status-card" aria-labelledby="vault-status-title">
    <div className="card-title-row"><div><div className="section-kicker">Vault status</div><h2 id="vault-status-title">{label}</h2></div><span className="status-orb" aria-hidden="true">{snapshot.claimed ? "✓" : snapshot.activated ? "◷" : "○"}</span></div>
    {snapshot.claimed ? <p className="status-message">Inheritance claimed. This vault is in its terminal state.</p>
      : !snapshot.activated ? <p className="status-message">Vault not yet finalized. Policy can only be locked by the activation step.</p>
        : derived.eligible ? <p className="status-message">The inactivity deadline has passed. The configured beneficiary is eligible to claim.</p>
          : <p className="status-message">The vault is active. Its policy remains locked on-chain while the owner can check in.</p>}
    <div className="status-metrics">
      <Metric label="Last check-in" value={`Block ${snapshot.lastCheckIn}`} />
      <Metric label="Claim eligibility" value={`Block ${derived.deadline}`} />
      <Metric label="Blocks remaining" value={snapshot.claimed || !snapshot.activated ? "—" : derived.remainingBlocks.toString()} />
    </div>
    <p className="field-help">Eligibility is derived from the current synced block ({snapshot.currentReferenceBlock}) and the on-chain timeout. No wall-clock estimate is shown.</p>
  </section>;
}

export function InheritanceCard({ snapshot }: { snapshot: VaultSnapshot }) {
  const displayedBalance = formatAssetAmount(snapshot.inheritedBalance, snapshot.inheritedAssetDecimals);
  const assetLabel = snapshot.inheritedAssetSymbol
    ? `${snapshot.inheritedAssetSymbol}${snapshot.inheritedAssetDecimals ? ` · ${snapshot.inheritedAssetDecimals} decimals` : ""}`
    : "Fungible asset · token metadata unavailable";
  return <section className="product-card" aria-labelledby="inheritance-title">
    <div className="section-kicker">Inheritance</div><h2 id="inheritance-title">Vault assets</h2>
    <div className="asset-balance"><div><span className="metric-label">Vault balance</span><strong>{assetLabel}</strong></div><span className="large-number">{displayedBalance}</span></div>
    <div className="asset-id-line"><span className="metric-label">Faucet Account ID</span><code>{shortenedAccountId(snapshot.faucet)}</code><CopyButton value={snapshot.faucet} label="faucet Account ID" /></div>
    <details className="fee-details"><summary>Network fee balance <span>Separate from inheritance assets</span></summary>
      <div className="fee-balance"><strong>{snapshot.nativeBalance.toString()}</strong><span className="metric-label">native fee units</span></div>
      <div className="asset-id-line"><span className="metric-label">Fee faucet</span><code>{shortenedAccountId(snapshot.nativeFeeFaucet)}</code><CopyButton value={snapshot.nativeFeeFaucet} label="native fee faucet Account ID" /></div>
    </details>
  </section>;
}

export function VaultPolicyCard({ snapshot }: { snapshot: VaultSnapshot }) {
  return <section className="product-card" aria-labelledby="policy-title">
    <div className="section-kicker">People & policy</div><h2 id="policy-title">Vault configuration</h2>
    <AccountLine label="Owner" accountId={snapshot.owner} />
    <AccountLine label="Beneficiary" accountId={snapshot.beneficiary} />
    <div className="policy-row"><span>Heartbeat timeout</span><strong>{snapshot.timeoutBlocks.toString()} blocks</strong></div>
    <div className="policy-row"><span>Activation</span><strong>{snapshot.activated ? "Locked on-chain" : "Not finalized"}</strong></div>
    <p className="field-help">After activation, beneficiary, inherited asset and timeout are immutable under the vault’s on-chain policy.</p>
  </section>;
}

function AccountLine({ label, accountId }: { label: string; accountId: string }) {
  return <div className="account-policy-row"><span>{label}</span><code title={accountId}>{shortenedAccountId(accountId)}</code><CopyButton value={accountId} label={`${label.toLowerCase()} Account ID`} /></div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="status-metric"><span className="metric-label">{label}</span><strong>{value}</strong></div>;
}

const timeline = [
  { key: "configured", label: "Configured" },
  { key: "finalized", label: "Finalized" },
  { key: "active", label: "Active" },
  { key: "claimable", label: "Claimable" },
  { key: "claimed", label: "Claimed" },
] as const;

export function LifecycleTimeline({ state }: { state: VaultLifecycleState }) {
  const index = state === "setup" ? 0 : state === "active" || state === "warning" ? 2 : state === "claimable" || state === "claimPending" ? 3 : state === "claimed" ? 4 : -1;
  return <section className="product-card timeline-card" aria-labelledby="timeline-title">
    <div className="section-kicker">Lifecycle</div><h2 id="timeline-title">Vault journey</h2>
    <ol className="timeline">
      {timeline.map((stage, stageIndex) => <li key={stage.key} className={`${stageIndex < index ? "complete" : ""} ${stageIndex === index ? "current" : ""}`} aria-current={stageIndex === index ? "step" : undefined}>
        <span className="timeline-marker" aria-hidden="true">{stageIndex < index ? "✓" : stageIndex + 1}</span><span>{stage.label}</span>
      </li>)}
    </ol>
  </section>;
}

export function VaultActions({ snapshot, role, checkInAction }: { snapshot: VaultSnapshot; role: VaultRole; checkInAction?: ReactNode }) {
  const state = deriveLifecycle(snapshot);
  if (snapshot.claimed) return <section className="product-card actions-card"><div className="section-kicker">Next step</div><h2>Inheritance claimed</h2><p>This vault is terminal. No further heartbeat, deposit, or claim action is available.</p></section>;
  if (role === "observer") return <section className="product-card actions-card"><div className="section-kicker">Vault actions</div><h2>Read-only access</h2><p>{snapshot.activated ? "Connect the vault owner's wallet to check in." : "Only the configured owner can check in or deposit. Only the beneficiary can claim when eligible."}</p></section>;
  if (!snapshot.activated) return role === "owner"
    ? <section className="product-card actions-card"><div className="section-kicker">Owner actions</div><h2>Review & finalize vault</h2><p>Finalization permanently locks the inheritance policy.</p><button className="button button-disabled" disabled aria-describedby="action-coming">Coming in next implementation step</button><span id="action-coming" className="field-help">Live wallet actions are not enabled in this release.</span></section>
    : <section className="product-card actions-card"><div className="section-kicker">Beneficiary actions</div><h2>Vault setup in progress</h2><p>Claiming is unavailable until the owner finalizes the vault and the inactivity deadline passes.</p></section>;
  if (role === "beneficiary") return <section className="product-card actions-card"><div className="section-kicker">Beneficiary actions</div><h2>{state.eligible ? "Claim is available" : "Claim not yet available"}</h2>
    <p>No owner actions are available for this wallet.</p>
    <button className="button button-disabled" disabled aria-describedby="claim-reason">Claim inheritance · coming soon</button>
    <p id="claim-reason" className="field-help">{state.eligible ? "Live wallet actions are not enabled in this release." : `Claim becomes available at block ${state.deadline}. ${state.remainingBlocks} blocks remain.`}</p>
  </section>;
  if (role === "owner") return <>
    {checkInAction}
    <section className="product-card actions-card"><div className="section-kicker">Owner actions</div><h2>Other vault actions</h2><button className="button button-disabled" disabled>Deposit · coming soon</button><p className="field-help">Deposit is not connected to wallet submission.</p></section>
  </>;
  return null;
}

export function NetworkExecutionStatus({ record }: { record?: CheckInRecord }) {
  const label = record ? ({
    idle: "No operation in progress",
    preparing: "Preparing request",
    wallet_review: "Wallet review",
    wallet_rejected: "Check-in canceled",
    wallet_accepted: "Wallet accepted · awaiting chain evidence",
    feature_note_committed: "Feature note committed · awaiting execution",
    ntx_pending: "Waiting for Miden execution",
    ntx_executing: "Executing on Miden",
    executed: "Check-in confirmed",
    failed: "Check-in failed",
    unknown: "Execution status unknown",
  } as const)[record.state] : "No operation in progress";
  return <section className="network-execution" aria-labelledby="network-execution-title">
    <div className="execution-icon" aria-hidden="true">↗</div><div><div className="section-kicker">Network execution</div><h2 id="network-execution-title">{label}</h2><p>{record?.message ?? "Wallet review and Network Account execution are separate steps. This dashboard only shows confirmed chain state."}</p></div>
    <span className="execution-state">{record ? CHECK_IN_STATE_LABELS[record.state] : "Idle"}</span>
  </section>;
}

export function AdvancedVaultDetails({ snapshot, endpoint, diagnostics = [] }: { snapshot: VaultSnapshot; endpoint: string; diagnostics?: VaultReadDiagnostic[] }) {
  return <details className="advanced-details">
    <summary>Advanced details <span>Raw on-chain state and read-only tools</span></summary>
    <div className="advanced-content">
      <div className="advanced-grid">
        <RawValue label="Vault Account ID" value={snapshot.accountId} />
        <RawValue label="Owner Account ID" value={snapshot.owner} />
        <RawValue label="Beneficiary Account ID" value={snapshot.beneficiary} />
        <RawValue label="Inherited faucet Account ID" value={snapshot.faucet} />
        <RawValue label="Last check-in block" value={snapshot.lastCheckIn.toString()} />
        <RawValue label="Timeout blocks" value={snapshot.timeoutBlocks.toString()} />
        <RawValue label="Deadline block" value={deriveDeadline(snapshot.lastCheckIn, snapshot.timeoutBlocks).toString()} />
        <RawValue label="Current reference block" value={String(snapshot.currentReferenceBlock)} />
        <RawValue label="Activated" value={String(snapshot.activated)} />
        <RawValue label="Claimed" value={String(snapshot.claimed)} />
        <RawValue label="Inherited balance (raw units)" value={snapshot.inheritedBalance.toString()} />
        <RawValue label="Note allowlist roots" value={snapshot.noteAllowlist.join("\n") || "none"} />
        <RawValue label="Transaction-script roots" value={snapshot.transactionScriptAllowlist.join("\n") || "none"} />
      </div>
      <details className="ntx-tools"><summary>Read-only NTX note status</summary><NtxStatusLookup endpoint={endpoint} /></details>
      {diagnostics.length > 0 && <details className="ntx-tools developer-details"><summary>Developer diagnostics</summary>
        {diagnostics.map((diagnostic, index) => <div className="diagnostic-entry" key={`${diagnostic.stage}-${index}`}>
          <strong>Stage: {diagnostic.stage}</strong><span>Error: {diagnostic.errorName}</span><code>{diagnostic.errorMessage}</code>
        </div>)}
      </details>}
    </div>
  </details>;
}

function RawValue({ label, value }: { label: string; value: string }) {
  return <div className="raw-value"><span>{label}</span><code>{value}</code></div>;
}

function NtxStatusLookup({ endpoint }: { endpoint: string }) {
  const [noteId, setNoteId] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function query() {
    setBusy(true); setError(null); setStatus(null);
    try {
      const result = await readNtxStatus(endpoint, noteId.trim());
      setStatus(`${result.status} · ${result.attemptCount} attempts${result.lastAttemptBlockNum === undefined ? "" : ` · last attempted at block ${result.lastAttemptBlockNum}`}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }
  return <div className="ntx-lookup">
    <label className="field-label" htmlFor="ntx-note-id">Public network note ID</label>
    <div className="input-row"><input id="ntx-note-id" value={noteId} onChange={(event) => setNoteId(event.target.value)} placeholder="0x…" /><button className="button button-secondary" disabled={busy || !noteId.trim()} onClick={() => void query()}>{busy ? "Checking…" : "Check status"}</button></div>
    <p className="field-help">This is a read-only lookup. A note status does not by itself prove the vault operation executed.</p>
    {status && <p role="status" className="ntx-result">{status}</p>}
    {error && <p role="status" className="form-error ntx-result">{error}</p>}
  </div>;
}

export function VaultDashboard({ snapshot, connectedAccount, endpoint, diagnostics = [], onClose, walletConnected = false, requestAssets, requestTransaction, checkInRecord, onCheckInRecord, onSnapshotRefresh }: {
  snapshot: VaultSnapshot;
  connectedAccount: string | null;
  endpoint: string;
  diagnostics?: VaultReadDiagnostic[];
  onClose: () => void;
  walletConnected?: boolean;
  requestAssets?: () => Promise<Asset[]>;
  requestTransaction?: (transaction: Transaction) => Promise<string>;
  checkInRecord?: CheckInRecord;
  onCheckInRecord?: (record: CheckInRecord | undefined) => void;
  onSnapshotRefresh?: (snapshot: VaultSnapshot) => void;
}) {
  const roleResult = deriveRoleWithDiagnostic(connectedAccount, snapshot.owner, snapshot.beneficiary);
  const role = roleResult.role;
  const allDiagnostics = roleResult.diagnostic ? [...diagnostics, roleResult.diagnostic] : diagnostics;
  const lifecycle = deriveLifecycle(snapshot).lifecycle;
  const checkInAction = role === "owner" && snapshot.activated && !snapshot.claimed
    ? <CheckInAction
        snapshot={snapshot}
        endpoint={endpoint}
        connectedAccount={connectedAccount}
        walletConnected={walletConnected}
        requestAssets={requestAssets}
        requestTransaction={requestTransaction}
        record={checkInRecord}
        onRecord={(record) => onCheckInRecord?.(record)}
        onSnapshot={(fresh) => onSnapshotRefresh?.(fresh)}
      />
    : undefined;
  return <div className="vault-page">
    <VaultHeader snapshot={snapshot} role={role} onClose={onClose} />
    <VaultStatusCard snapshot={snapshot} />
    <div className="dashboard-grid">
      <InheritanceCard snapshot={snapshot} />
      <VaultPolicyCard snapshot={snapshot} />
    </div>
    <LifecycleTimeline state={lifecycle} />
    <VaultActions snapshot={snapshot} role={role} checkInAction={checkInAction} />
    <NetworkExecutionStatus record={checkInRecord} />
    <AdvancedVaultDetails snapshot={snapshot} endpoint={endpoint} diagnostics={allDiagnostics} />
  </div>;
}

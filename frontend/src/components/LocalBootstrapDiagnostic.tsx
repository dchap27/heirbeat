import { useState } from "react";
import { deleteLocalBootstrapStore, hasUnresolvedLocalExecution, isBootstrapDiagnosticEnabled, LOCAL_BOOTSTRAP_STORE, runLocalBootstrapDiagnostic, type BootstrapDiagnosticEvidence, type BootstrapStage } from "../miden/local-bootstrap-diagnostic";

const initialEvidence: BootstrapDiagnosticEvidence = {
  walletInvoked: false,
  rpcSubmissionCalled: false,
};

export function LocalBootstrapDiagnostic() {
  const [stages, setStages] = useState<BootstrapStage[]>([]);
  const [evidence, setEvidence] = useState<BootstrapDiagnosticEvidence>(initialEvidence);
  const [running, setRunning] = useState(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const executionPending = evidence.executionTiming?.promiseSettled === false || hasUnresolvedLocalExecution();

  if (!isBootstrapDiagnosticEnabled(import.meta.env.DEV)) return null;

  async function run() {
    if (running || executionPending) return;
    setRunning(true);
    setStages([]);
    setEvidence(initialEvidence);
    setResetMessage(null);
    try {
      await runLocalBootstrapDiagnostic((stage, nextEvidence) => {
        setStages((current) => [...current.filter((item) => item.stage !== stage.stage), stage]);
        setEvidence(nextEvidence);
      });
    } catch {
      // The exact error is already kept in the failed stage for developer inspection.
    } finally {
      setRunning(false);
    }
  }

  async function reset() {
    if (running || executionPending) return;
    setResetMessage(null);
    try {
      const result = await deleteLocalBootstrapStore();
      setResetMessage(result === "deleted"
        ? `Deleted the app-origin mock store “${LOCAL_BOOTSTRAP_STORE}”.`
        : `Deletion of “${LOCAL_BOOTSTRAP_STORE}” is blocked by an open SDK connection. Reload the page and try again.`);
      if (result === "deleted") {
        setStages([]);
        setEvidence(initialEvidence);
      }
    } catch (cause) {
      setResetMessage(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return <section className="bootstrap-diagnostic" aria-labelledby="bootstrap-diagnostic-title">
    <p className="section-kicker">Development only</p>
    <h2 id="bootstrap-diagnostic-title">Local vault bootstrap diagnostic</h2>
    <p>This uses Miden’s mock client and its isolated <code>{LOCAL_BOOTSTRAP_STORE}</code> IndexedDB store. It does not connect to testnet or the wallet.</p>
    <p className="diagnostic-warning"><strong>Local test only.</strong> No wallet request, RPC submission, or live account mutation is performed. Reset below deletes only this app-origin mock store, never Miden Wallet data.</p>
    <div className="action-buttons">
      <button className="button button-primary" type="button" onClick={() => void run()} disabled={running || executionPending}>
        {running ? "Running local diagnostic…" : executionPending ? "SDK execution still pending…" : "Run local bootstrap execution + proof"}
      </button>
      <button className="button button-secondary" type="button" onClick={() => void reset()} disabled={running || executionPending}>
        Reset isolated mock store
      </button>
    </div>
    {executionPending && <p role="status">The diagnostic timed out while the SDK operation may still be running. It was not cancelled; wait for its late result or reload to stop the local worker. No wallet or network submission was started.</p>}
    {resetMessage && <p role="status">{resetMessage}</p>}
    {stages.length > 0 && <div className="bootstrap-diagnostic-results" aria-live="polite">
      <h3>Stages</h3>
      <ol>{stages.map((stage) => <li key={stage.stage} data-status={stage.status}>
        <strong>{stage.stage.replaceAll("_", " ")}: {stage.status}</strong>
        {stage.detail && <span>{stage.detail}</span>}
        {stage.elapsedMs !== undefined && <span>Elapsed: {stage.elapsedMs} ms</span>}
        {stage.lastCompletedSubstage && <span>Last completed point: {stage.lastCompletedSubstage}</span>}
        {stage.promiseMayStillBeRunning && <span>The SDK promise may still be running; the timeout does not cancel it.</span>}
        {stage.errorMessage && <details><summary>Developer error</summary><code>{stage.errorName}: {stage.errorMessage}</code></details>}
      </li>)}</ol>
      <details><summary>Plain diagnostic evidence</summary><pre>{JSON.stringify(evidence, null, 2)}</pre></details>
    </div>}
  </section>;
}

import type { VaultOpenStatus, VaultReadDiagnostic } from "../domain/open-vault";

const statusCopy: Partial<Record<VaultOpenStatus, string>> = {
  validating: "Validating Account ID…",
  loading: "Reading public vault state from Miden Testnet…",
  invalid_account_id: "Enter a valid Miden Account ID in hex or Bech32 format.",
  not_found: "No public account was found for this Account ID on Miden Testnet.",
  incompatible_account: "This account is not a readable Heirbeat Network Account.",
  rpc_error: "Unable to read this vault from Miden Testnet. Check your connection and try again.",
  sdk_error: "The browser client could not decode this vault. Try again, or open developer diagnostics for details.",
};

export function OpenVaultForm({
  value,
  status,
  detail,
  diagnostics = [],
  onChange,
  onSubmit,
}: {
  value: string;
  status: VaultOpenStatus;
  detail?: string | null;
  diagnostics?: VaultReadDiagnostic[];
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const busy = status === "validating" || status === "loading";
  const message = statusCopy[status];
  return <section className="open-card" aria-labelledby="open-vault-title">
    <div className="section-kicker">Explicit vault access</div>
    <h1 id="open-vault-title">Open a vault</h1>
    <p className="body-copy">Vaults are opened using their Account ID. Heirbeat does not currently discover or enumerate vaults for you.</p>
    <form onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <label className="field-label" htmlFor="vault-account-id">Vault Account ID</label>
      <div className="input-row">
        <input
          id="vault-account-id"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="0x… or mtst1…"
          aria-describedby="vault-id-help"
          aria-invalid={status === "invalid_account_id"}
        />
        <button className="button button-primary" type="submit" disabled={busy}>{busy ? "Opening…" : "Open vault"}</button>
      </div>
      <span className="field-help" id="vault-id-help">Paste a public Miden Account ID or open a shared vault link.</span>
    </form>
    {message && <p className={status === "invalid_account_id" || status === "not_found" || status === "incompatible_account" || status === "rpc_error" || status === "sdk_error" ? "form-status form-error" : "form-status"} role="status">{message}</p>}
    {diagnostics.length > 0 && <details className="developer-details">
      <summary>Developer diagnostics</summary>
      {detail && <p className="diagnostic-safe-summary">{detail}</p>}
      {diagnostics.map((diagnostic, index) => <div className="diagnostic-entry" key={`${diagnostic.stage}-${index}`}>
        <strong>Stage: {diagnostic.stage}</strong>
        <span>Error: {diagnostic.errorName}</span>
        <code>{diagnostic.errorMessage}</code>
      </div>)}
    </details>}
  </section>;
}

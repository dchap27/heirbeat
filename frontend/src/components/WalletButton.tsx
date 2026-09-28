import { shortenedAccountId } from "../domain/open-vault";

export function WalletButton({
  connected,
  address,
  connecting,
  error,
  onConnect,
  onDisconnect,
}: {
  connected: boolean;
  address: string | null;
  connecting: boolean;
  error?: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  return <div className="wallet-control">
    {connected && address
      ? <>
        <span className="wallet-account"><span className="connection-dot" aria-hidden="true" />{shortenedAccountId(address)}</span>
        <button className="button button-quiet" onClick={onDisconnect} aria-label="Disconnect Miden wallet">Disconnect</button>
      </>
      : <button className="button button-primary" onClick={onConnect} disabled={connecting}>{connecting ? "Connecting…" : "Connect wallet"}</button>}
    {error && <span className="wallet-error" role="status">{error}</span>}
  </div>;
}

import type { ReactNode } from "react";
import { WalletButton } from "./WalletButton";
import type { AppView } from "../domain/app-navigation";
export type { AppView } from "../domain/app-navigation";

export function AppShell({
  view,
  hasVault,
  connected,
  address,
  connecting,
  walletError,
  onNavigate,
  onConnect,
  onDisconnect,
  children,
}: {
  view: AppView;
  hasVault: boolean;
  connected: boolean;
  address: string | null;
  connecting: boolean;
  walletError?: string | null;
  onNavigate: (view: AppView) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  children: ReactNode;
}) {
  return <div className="app-frame">
    <header className="site-header">
      <a className="brand" href="/" onClick={(event) => { event.preventDefault(); onNavigate("home"); }} aria-label="Heirbeat home">
        <span className="brand-mark" aria-hidden="true">H</span><span>Heirbeat</span>
      </a>
      <nav className="main-nav" aria-label="Main navigation">
        <button className={view === "home" ? "nav-link active" : "nav-link"} aria-current={view === "home" ? "page" : undefined} onClick={() => onNavigate("home")}>Home</button>
        {hasVault && <button className={view === "dashboard" ? "nav-link active" : "nav-link"} aria-current={view === "dashboard" ? "page" : undefined} onClick={() => onNavigate("dashboard")}>Dashboard</button>}
        <button className={view === "open" ? "nav-link active" : "nav-link"} aria-current={view === "open" ? "page" : undefined} onClick={() => onNavigate("open")}>Open vault</button>
        {view === "create" && <button className="nav-link active" aria-current="page" onClick={() => onNavigate("create")}>Create vault</button>}
      </nav>
      <div className="header-actions">
        <span className="network-pill"><span className="network-dot" aria-hidden="true" />Miden Testnet</span>
        <WalletButton connected={connected} address={address} connecting={connecting} error={walletError} onConnect={onConnect} onDisconnect={onDisconnect} />
      </div>
    </header>
    <main id="main-content" className="main-content">{children}</main>
    <footer className="site-footer"><span>Heirbeat</span><span>Vault rules are enforced on Miden. This interface is read-only.</span></footer>
  </div>;
}

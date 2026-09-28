import React, { Component, type ErrorInfo, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import {
  MidenWalletAdapter,
  WalletAdapterNetwork,
  WalletModalProvider,
  WalletProvider,
} from "@miden-sdk/miden-wallet-adapter";
import { App } from "./App";
import "@miden-sdk/miden-wallet-adapter/styles.css";
import "./style.css";

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    console.error("Heirbeat UI failed to render", error);
  }

  render() {
    if (this.state.error) {
      return <main className="startup-error" role="alert">
        <p className="section-kicker">Heirbeat could not render</p>
        <h1>The page hit an application error.</h1>
        <p>{this.state.error}</p>
        <button className="button button-secondary" onClick={() => window.location.reload()}>Reload Heirbeat</button>
      </main>;
    }
    return this.props.children;
  }
}

const wallets = [new MidenWalletAdapter({ appName: "Heirbeat Browser Spike" })];

ReactDOM.createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    <React.StrictMode>
      <WalletProvider wallets={wallets} autoConnect={false} network={WalletAdapterNetwork.Testnet}>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </React.StrictMode>
  </AppErrorBoundary>,
);

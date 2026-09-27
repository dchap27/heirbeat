import React from "react";
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

const wallets = [new MidenWalletAdapter({ appName: "Heirbeat Browser Spike" })];

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WalletProvider wallets={wallets} autoConnect={false} network={WalletAdapterNetwork.Testnet}>
      <WalletModalProvider>
        <App />
      </WalletModalProvider>
    </WalletProvider>
  </React.StrictMode>,
);

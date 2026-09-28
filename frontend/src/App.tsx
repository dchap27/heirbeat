import { useCallback, useEffect, useRef, useState } from "react";
import {
  PrivateDataPermission,
  WalletAdapterNetwork,
  WalletReadyState,
  useWallet,
} from "@miden-sdk/miden-wallet-adapter";
import { AppShell, type AppView } from "./components/AppShell";
import { pathForView, viewForPath } from "./domain/app-navigation";
import { OpenVaultForm } from "./components/OpenVaultForm";
import { VaultDashboard } from "./components/VaultDashboard";
import { classifyVaultReadError, parseVaultAccountId, parseVaultLocation, userSafeVaultError, VaultReadError, type VaultOpenStatus, type VaultReadDiagnostic } from "./domain/open-vault";
import type { VaultSnapshot } from "./domain/types";
import { readVaultFromRpc } from "./heirbeat/vault";
import { TESTNET_ENDPOINTS } from "./miden/endpoints";
import { planWalletConnectStep } from "./miden/connect-flow";
import { CreateVaultPlaceholder, HomePage } from "./pages/HomePage";

const endpoint = TESTNET_ENDPOINTS[0];
const initialLocation = typeof window === "undefined"
  ? { accountId: null, requested: false }
  : parseVaultLocation(window.location.pathname, window.location.search);
const initialView: AppView = initialLocation.requested
  ? "open"
  : typeof window === "undefined" ? "home" : viewForPath(window.location.pathname);

export function App() {
  const wallet = useWallet();
  const [view, setView] = useState<AppView>(initialView);
  const [vaultInput, setVaultInput] = useState(initialLocation.accountId ?? "");
  const [openStatus, setOpenStatus] = useState<VaultOpenStatus>("idle");
  const [openDetail, setOpenDetail] = useState<string | null>(null);
  const [readDiagnostics, setReadDiagnostics] = useState<VaultReadDiagnostic[]>([]);
  const [snapshot, setSnapshot] = useState<VaultSnapshot | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [walletConnecting, setWalletConnecting] = useState(false);
  const pendingWalletName = useRef<string | null>(null);
  const didAutoOpen = useRef(false);

  const connectSelectedWallet = useCallback(async () => {
    setWalletError(null);
    setWalletConnecting(true);
    try {
      await wallet.connect(PrivateDataPermission.UponRequest, WalletAdapterNetwork.Testnet);
    } catch (cause) {
      setWalletError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWalletConnecting(false);
    }
  }, [wallet.connect]);

  useEffect(() => {
    const pending = pendingWalletName.current;
    if (!pending || wallet.wallet?.adapter.name !== pending) return;
    pendingWalletName.current = null;
    void connectSelectedWallet();
  }, [wallet.wallet, connectSelectedWallet]);

  const connectWallet = useCallback(() => {
    setWalletError(null);
    const detected = wallet.wallets.find((candidate) => candidate.readyState === WalletReadyState.Installed || candidate.readyState === WalletReadyState.Loadable);
    if (!detected) {
      setWalletError("No supported Miden wallet detected. Install or enable Miden Wallet, then try again.");
      return;
    }
    const step = planWalletConnectStep(wallet.wallet?.adapter.name ?? null, detected.adapter.name);
    if (step.kind === "select") {
      pendingWalletName.current = step.walletName;
      setWalletConnecting(true);
      wallet.select(step.walletName);
      return;
    }
    if (step.kind === "connect") void connectSelectedWallet();
  }, [wallet.wallets, wallet.wallet, wallet.select, connectSelectedWallet]);

  const openVault = useCallback(async (requestedId = vaultInput) => {
    setOpenDetail(null);
    setReadDiagnostics([]);
    setOpenStatus("validating");
    let canonicalId: string;
    try {
      canonicalId = parseVaultAccountId(requestedId);
      setVaultInput(canonicalId);
    } catch (cause) {
      setSnapshot(null);
      setOpenStatus("invalid_account_id");
      setReadDiagnostics([{ stage: "normalize_vault_account_id", errorName: cause instanceof Error ? cause.name : typeof cause, errorMessage: cause instanceof Error ? cause.message : String(cause) }]);
      return;
    }

    setSnapshot(null);
    setOpenStatus("loading");
    try {
      const { snapshot: loaded, diagnostics } = await readVaultFromRpc(endpoint, canonicalId);
      setSnapshot(loaded);
      setReadDiagnostics(diagnostics);
      setOpenStatus("loaded");
      setView("dashboard");
      window.history.replaceState({}, "", pathForView("dashboard", canonicalId));
    } catch (cause) {
      const status = classifyVaultReadError(cause);
      setOpenStatus(status);
      setOpenDetail(userSafeVaultError(status));
      setReadDiagnostics([cause instanceof VaultReadError
        ? { stage: cause.stage, errorName: cause.errorName, errorMessage: cause.errorMessage }
        : { stage: "initialize_client", errorName: cause instanceof Error ? cause.name : typeof cause, errorMessage: cause instanceof Error ? cause.message : String(cause) }]);
    }
  }, [vaultInput]);

  useEffect(() => {
    if (didAutoOpen.current || !initialLocation.requested) return;
    didAutoOpen.current = true;
    void openVault(initialLocation.accountId ?? "");
  }, [openVault]);

  function navigate(next: AppView) {
    setView(next);
    window.history.pushState({}, "", pathForView(next, snapshot?.accountId));
    if (next === "open") {
      setOpenStatus("idle");
      setOpenDetail(null);
    }
  }

  useEffect(() => {
    const onPopState = () => {
      const location = parseVaultLocation(window.location.pathname, window.location.search);
      if (location.requested) {
        setView("open");
        setVaultInput(location.accountId ?? "");
        void openVault(location.accountId ?? "");
      } else {
        setView(viewForPath(window.location.pathname));
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [openVault]);

  function closeVault() {
    setSnapshot(null);
    setVaultInput("");
    setOpenStatus("idle");
    setOpenDetail(null);
    navigate("open");
  }

  const content = view === "open"
    ? <OpenVaultForm value={vaultInput} status={openStatus} detail={openDetail} diagnostics={readDiagnostics} onChange={(value) => { setVaultInput(value); if (openStatus !== "idle") setOpenStatus("idle"); }} onSubmit={() => void openVault()} />
    : view === "create"
      ? <CreateVaultPlaceholder onBack={() => navigate("home")} />
      : view === "dashboard" && snapshot
        ? <VaultDashboard snapshot={snapshot} connectedAccount={wallet.connected ? wallet.address : null} endpoint={endpoint} diagnostics={readDiagnostics} onClose={closeVault} />
        : <HomePage hasVault={snapshot !== null} onOpen={() => navigate("open")} onCreate={() => navigate("create")} />;

  return <AppShell
    view={view}
    hasVault={snapshot !== null}
    connected={wallet.connected}
    address={wallet.address}
    connecting={walletConnecting || wallet.connecting}
    walletError={walletError}
    onNavigate={navigate}
    onConnect={connectWallet}
    onDisconnect={() => { setWalletError(null); void wallet.disconnect(); }}
  >{content}</AppShell>;
}

export type WalletConnectStep<TWalletName extends string = string> =
  | { kind: "select"; walletName: TWalletName }
  | { kind: "connect" }
  | { kind: "unavailable" };

/** The React adapter's selection update is asynchronous, so connect only after
 * useWallet() exposes the selected adapter on a subsequent render. */
export function planWalletConnectStep<TWalletName extends string>(
  selectedWalletName: TWalletName | null,
  detectedWalletName: TWalletName | null,
): WalletConnectStep<TWalletName> {
  if (!detectedWalletName) return { kind: "unavailable" };
  if (selectedWalletName !== detectedWalletName) {
    return { kind: "select", walletName: detectedWalletName };
  }
  return { kind: "connect" };
}

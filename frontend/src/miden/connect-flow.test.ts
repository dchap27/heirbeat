import { describe, expect, it, vi } from "vitest";
import { planWalletConnectStep } from "./connect-flow";

describe("wallet connect selection lifecycle", () => {
  it("selects on the first click and only connects after selection is visible", () => {
    const select = vi.fn();
    const connect = vi.fn();
    const detectedName = "Miden Wallet";

    const firstClick = planWalletConnectStep(null, detectedName);
    expect(firstClick).toEqual({ kind: "select", walletName: detectedName });
    if (firstClick.kind === "select") select(firstClick.walletName);
    expect(select).toHaveBeenCalledOnce();
    expect(connect).not.toHaveBeenCalled();

    const afterProviderRender = planWalletConnectStep(detectedName, detectedName);
    expect(afterProviderRender).toEqual({ kind: "connect" });
    if (afterProviderRender.kind === "connect") connect();
    expect(connect).toHaveBeenCalledOnce();
  });

  it("connects directly when the detected adapter is already selected", () => {
    expect(planWalletConnectStep("Miden Wallet", "Miden Wallet")).toEqual({ kind: "connect" });
  });

  it("reselects after the provider clears selection following a failed connect", () => {
    expect(planWalletConnectStep(null, "Miden Wallet")).toEqual({ kind: "select", walletName: "Miden Wallet" });
  });

  it("does not select or connect when no wallet is detected", () => {
    expect(planWalletConnectStep(null, null)).toEqual({ kind: "unavailable" });
  });
});

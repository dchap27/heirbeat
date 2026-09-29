// @vitest-environment jsdom
import { act, createElement } from "react";
import type { ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Transaction } from "@miden-sdk/miden-wallet-adapter";

const mocks = vi.hoisted(() => ({ publicPreflight: vi.fn(), complete: vi.fn(), nativeBalance: vi.fn(), prepare: vi.fn(), verify: vi.fn() }));
vi.mock("../domain/lifecycle", () => ({ normalizeAccountId: (value: string) => value === "test-owner-address" || value === "test-owner-address-2" ? "0x528f6ca64fdf62410c36b5e00c4521" : value.toLowerCase() }));
vi.mock("../miden/bootstrap-funding-preview", () => ({
  BOOTSTRAP_PREVIEW_OWNER_ID: "0x528f6ca64fdf62410c36b5e00c4521",
  BOOTSTRAP_PREVIEW_VAULT_ID: "0x27c655040bca51d14069e50380bf6f",
  preflightBootstrapPublic: mocks.publicPreflight,
  completeBootstrapFundingPreflight: mocks.complete,
  nativeBalanceFromWalletAssets: mocks.nativeBalance,
  mapBootstrapWalletOutcome: (transactionId: string | null | undefined, error?: unknown) => error ? { kind: "wallet_rejected_or_failed" } : transactionId ? { kind: "transaction_id_returned", transactionId } : { kind: "resolved_without_id", transactionId: null },
  verifyBootstrapAfterCancel: mocks.verify,
}));
vi.mock("../miden/bootstrap-requests", () => ({ prepareBootstrapFundingWalletRequest: mocks.prepare }));
import { BOOTSTRAP_PREVIEW_OWNER_ID, BOOTSTRAP_PREVIEW_VAULT_ID } from "../miden/bootstrap-funding-preview";
import { BootstrapFundingPreview } from "./BootstrapFundingPreview";

const ownerAddress = "test-owner-address";
const publicResult = {
  ownerAccountId: BOOTSTRAP_PREVIEW_OWNER_ID, vaultAccountId: BOOTSTRAP_PREVIEW_VAULT_ID,
  referenceBlock: 100, verificationBaseFee: "10", nativeFeeFaucet: "0x18101fa522c174b165efd4f70a0385",
  p2idAmount: "1", sponsorshipAmount: "150", featureNoteStatusBefore: "not_found",
  sponsorshipNoteStatusBefore: "not_found", vaultExists: false,
};
const completeResult = { ...publicResult, ownerNativeBalance: "1000", feeReserve: "170", requiredNativeBalance: "321" };

let mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
function mount(props: Partial<ComponentProps<typeof BootstrapFundingPreview>> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (overrides: Partial<ComponentProps<typeof BootstrapFundingPreview>> = {}) => act(() => root.render(createElement(BootstrapFundingPreview, {
    connectedAddress: ownerAddress,
    walletConnected: true,
    requestAssets: async () => [],
    requestTransaction: async () => "",
    ...props,
    ...overrides,
  })));
  render();
  const entry = { root, container, render };
  mounted.push(entry);
  return entry;
}
function button(container: HTMLDivElement, label: string): HTMLButtonElement {
  return [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(label))!;
}
async function click(target: HTMLButtonElement) {
  await act(async () => { target.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mounted = [];
  mocks.publicPreflight.mockReset().mockResolvedValue(publicResult);
  mocks.complete.mockReset().mockReturnValue(completeResult);
  mocks.nativeBalance.mockReset().mockReturnValue(1000n);
  mocks.prepare.mockReset().mockReturnValue({ walletRequest: { type: "custom" }, summary: {
    kind: "bootstrap", featureType: "public", featureSender: BOOTSTRAP_PREVIEW_OWNER_ID,
    targetVaultId: BOOTSTRAP_PREVIEW_VAULT_ID, featureNoteId: "0xfeature", sponsorshipNoteId: "0xsponsor",
    featureScriptRoot: "p2id", sponsorshipScriptRoot: "sponsor", featureAmount: "1", sponsorshipAmount: "150",
    sponsorshipFeatureNoteId: "0xfeature", requiredNativeOutputs: "151", outputNoteCount: 2,
    walletEnvelope: { type: "custom", sender: BOOTSTRAP_PREVIEW_OWNER_ID, recipient: BOOTSTRAP_PREVIEW_VAULT_ID },
  } });
});
afterEach(() => {
  for (const entry of mounted) act(() => entry.root.unmount());
  for (const entry of mounted) entry.container.remove();
});

describe("development bootstrap balance authorization and transaction preview", () => {
  it("wrong owner blocks before public preflight or either wallet method", async () => {
    const requestAssets = vi.fn();
    const requestTransaction = vi.fn();
    const app = mount({ connectedAddress: "0x4181277bcf64381105ee61baadb5bc", requestAssets, requestTransaction });
    await click(button(app.container, "Authorize wallet balance check"));
    expect(mocks.publicPreflight).not.toHaveBeenCalled();
    expect(requestAssets).not.toHaveBeenCalled();
    expect(requestTransaction).not.toHaveBeenCalled();
    expect(app.container.textContent).toContain("Stage: verify_owner");
  });

  it("requires a separate click and passes all public gates before requestAssets only", async () => {
    let release!: (value: typeof publicResult) => void;
    mocks.publicPreflight.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const requestAssets = vi.fn(async () => [{ faucetId: "native-bech32", amount: "1000" }]);
    const requestTransaction = vi.fn();
    const app = mount({ requestAssets, requestTransaction });
    expect(requestAssets).not.toHaveBeenCalled();
    expect(requestTransaction).not.toHaveBeenCalled();
    await act(async () => { button(app.container, "Authorize wallet balance check").dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
    expect(mocks.publicPreflight).toHaveBeenCalledOnce();
    expect(requestAssets).not.toHaveBeenCalled();
    expect(requestTransaction).not.toHaveBeenCalled();
    await act(async () => { release(publicResult); await Promise.resolve(); });
    expect(requestAssets).toHaveBeenCalledOnce();
    expect(requestTransaction).not.toHaveBeenCalled();
    expect(mocks.nativeBalance).toHaveBeenCalledOnce();
    expect(app.container.textContent).toContain("Wallet asset visibility was authorized");
    expect(button(app.container, "Preview bootstrap funding transaction").disabled).toBe(false);
  });

  it("wallet asset rejection leaves transaction preview disabled and is not labeled transaction cancellation", async () => {
    const requestAssets = vi.fn().mockRejectedValue(new Error("NOT_GRANTED"));
    const requestTransaction = vi.fn();
    const app = mount({ requestAssets, requestTransaction });
    await click(button(app.container, "Authorize wallet balance check"));
    expect(requestAssets).toHaveBeenCalledOnce();
    expect(requestTransaction).not.toHaveBeenCalled();
    expect(button(app.container, "Preview bootstrap funding transaction").disabled).toBe(true);
    expect(app.container.textContent).toContain("No bootstrap transaction was requested");
    expect(app.container.textContent).not.toContain("canceled in wallet");
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("uses requestTransaction only after a fresh preflight and does not repeat requestAssets", async () => {
    const requestAssets = vi.fn(async () => [{ faucetId: "native-bech32", amount: "1000" }]);
    let releaseWallet!: (value: string) => void;
    const requestTransaction = vi.fn((_transaction: Transaction) => new Promise<string>((resolve) => { releaseWallet = resolve; }));
    const app = mount({ requestAssets, requestTransaction });
    await click(button(app.container, "Authorize wallet balance check"));
    expect(requestAssets).toHaveBeenCalledOnce();
    expect(requestTransaction).not.toHaveBeenCalled();
    await click(button(app.container, "Preview bootstrap funding transaction"));
    expect(mocks.publicPreflight).toHaveBeenCalledTimes(2);
    expect(requestAssets).toHaveBeenCalledOnce();
    expect(requestTransaction).toHaveBeenCalledOnce();
    expect(requestTransaction.mock.calls[0][0].type).toBe("custom");
    expect(app.container.textContent).toContain("Transaction preview: request pending");
    const diagnostics = app.container.querySelector("details.developer-details:last-of-type pre")?.textContent ?? "";
    expect(diagnostics).toContain('"method": "requestAssets"');
    expect(diagnostics).toContain('"method": "requestTransaction"');
    await act(async () => { releaseWallet(""); await Promise.resolve(); });
  });

  it("insufficient balance never invokes requestTransaction", async () => {
    mocks.complete.mockImplementation(() => { throw Object.assign(new Error("insufficient"), { stage: "fee_preflight" }); });
    const requestAssets = vi.fn(async () => [{ faucetId: "native-bech32", amount: "10" }]);
    const requestTransaction = vi.fn();
    const app = mount({ requestAssets, requestTransaction });
    await click(button(app.container, "Authorize wallet balance check"));
    expect(button(app.container, "Preview bootstrap funding transaction").disabled).toBe(true);
    expect(requestTransaction).not.toHaveBeenCalled();
  });

  it("refreshes the base fee before the transaction step and recalculates required funds", async () => {
    mocks.publicPreflight.mockResolvedValueOnce(publicResult).mockResolvedValueOnce({ ...publicResult, verificationBaseFee: "20" });
    const requestAssets = vi.fn(async () => [{ faucetId: "native-bech32", amount: "1000" }]);
    const requestTransaction = vi.fn(async () => "");
    const app = mount({ requestAssets, requestTransaction });
    await click(button(app.container, "Authorize wallet balance check"));
    await click(button(app.container, "Preview bootstrap funding transaction"));
    expect(mocks.complete).toHaveBeenLastCalledWith(expect.objectContaining({ verificationBaseFee: "20" }), 1000n);
    expect(requestAssets).toHaveBeenCalledOnce();
    expect(requestTransaction).toHaveBeenCalledOnce();
  });

  it("account change immediately invalidates the prior balance authorization", async () => {
    const requestAssets = vi.fn(async () => [{ faucetId: "native-bech32", amount: "1000" }]);
    const requestTransaction = vi.fn();
    const app = mount({ requestAssets, requestTransaction });
    await click(button(app.container, "Authorize wallet balance check"));
    expect(button(app.container, "Preview bootstrap funding transaction").disabled).toBe(false);
    app.render({ connectedAddress: "0x4181277bcf64381105ee61baadb5bc" });
    expect(button(app.container, "Preview bootstrap funding transaction").disabled).toBe(true);
    expect(requestTransaction).not.toHaveBeenCalled();
  });

  it("post-cancel verification does not request wallet assets a second time", async () => {
    mocks.verify.mockResolvedValue({
      classification: "CANCEL_PREVIEW_PROVEN_NO_CHAIN_MUTATION", safeCancelConfirmed: true,
      manualCancelConfirmed: true, transactionId: null, vaultExecutionInvoked: false, publicRpcMutationInvoked: false,
      vaultExists: false, featureNoteStatus: "not_found", sponsorshipNoteStatus: "not_found",
      ownerNativeBefore: "1000", ownerNativeAfter: null, ownerNativeBalanceUnchanged: null,
      accountHistory: "not_available_from_public_rpc",
    });
    const requestAssets = vi.fn(async () => [{ faucetId: "native-bech32", amount: "1000" }]);
    const requestTransaction = vi.fn(async () => "");
    const app = mount({ requestAssets, requestTransaction });
    await click(button(app.container, "Authorize wallet balance check"));
    await click(button(app.container, "Preview bootstrap funding transaction"));
    const cancelCheck = app.container.querySelector("input[type=checkbox]")!;
    await act(async () => { cancelCheck.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await click(button(app.container, "I canceled the transaction review"));
    expect(mocks.verify).toHaveBeenCalledOnce();
    expect(requestAssets).toHaveBeenCalledOnce();
    expect(requestTransaction).toHaveBeenCalledOnce();
  });
});

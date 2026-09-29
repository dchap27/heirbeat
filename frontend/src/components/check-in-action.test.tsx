// @vitest-environment jsdom
import { act, createElement } from "react";
import type { ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultSnapshot } from "../domain/types";

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("@miden-sdk/miden-sdk", () => ({
  AccountId: class MockAccountId {
    constructor(private readonly value: string) {}
    static fromHex(value: string) { return new this(value.toLowerCase()); }
    toString() { return this.value; }
    free() {}
  },
  Address: class MockAddress {
    static fromBech32() { throw new Error("Unexpected Bech32 input in this test."); }
  },
}));
vi.mock("../miden/check-in", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../miden/check-in")>();
  return { ...actual, refreshCheckInStatus: mocks.refresh };
});
import type { CheckInRecord } from "../domain/check-in";
import type { CheckInAction as CheckInActionType } from "./CheckInAction";

const owner = "0xa61714a99ec7619109e397cbac32cd";
const snapshot: VaultSnapshot = {
  accountId: "0xc01fe4f8003940514cdfc0bb2be577", owner, beneficiary: "0x4181277bcf64381105ee61baadb5bc",
  faucet: "0x4020542183b9643120d0192be38793", nativeFeeFaucet: "0x18101fa522c174b165efd4f70a0385",
  timeoutBlocks: 10n, lastCheckIn: 100n, activated: true, claimed: false, inheritedBalance: 1n,
  nativeBalance: 0n, noteAllowlist: [], transactionScriptAllowlist: [], currentReferenceBlock: 101,
  verificationBaseFee: 2n,
};
const record: CheckInRecord = {
  vaultId: snapshot.accountId, state: "ntx_pending", featureNoteId: "0xfeature", sponsorshipNoteId: "0xsponsor",
  walletTransactionId: "0xtx", preLastCheckIn: "100",
};

let CheckInAction: typeof CheckInActionType;
beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ CheckInAction } = await import("./CheckInAction"));
});

function mount(props: Partial<ComponentProps<typeof CheckInAction>> = {}): { root: Root; container: HTMLDivElement } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(createElement(CheckInAction, {
    snapshot, endpoint: "https://rpc.testnet.miden.io", connectedAccount: owner, walletConnected: true,
    requestAssets: async () => [{ faucetId: snapshot.nativeFeeFaucet, amount: "500" }],
    requestTransaction: async () => "tx", onRecord: () => {}, onSnapshot: () => {}, ...props,
  })));
  return { root, container };
}

let mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
beforeEach(() => { mocks.refresh.mockReset(); mounted = []; });
afterEach(() => {
  for (const { root } of mounted) act(() => root.unmount());
  for (const { container } of mounted) container.remove();
});

describe("check-in action interactions", () => {
  it("does not invoke the wallet when the native sponsorship preflight fails", async () => {
    const requestAssets = vi.fn(async () => [{ faucetId: snapshot.nativeFeeFaucet, amount: "183" }]);
    const requestTransaction = vi.fn(async () => "tx");
    const onRecord = vi.fn();
    const app = mount({ requestAssets, requestTransaction, onRecord });
    mounted.push(app);
    await act(async () => { app.container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(requestAssets).toHaveBeenCalledOnce();
    expect(requestTransaction).not.toHaveBeenCalled();
    expect(onRecord).toHaveBeenLastCalledWith(expect.objectContaining({ state: "failed", diagnostic: expect.objectContaining({ stage: "fee_preflight" }) }));
  });

  it("blocks duplicate rapid clicks while preparation is unresolved", async () => {
    let release!: (assets: Array<{ faucetId: string; amount: string }>) => void;
    const requestAssets = vi.fn(() => new Promise<Array<{ faucetId: string; amount: string }>>((resolve) => { release = resolve; }));
    const requestTransaction = vi.fn(async () => "tx");
    const app = mount({ requestAssets, requestTransaction });
    mounted.push(app);
    const button = app.container.querySelector("button")!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(requestAssets).toHaveBeenCalledOnce();
    expect(requestTransaction).not.toHaveBeenCalled();
    await act(async () => { release([{ faucetId: snapshot.nativeFeeFaucet, amount: "0" }]); await Promise.resolve(); });
    expect(requestTransaction).not.toHaveBeenCalled();
  });

  it("uses Retry status check as a read-only action without another wallet request", async () => {
    mocks.refresh.mockResolvedValue({ record, snapshot: undefined });
    const requestAssets = vi.fn(async () => [{ faucetId: snapshot.nativeFeeFaucet, amount: "500" }]);
    const requestTransaction = vi.fn(async () => "tx");
    const app = mount({ record, requestAssets, requestTransaction });
    mounted.push(app);
    const retry = [...app.container.querySelectorAll("button")].find((button) => button.textContent === "Retry status check")!;
    await act(async () => retry.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(requestAssets).not.toHaveBeenCalled();
    expect(requestTransaction).not.toHaveBeenCalled();
  });
});

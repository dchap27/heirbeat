import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { AccountId, Address, NetworkId } from "@miden-sdk/miden-sdk";
import { BOOTSTRAP_PREVIEW_OWNER_ID, BOOTSTRAP_PREVIEW_VAULT_ID, completeBootstrapFundingPreflight, mapBootstrapWalletOutcome, nativeBalanceFromWalletAssets, preflightBootstrapFunding, preflightBootstrapPublic, readPublicOwnerNativeBalance, verifyBootstrapAfterCancel, type BootstrapNetworkPreflight } from "./bootstrap-funding-preview";
import { prepareBootstrapFundingWalletRequest } from "./bootstrap-requests";
import { NATIVE_FEE_FAUCET_ID } from "./endpoints";
import type { NoteInspection } from "./preview-evidence";

const beneficiary = "0x4181277bcf64381105ee61baadb5bc";
const inherited = "0x4020542183b9643120d0192be38793";
const ownerAddress = Address.fromAccountId(AccountId.fromHex(BOOTSTRAP_PREVIEW_OWNER_ID), "BasicWallet").toBech32(NetworkId.testnet());
const ownerNativeBalance = 1000n;

function prepared() {
  return prepareBootstrapFundingWalletRequest({
    vaultHex: BOOTSTRAP_PREVIEW_VAULT_ID,
    senderAccountIdHex: BOOTSTRAP_PREVIEW_OWNER_ID,
    senderWalletAddress: ownerAddress,
  });
}

function network(overrides: Partial<BootstrapNetworkPreflight> = {}): BootstrapNetworkPreflight {
  return {
    referenceBlock: 100,
    verificationBaseFee: 10n,
    feeFaucetId: NATIVE_FEE_FAUCET_ID,
    vaultExists: false,
    ...overrides,
  };
}

function absent(noteId: string, label: string): NoteInspection {
  return { label, noteId, classification: "not_found", operations: [] };
}

describe("cancel-only bootstrap wallet preview", () => {
  it("builds an owner-sent custom transaction with exactly the paired P2ID and sponsorship outputs", () => {
    const request = prepared();
    expect(request.walletRequest.type).toBe("custom");
    expect(request.summary.walletEnvelope.sender).toBe(ownerAddress);
    expect(request.summary.walletEnvelope.sender).not.toBe(BOOTSTRAP_PREVIEW_VAULT_ID);
    expect(request.summary.targetVaultId).toBe(BOOTSTRAP_PREVIEW_VAULT_ID);
    expect(request.summary.outputNoteCount).toBe(2);
    expect(request.summary.featureAmount).toBe("1");
    expect(request.summary.sponsorshipAmount).toBe("150");
    expect(request.summary.featureAsset).toBe(NATIVE_FEE_FAUCET_ID);
    expect(request.summary.sponsorshipAsset).toBe(NATIVE_FEE_FAUCET_ID);
    expect(request.summary.sponsorshipFeatureNoteId).toBe(request.summary.featureNoteId);
    expect(request.summary.featureScriptRoot).not.toBe(request.summary.sponsorshipScriptRoot);
    expect(request.summary.submitted).toBe(false);
    expect(request.summary.walletInvoked).toBe(false);
  });

  it("blocks a different or malformed owner before network reads or wallet invocation", async () => {
    const networkRead = vi.fn(async () => network());
    await expect(preflightBootstrapFunding({ connectedAddress: beneficiary, ownerNativeBalance, request: prepared(), networkRead }))
      .rejects.toMatchObject({ stage: "verify_owner" });
    await expect(preflightBootstrapFunding({ connectedAddress: "mtst1-invalid", ownerNativeBalance, request: prepared(), networkRead }))
      .rejects.toMatchObject({ stage: "verify_owner" });
    expect(networkRead).not.toHaveBeenCalled();
  });

  it("fails closed for private owner state instead of requesting wallet assets", async () => {
    const rpcFactory = vi.fn(() => ({
      getAccountDetails: async () => ({ isPrivate: () => true, account: () => undefined, free: vi.fn() }),
      free: vi.fn(),
    }) as never);
    await expect(readPublicOwnerNativeBalance("https://rpc.testnet.miden.io", BOOTSTRAP_PREVIEW_OWNER_ID, rpcFactory))
      .rejects.toMatchObject({ stage: "read_owner_balance" });
    expect(rpcFactory).toHaveBeenCalledOnce();
  });

  it("reads a public owner's native balance without wallet methods and releases RPC wrappers", async () => {
    const cleanup = { vault: vi.fn(), account: vi.fn(), fetched: vi.fn(), rpc: vi.fn() };
    const rpcFactory = vi.fn(() => ({
      getAccountDetails: async () => ({
        isPrivate: () => false,
        account: () => ({ vault: () => ({ getBalance: () => 900n, free: cleanup.vault }), free: cleanup.account }),
        free: cleanup.fetched,
      }),
      free: cleanup.rpc,
    }) as never);
    await expect(readPublicOwnerNativeBalance("https://rpc.testnet.miden.io", BOOTSTRAP_PREVIEW_OWNER_ID, rpcFactory)).resolves.toBe(900n);
    expect(Object.values(cleanup).every((free) => free.mock.calls.length === 1)).toBe(true);
  });

  it("fails closed for a deployed vault, wrong target, mismatched sponsorship, unexpected script, or inherited asset", async () => {
    const valid = prepared();
    const notes = (req: typeof valid) => [absent(req.summary.featureNoteId, "feature"), absent(req.summary.sponsorshipNoteId, "sponsor")];
    const noteRead = vi.fn(async (_endpoint: string, label: string, noteId: string) =>
      label === "bootstrap_p2id" ? absent(noteId, "feature") : absent(noteId, "sponsor"));
    await expect(preflightBootstrapFunding({ connectedAddress: ownerAddress, ownerNativeBalance, request: valid, networkRead: async () => network({ vaultExists: true }), noteRead }))
      .rejects.toMatchObject({ stage: "check_vault_absent" });
    const wrongTarget = { ...valid, summary: { ...valid.summary, targetVaultId: beneficiary } };
    await expect(preflightBootstrapFunding({ connectedAddress: ownerAddress, ownerNativeBalance, request: wrongTarget, networkRead: vi.fn() as never, noteRead }))
      .rejects.toMatchObject({ stage: "verify_vault" });
    const unpaired = { ...valid, summary: { ...valid.summary, sponsorshipFeatureNoteId: beneficiary } };
    await expect(preflightBootstrapFunding({ connectedAddress: ownerAddress, ownerNativeBalance, request: unpaired, networkRead: async () => network(), noteRead }))
      .rejects.toMatchObject({ stage: "validate_request" });
    const wrongScript = { ...valid, summary: { ...valid.summary, sponsorshipScriptRoot: "0x01" } };
    await expect(preflightBootstrapFunding({ connectedAddress: ownerAddress, ownerNativeBalance, request: wrongScript, networkRead: async () => network(), noteRead }))
      .rejects.toMatchObject({ stage: "validate_request" });
    const inheritedOutput = { ...valid, summary: { ...valid.summary, featureAsset: inherited } };
    await expect(preflightBootstrapFunding({ connectedAddress: ownerAddress, ownerNativeBalance, request: inheritedOutput, networkRead: async () => network(), noteRead }))
      .rejects.toMatchObject({ stage: "validate_request" });
    expect(notes(valid)).toHaveLength(2);
  });

  it("blocks on unknown or committed note evidence, mismatched fee faucet, and insufficient native balance", async () => {
    const request = prepared();
    const noteRead = vi.fn(async (_endpoint: string, label: string, noteId: string) =>
      label === "bootstrap_p2id" ? absent(noteId, "feature") : absent(noteId, "sponsor"));
    await expect(preflightBootstrapFunding({ connectedAddress: ownerAddress, ownerNativeBalance, request, networkRead: async () => network({ feeFaucetId: inherited }), noteRead }))
      .rejects.toMatchObject({ stage: "verify_fee_asset" });
    await expect(preflightBootstrapFunding({ connectedAddress: ownerAddress, ownerNativeBalance: 320n, request, networkRead: async () => network(), noteRead }))
      .rejects.toMatchObject({ stage: "fee_preflight" });
    await expect(preflightBootstrapFunding({
      connectedAddress: ownerAddress,
      ownerNativeBalance,
      request,
      networkRead: async () => network(),
      noteRead: async (_endpoint, label, noteId) => label === "bootstrap_p2id"
        ? { ...absent(noteId, label), classification: "committed_unconsumed" }
        : absent(noteId, label),
    })).rejects.toMatchObject({ stage: "check_feature_note_absent" });
  });

  it("uses the shared 17x fee policy and confirms both deterministic note IDs are initially absent", async () => {
    const request = prepared();
    const result = await preflightBootstrapFunding({
      connectedAddress: ownerAddress,
      ownerNativeBalance,
      request,
      networkRead: async () => network({ verificationBaseFee: 10n }),
      noteRead: async (_endpoint, label, noteId) => absent(noteId, label),
    });
    expect(result.referenceBlock).toBe(100);
    expect(result.verificationBaseFee).toBe("10");
    expect(result.p2idAmount).toBe("1");
    expect(result.sponsorshipAmount).toBe("150");
    expect(result.feeReserve).toBe("170");
    expect(result.requiredNativeBalance).toBe("321");
    expect(result.featureNoteStatusBefore).toBe("not_found");
    expect(result.sponsorshipNoteStatusBefore).toBe("not_found");
    expect(result.vaultExists).toBe(false);
  });

  it("passes the public gates before balance disclosure, then recalculates fee from the current base fee", async () => {
    const request = prepared();
    const publicResult = await preflightBootstrapPublic({
      connectedAddress: ownerAddress,
      request,
      networkRead: async () => network({ verificationBaseFee: 20n }),
      noteRead: async (_endpoint, label, noteId) => absent(noteId, label),
    });
    expect(publicResult.vaultExists).toBe(false);
    expect(publicResult.featureNoteStatusBefore).toBe("not_found");
    expect(publicResult.sponsorshipNoteStatusBefore).toBe("not_found");
    const completed = completeBootstrapFundingPreflight(publicResult, 500n);
    expect(completed.feeReserve).toBe("340");
    expect(completed.requiredNativeBalance).toBe("491");
    expect(() => completeBootstrapFundingPreflight(publicResult, 490n)).toThrow(/Insufficient native balance/);
  });

  it("extracts only native MIDEN by canonical faucet identity", () => {
    const nativeBech32 = Address.fromAccountId(AccountId.fromHex(NATIVE_FEE_FAUCET_ID), "BasicWallet").toBech32(NetworkId.testnet());
    const unrelatedBech32 = Address.fromAccountId(AccountId.fromHex(inherited), "BasicWallet").toBech32(NetworkId.testnet());
    expect(nativeBalanceFromWalletAssets([
      { faucetId: unrelatedBech32, amount: "900000" },
      { faucetId: nativeBech32, amount: "12" },
      { faucetId: NATIVE_FEE_FAUCET_ID, amount: "8" },
    ])).toBe(20n);
    expect(nativeBalanceFromWalletAssets([{ faucetId: unrelatedBech32, amount: "900000" }])).toBe(0n);
  });

  it("does not call transaction APIs for a read-only post-cancel check and confirms absent notes/vault", async () => {
    const request = prepared();
    const evidence = await verifyBootstrapAfterCancel({
      request: request.summary,
      manualCancelConfirmed: true,
      transactionId: null,
      ownerNativeBefore: "1000",
      readOwnerNativeBalance: async () => 1000n,
      networkRead: async () => network(),
      noteRead: async (_endpoint, label, noteId) => absent(noteId, label),
    });
    expect(evidence.safeCancelConfirmed).toBe(true);
    expect(evidence.classification).toBe("CANCEL_PREVIEW_PROVEN_NO_CHAIN_MUTATION");
    expect(evidence.vaultExists).toBe(false);
    expect(evidence.featureNoteStatus).toBe("not_found");
    expect(evidence.sponsorshipNoteStatus).toBe("not_found");
    expect(evidence.ownerNativeBalanceUnchanged).toBe(true);
    expect(evidence.accountHistory).toBe("not_available_from_public_rpc");

  });

  it("proves cancel with both notes absent even when a private owner balance cannot be re-read", async () => {
    const request = prepared();
    const readBalance = vi.fn();
    const evidence = await verifyBootstrapAfterCancel({
      request: request.summary,
      manualCancelConfirmed: true,
      transactionId: null,
      ownerNativeBefore: "12345",
      networkRead: async () => network({ vaultExists: false }),
      noteRead: async (_endpoint, label, noteId) => absent(noteId, label),
    });
    expect(readBalance).not.toHaveBeenCalled();
    expect(evidence.ownerNativeBefore).toBe("12345");
    expect(evidence.ownerNativeAfter).toBeNull();
    expect(evidence.ownerNativeBalanceUnchanged).toBeNull();
    expect(evidence.accountHistory).toBe("not_available_from_public_rpc");
    expect(evidence.classification).toBe("CANCEL_PREVIEW_PROVEN_NO_CHAIN_MUTATION");
    expect(evidence.safeCancelConfirmed).toBe(true);
  });

  it("classifies found notes or a changed observable owner balance as unexpected evidence", async () => {
    const request = prepared();
    const found = await verifyBootstrapAfterCancel({
      request: request.summary, manualCancelConfirmed: true, transactionId: null, ownerNativeBefore: "1000",
      readOwnerNativeBalance: async () => 900n,
      networkRead: async () => network(),
      noteRead: async (_endpoint, label, noteId) => label === "bootstrap_p2id"
        ? { label, noteId, classification: "committed_unconsumed", inclusionFound: true, operations: [] }
        : absent(noteId, label),
    });
    expect(found.classification).toBe("UNEXPECTED_CHAIN_EVIDENCE");
    expect(found.safeCancelConfirmed).toBe(false);

    const sponsorFound = await verifyBootstrapAfterCancel({
      request: request.summary, manualCancelConfirmed: true, transactionId: null, ownerNativeBefore: null,
      networkRead: async () => network(),
      noteRead: async (_endpoint, label, noteId) => label === "bootstrap_sponsorship"
        ? { label, noteId, classification: "committed_unconsumed", inclusionFound: true, operations: [] }
        : absent(noteId, label),
    });
    expect(sponsorFound.classification).toBe("UNEXPECTED_CHAIN_EVIDENCE");
    expect(sponsorFound.safeCancelConfirmed).toBe(false);

    const changedBalance = await verifyBootstrapAfterCancel({
      request: request.summary, manualCancelConfirmed: true, transactionId: null, ownerNativeBefore: "1000",
      readOwnerNativeBalance: async () => 900n,
      networkRead: async () => network(),
      noteRead: async (_endpoint, label, noteId) => absent(noteId, label),
    });
    expect(changedBalance.ownerNativeBalanceUnchanged).toBe(false);
    expect(changedBalance.classification).toBe("UNEXPECTED_CHAIN_EVIDENCE");
  });

  it("requires manual cancel confirmation and no local execution or RPC mutation", async () => {
    const request = prepared();
    const verify = (overrides: Partial<Parameters<typeof verifyBootstrapAfterCancel>[0]>) => verifyBootstrapAfterCancel({
      request: request.summary, manualCancelConfirmed: true, transactionId: null, ownerNativeBefore: null,
      networkRead: async () => network(), noteRead: async (_endpoint, label, noteId) => absent(noteId, label),
      ...overrides,
    });
    expect((await verify({ manualCancelConfirmed: false })).classification).toBe("CANCEL_PREVIEW_INCOMPLETE");
    expect((await verify({ vaultExecutionInvoked: true })).classification).toBe("UNEXPECTED_CHAIN_EVIDENCE");
    expect((await verify({ publicRpcMutationInvoked: true })).classification).toBe("UNEXPECTED_CHAIN_EVIDENCE");
    await expect(verify({ transactionId: "0xreturned" })).rejects.toMatchObject({ stage: "post_cancel_hard_stop" });
  });

  it("keeps unknown note status incomplete rather than treating it as absence", async () => {
    const request = prepared();
    const evidence = await verifyBootstrapAfterCancel({
      request: request.summary, manualCancelConfirmed: true, transactionId: null, ownerNativeBefore: null,
      networkRead: async () => network(),
      noteRead: async (_endpoint, label, noteId) => ({ label, noteId, classification: "query_error", operations: [] }),
    });
    expect(evidence.classification).toBe("CANCEL_PREVIEW_INCOMPLETE");
    expect(evidence.safeCancelConfirmed).toBe(false);
  });

  it("does not infer cancellation from adapter rejection and hard-stops if an ID is returned", async () => {
    const rejected = mapBootstrapWalletOutcome(null, Object.assign(new Error("NOT_GRANTED"), { name: "WalletTransactionError" }));
    expect(rejected.kind).toBe("wallet_rejected_or_failed");
    const returned = mapBootstrapWalletOutcome("0xtransaction");
    expect(returned).toEqual({ kind: "transaction_id_returned", transactionId: "0xtransaction" });
    await expect(verifyBootstrapAfterCancel({
      request: prepared().summary,
      manualCancelConfirmed: true,
      transactionId: "0xtransaction",
      ownerNativeBefore: "1000",
      readOwnerNativeBalance: async () => 1000n,
      networkRead: vi.fn() as never,
    })).rejects.toMatchObject({ stage: "post_cancel_hard_stop" });
  });

  it("keeps the preview development-only and has no vault execution or submission path", () => {
    const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    const previewSource = readFileSync(new URL("./bootstrap-funding-preview.ts", import.meta.url), "utf8");
    expect(appSource).toContain("import.meta.env.DEV");
    expect(appSource).toContain("BootstrapFundingPreview");
    const componentSource = readFileSync(new URL("../components/BootstrapFundingPreview.tsx", import.meta.url), "utf8");
    expect(previewSource).not.toMatch(/executeRequest|submitNewTransaction|requestConsume/);
    expect(componentSource).toContain("requestTransaction(request.walletRequest)");
    expect(componentSource).toContain("requestAssets()");
    expect(componentSource).toContain("public preflight and a sufficient wallet-authorized native balance");
    expect(componentSource).not.toMatch(/requestConsume|submitNewTransaction|executeRequest/);
    expect(componentSource).toContain('method: "requestTransaction"');
  });
});

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountId, Address, NetworkId, NoteScript, NoteType, NetworkAccountTarget } from "@miden-sdk/miden-sdk";
import type { VaultSnapshot } from "../domain/types";
import { deriveRole } from "../domain/lifecycle";
import {
  assertTerminalHeartbeatPreview,
  buildTerminalHeartbeatPreview,
  buildDisposableP2idPreview,
  canStartPreview,
  mapPreviewResult,
  heartbeatPreviewSafety,
  canPreviewDisposableP2id,
  pendingPreviewResult,
  PREVIEW_P2ID_AMOUNT,
  TERMINAL_PREVIEW_VAULT,
  HEARTBEAT_PREVIEW_DESCRIPTION,
} from "./wallet-preview";
import { TERMINAL_PREVIEW_VAULT as terminalVault } from "./wallet-preview";

const owner = "0xa61714a99ec7619109e397cbac32cd";
const beneficiary = "0x4181277bcf64381105ee61baadb5bc";
const faucet = "0x4020542183b9643120d0192be38793";
const root = resolve(import.meta.dirname, "../../..");

afterEach(() => vi.unstubAllGlobals());

async function mockArtifactFetch() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const name = new URL(String(input), "http://localhost").pathname.split("/").at(-1)?.replace(".masp", "") ?? "";
    const bytes = await readFile(resolve(root, `contracts/${name}/target/miden/release/${name}.masp`));
    return new Response(bytes, { status: 200 });
  });
}

function terminalSnapshot(): VaultSnapshot {
  return {
    accountId: TERMINAL_PREVIEW_VAULT,
    owner,
    beneficiary,
    faucet,
    nativeFeeFaucet: "0x18101fa522c174b165efd4f70a0385",
    timeoutBlocks: 10n,
    lastCheckIn: 507636n,
    activated: true,
    claimed: true,
    inheritedBalance: 0n,
    nativeBalance: 169n,
    noteAllowlist: ["check-in", "claim", "deposit"],
    transactionScriptAllowlist: ["expiration"],
    currentReferenceBlock: 507646,
  };
}

describe("manual wallet-preview safety", () => {
  const bech32Address = (hexId: string) => Address.fromAccountId(
    AccountId.fromHex(hexId),
    "BasicWallet",
  ).toBech32(NetworkId.testnet());

  it("allows only the known activated, claimed, empty vault and its owner", () => {
    expect(() => assertTerminalHeartbeatPreview(terminalSnapshot(), beneficiary)).not.toThrow();
    expect(() => assertTerminalHeartbeatPreview(terminalSnapshot(), owner)).toThrow(/different from its configured owner/);
    expect(() => assertTerminalHeartbeatPreview({ ...terminalSnapshot(), claimed: false }, beneficiary)).toThrow(/known activated, claimed, empty/);
    expect(() => assertTerminalHeartbeatPreview({ ...terminalSnapshot(), inheritedBalance: 1n }, beneficiary)).toThrow(/known activated, claimed, empty/);
    expect(() => assertTerminalHeartbeatPreview({ ...terminalSnapshot(), accountId: "0x39fcc854fe715ad1446afb9859df04" }, beneficiary)).toThrow(/known activated, claimed, empty/);
  });

  it("enables only an outsider sender on a claimed terminal vault and preserves production role derivation", () => {
    expect(heartbeatPreviewSafety(terminalSnapshot(), beneficiary).enabled).toBe(true);
    expect(heartbeatPreviewSafety(terminalSnapshot(), owner).connectedAccountDiffersFromOwner).toBe(false);
    expect(heartbeatPreviewSafety({ ...terminalSnapshot(), claimed: false }, beneficiary).enabled).toBe(false);
    expect(heartbeatPreviewSafety({ ...terminalSnapshot(), activated: false }, beneficiary).enabled).toBe(false);
    expect(heartbeatPreviewSafety({ ...terminalSnapshot(), inheritedBalance: 1n }, beneficiary).enabled).toBe(false);
    expect(deriveRole(owner, owner, beneficiary)).toBe("owner");
    expect(deriveRole(beneficiary, owner, beneficiary)).toBe("beneficiary");
    expect(deriveRole("0x39fcc854fe715ad1446afb9859df04", owner, beneficiary)).toBe("observer");
  });

  it("parses the wallet's Bech32 Address and compares its canonical AccountId to the vault owner", () => {
    const ownerAddress = bech32Address(owner);
    const otherAddress = bech32Address(beneficiary);
    expect(ownerAddress).toContain("_qr");
    expect(heartbeatPreviewSafety(terminalSnapshot(), ownerAddress).connectedAccountDiffersFromOwner).toBe(false);
    const safety = heartbeatPreviewSafety(terminalSnapshot(), otherAddress);
    expect(safety.safe).toBe(true);
    expect(safety.enabled).toBe(true);
    expect(deriveRole(ownerAddress, owner, beneficiary)).toBe("owner");
  });

  it("fails closed without throwing when wallet address or vault owner is malformed", () => {
    const malformedWallet = heartbeatPreviewSafety(terminalSnapshot(), "mtst1-not-a-valid-address");
    expect(malformedWallet.safe).toBe(false);
    expect(malformedWallet.enabled).toBe(false);
    expect(malformedWallet.reason).toMatch(/Unable to verify connected account identity/);
    expect(() => heartbeatPreviewSafety(terminalSnapshot(), "mtst1-not-a-valid-address")).not.toThrow();

    const malformedOwner = heartbeatPreviewSafety({ ...terminalSnapshot(), owner: "not-an-account-id" }, beneficiary);
    expect(malformedOwner.safe).toBe(false);
    expect(malformedOwner.enabled).toBe(false);
    expect(malformedOwner.reason).toMatch(/Unable to verify connected account identity/);
    expect(deriveRole("not-an-account-id", owner, beneficiary)).toBe("observer");
  });

  it("builds the exact paired terminal-vault heartbeat envelope for manual review", async () => {
    await mockArtifactFetch();
    const beneficiaryAddress = bech32Address(beneficiary);
    const { pair, walletRequest } = await buildTerminalHeartbeatPreview(terminalSnapshot(), beneficiaryAddress);
    expect(pair.info.targetId).toBe(terminalVault);
    expect(pair.info.executionHint).toBe("always");
    expect(pair.info.sponsorshipAmount).toBe(1n);
    expect(pair.info.sponsorshipFeatureId).toBe(pair.info.featureId);
    expect(pair.feature.metadata().sender().toString()).toBe(beneficiary);
    const attachment = NetworkAccountTarget.fromAttachment(pair.feature.attachments()[0]);
    expect(attachment.targetId().toString()).toBe(terminalVault);
    expect(attachment.executionHint().canBeConsumed(0)).toBe(true);
    expect(walletRequest.type).toBe("custom");
    expect((walletRequest.payload as { address: string }).address).toBe(beneficiaryAddress);
    expect(pair.request.expectedOutputOwnNotes().map((note) => note.id().toString())).toEqual([pair.info.featureId, pair.info.sponsorshipId]);
  });

  it("constructs a local uncommitted P2ID consume fixture with canonical recipient, asset and note bytes", () => {
    const beneficiaryAddress = bech32Address(beneficiary);
    const fixture = buildDisposableP2idPreview({ sender: TERMINAL_PREVIEW_VAULT, beneficiary: beneficiaryAddress, faucet });
    expect(fixture.committedOnChain).toBe(false);
    expect(fixture.amount).toBe(PREVIEW_P2ID_AMOUNT);
    expect(fixture.note.metadata().noteType()).toBe(NoteType.Public);
    expect(fixture.note.recipient().script().root().toHex()).toBe(NoteScript.p2id().root().toHex());
    expect(fixture.note.assets().fungibleAssets()[0].faucetId().toString()).toBe(faucet);
    expect(fixture.request.noteId).toBe(fixture.noteId);
    expect(fixture.request.faucetId).toBe(faucet);
    expect(fixture.request.amount).toBe(1);
    expect(fixture.request.noteBytes).toBe(Buffer.from(fixture.note.serialize()).toString("base64"));
    const recipient = AccountId.fromPrefixSuffix(fixture.note.recipient().storage().items()[1], fixture.note.recipient().storage().items()[0]);
    expect(recipient.toString()).toBe(beneficiary);
  });

  it("maps returned IDs, no-ID results and wallet errors without claiming rejection is chain-proven", () => {
    const submitted = mapPreviewResult({ transactionId: "tx-123" });
    expect(submitted.transactionId).toBe("tx-123");
    expect(submitted.submissionAssessment).toBe("wallet_reports_queued_or_submitted");

    const noId = mapPreviewResult(null);
    expect(noId.state).toBe("wallet_returned_no_id");
    expect(noId.message).toMatch(/does not prove chain non-submission/);

    const adapterNoId = mapPreviewResult(null, new Error("The wallet returned no transaction id — the transaction was not submitted"));
    expect(adapterNoId.state).toBe("wallet_returned_no_id");
    expect(adapterNoId.submissionAssessment).toBe("adapter_reports_not_submitted_chain_check_pending");

    const rejected = mapPreviewResult(null, new Error("User rejected"));
    expect(rejected.state).toBe("wallet_rejected_or_failed");
    expect(rejected.error).toBe("User rejected");
    expect(rejected.message).toMatch(/Cancellation is not distinguished/);
    const preflight = mapPreviewResult(null, new Error("Wrong connected account"), false);
    expect(preflight.callStarted).toBe(false);
    expect(preflight.state).toBe("preflight_failed");
    expect(preflight.submissionAssessment).toBe("not_invoked");
  });

  it("does not permit automatic or repeated wallet invocation", () => {
    expect(canStartPreview(false, false)).toBe(true);
    expect(canStartPreview(true, false)).toBe(false);
    expect(canStartPreview(false, true)).toBe(false);
  });

  it("keeps P2ID wallet handoff disabled unless the public node proves the synthetic ID absent", () => {
    expect(canPreviewDisposableP2id("not_found")).toBe(true);
    expect(canPreviewDisposableP2id("committed_unconsumed")).toBe(false);
    expect(canPreviewDisposableP2id("pending")).toBe(false);
    expect(canPreviewDisposableP2id("nullifier_committed")).toBe(false);
    expect(canPreviewDisposableP2id("query_error")).toBe(false);
    expect(canPreviewDisposableP2id(undefined)).toBe(false);
  });

  it("labels the diagnostic sender as the connected non-owner", () => {
    expect(HEARTBEAT_PREVIEW_DESCRIPTION).toMatch(/connected non-owner wallet as the feature-note sender/);
    expect(HEARTBEAT_PREVIEW_DESCRIPTION).toMatch(/already-claimed, empty terminal vault/);
  });

  it("reports the explicit in-flight wallet step before awaiting user decision", () => {
    expect(pendingPreviewResult()).toMatchObject({
      callStarted: true,
      state: "awaiting_wallet_decision",
      transactionId: null,
      submissionAssessment: "awaiting_wallet_decision",
    });
  });
});

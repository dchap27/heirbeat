import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Account, AccountBuilder, AccountId, AccountStorage, AccountStorageMode, AccountType, NoteScript, TransactionRequest, TransactionRequestBuilder } from "@miden-sdk/miden-sdk";
import { buildFeaturePair, loadFeatureScript } from "../heirbeat/feature-notes";
import {
  componentArtifactChecksums,
  constructActivationRequest,
  constructBootstrapCleanupRequest,
  constructBootstrapRequest,
} from "./bootstrap-requests";
import { summarizeRequestSerialization } from "./request-serialization";
import { constructVaultAccount, disposeOwnedAccountStorage } from "./vault-account";

const root = resolve(import.meta.dirname, "../../..");
const owner = "0x528f6ca64fdf62410c36b5e00c4521";
const beneficiary = "0x4181277bcf64381105ee61baadb5bc";
const inherited = "0x4020542183b9643120d0192be38793";
const native = "0x18101fa522c174b165efd4f70a0385";
const deterministicSeed = new Uint8Array(32).fill(0x48);

afterEach(() => vi.unstubAllGlobals());

async function mockArtifacts() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const file = path.startsWith("/miden-standards-")
      ? resolve(root, `frontend/public${path}`)
      : path.startsWith("/contracts/")
        ? resolve(root, `contracts/${path.split("/").at(-1)!.replace(".masp", "")}/target/miden/release/${path.split("/").at(-1)}`)
        : "";
    if (!file) return new Response("not found", { status: 404 });
    try { return new Response(await readFile(file), { status: 200 }); }
    catch { return new Response("not found", { status: 404 }); }
  });
}

describe("Sprint 8F browser bootstrap construction spike", () => {
  it("constructs the CLI component set and initialized policy/storage locally", async () => {
    await mockArtifacts();
    const account = await constructVaultAccount({ owner, beneficiary, inheritedFaucet: inherited, nativeFaucet: native, timeoutBlocks: 1_000_000, testSeed: deterministicSeed });
    const ownerId = AccountId.fromHex(owner);
    const beneficiaryId = AccountId.fromHex(beneficiary);
    const faucetId = AccountId.fromHex(inherited);
    expect(account.accountType).toBe("public");
    expect(account.accountStorageMode).toBe("public");
    expect(account.accountTypePublicRuntimeValue).toBe("1");
    expect(account.accountTypeExport).toContainEqual(["Public", "1"]);
    expect(account.accountPublic).toBe(true);
    expect(account.accountIdPublic).toBe(true);
    expect(account.accountIdPrefix).toMatch(/^\d+$/);
    expect(account.networkAccount).toBe(true);
    expect(account.networkNoteAllowlistCount).toBe(7);
    expect(account.componentOrder).toEqual(["heirbeat-vault", "BasicWallet", "Ownable2Step", "Authority::OwnerControlled", "AuthNetworkAccount", "AccountSchemaCommitment"]);
    expect(account.storage.owner).toEqual(["0", "0", ownerId.suffix().asInt().toString(), ownerId.prefix().asInt().toString()]);
    expect(account.storage.ownable2step_owner_config).toEqual([ownerId.suffix().asInt().toString(), ownerId.prefix().asInt().toString(), "0", "0"]);
    expect(account.storage.authority_config).toEqual(["1", "0", "0", "0"]);
    expect(account.storage.beneficiary).toEqual(["0", "0", beneficiaryId.suffix().asInt().toString(), beneficiaryId.prefix().asInt().toString()]);
    expect(account.storage.asset_faucet).toEqual(["0", "0", faucetId.suffix().asInt().toString(), faucetId.prefix().asInt().toString()]);
    expect(account.storage.timeout_blocks).toEqual(["1000000", "0", "0", "0"]);
    expect(account.storage.activated).toEqual(["0", "0", "0", "0"]);
    expect(account.storage.claimed).toEqual(["0", "0", "0", "0"]);
    expect(account.storage.last_check_in).toEqual(["0", "0", "0", "0"]);
    expect(account.noteAllowlist).toHaveLength(7);
    const featureRoots = await Promise.all(["heartbeat", "claim", "deposit", "activation"].map(async (kind) => {
      const script = await loadFeatureScript(kind as "heartbeat" | "claim" | "deposit" | "activation");
      const root = script.root().toHex(); script.free(); return root;
    }));
    const expectedNoteRoots = [
      ...featureRoots,
      NoteScript.p2id().root().toHex(),
      NoteScript.networkAccountConfig().root().toHex(),
      NoteScript.feeSponsorship().root().toHex(),
    ].sort();
    expect(account.noteAllowlist).toEqual(expectedNoteRoots);
    expect(account.transactionScriptAllowlist).toHaveLength(1);
    expect(account.transactionScriptAllowlist).toEqual(["0x1867a54736cb2ced79d878d67f25d798d9abc0cbcdcf7a4d790047fe143ba8f6"]);
    expect(account.procedureRoots.length).toBeGreaterThan(0);
    expect(account.accountCodeCommitment).toMatch(/^0x[0-9a-f]+$/i);
    expect(account.accountCodeCommitment).toBe("0x28025e4b70080b6956eeecb54a94208894b6b93db61956672ad7300cec825edc");
    expect(account.accountStorageCommitment).toBe("0xd284e73b82ab53f0c03c9c67d86b3d39826fb58c70ffab545084959426a03a4e");
    expect(account.accountStorageRuntime.constructorName).toBe("AccountStorage");
    expect(account.accountStorageRuntime.freeMethodType).toBe("function");
    expect(account.accountStorageRuntime.cleanup).toBe("freed-sdk-wrapper");
    expect(account.accountSchemaCommitment).toBe("0x5745f82e54ae1f6bfe7a84df461f5a4dcbfa1feac7178952b92e4ab562fb7448");
    expect(account.serializedAccountBase64.length).toBeGreaterThan(100);
    expect(account).not.toHaveProperty("account");
    ownerId.free(); beneficiaryId.free(); faucetId.free();
  });

  it("frees a genuine caller-owned AccountStorage wrapper once and never frees it after transfer", async () => {
    await mockArtifacts();
    const summary = await constructVaultAccount({ owner, beneficiary, inheritedFaucet: inherited, nativeFaucet: native, timeoutBlocks: 10, testSeed: deterministicSeed });
    const account = Account.deserialize(Uint8Array.from(atob(summary.serializedAccountBase64), (c) => c.charCodeAt(0)));
    const storage = account.storage();
    expect(storage).toBeInstanceOf(AccountStorage);
    const free = vi.spyOn(storage, "free");
    try {
      expect(disposeOwnedAccountStorage(storage, "caller-owned")).toBe("freed-sdk-wrapper");
      expect(disposeOwnedAccountStorage(storage, "transferred")).toBe("not-owned");
      expect(free).toHaveBeenCalledTimes(1);
    } finally {
      free.mockRestore();
      account.free();
    }
  });

  it("uses the exact checked-in miden-standards 0.16.1 Ownable2Step artifacts", async () => {
    const checksums = componentArtifactChecksums();
    for (const [key, file] of Object.entries({
      ownable2step: "miden-standards-access-ownable2step.masp",
      ownerControlledAuthority: "miden-standards-access-authority.masp",
      schemaCommitment: "miden-standards-inspection-schema-commitment.masp",
    })) {
      const bytes = await readFile(resolve(root, `frontend/public/miden-standards-0.16.1/${file}`));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(checksums[key as keyof typeof checksums]);
    }
    await mockArtifacts();
    const account = await constructVaultAccount({ owner, beneficiary, inheritedFaucet: inherited, nativeFaucet: native, timeoutBlocks: 10, testSeed: deterministicSeed });
    expect(account.storageSlots).toContain("miden::standards::access::ownable2step::owner_config");
    expect(account.storageSlots).toContain("miden::standards::access::authority::authority_config");
  });

  it("produces deterministic browser account IDs for deterministic test seed and config", async () => {
    await mockArtifacts();
    const input = { owner, beneficiary, inheritedFaucet: inherited, nativeFaucet: native, timeoutBlocks: 1_000_000, testSeed: deterministicSeed };
    const first = await constructVaultAccount(input);
    const second = await constructVaultAccount(input);
    expect(first.accountId).toBe(second.accountId);
    expect(first.accountId).toBe("0x27c655040bca51d14069e50380bf6f");
    expect(first.accountPublic).toBe(true);
    expect(first.accountIdPublic).toBe(true);
    expect(first.accountCodeCommitment).toBe(second.accountCodeCommitment);
  });

  it("uses the public storage-mode wrapper and captures fluent builder return values", async () => {
    expect(AccountType.Private).toBe(0);
    expect(AccountType.Public).toBe(1);
    const mode = AccountStorageMode.public();
    const initial = new AccountBuilder(deterministicSeed);
    try {
      expect(mode.asStr()).toBe("public");
      const configured = initial.storageMode(mode);
      expect(configured).toBeInstanceOf(AccountBuilder);
      expect(configured).not.toBe(initial);
      // The production builder assigns every fluent return before the next call.
      expect(await readFile(resolve(root, "frontend/src/miden/vault-account.ts"), "utf8"))
        .toContain("builder = builder.storageMode(publicStorageMode);");
    } finally {
      mode.free();
      // The builder wrappers are intentionally not manually freed here: the
      // test asserts return semantics only and avoids assuming pointer aliasing.
    }
  });

  it("records the browser package AccountType export shadow that invalidated the old Public call", async () => {
    const browserEntry = await readFile(resolve(root, "frontend/node_modules/@miden-sdk/miden-sdk/dist/st/index.js"), "utf8");
    expect(browserEntry).toContain("const AccountType = Object.freeze({");
    expect(browserEntry).toContain("FungibleFaucet: 0");
    expect(browserEntry).toContain("NonFungibleFaucet: 1");
    expect(browserEntry).not.toContain("Public: 1");
    const source = await readFile(resolve(root, "frontend/src/miden/vault-account.ts"), "utf8");
    expect(source).toContain("AccountStorageMode.public()");
    expect(source).not.toContain(".accountType(AccountType.Public)");
  });

  it("constructs the bootstrap P2ID and 150-unit sponsorship pair without wallet or RPC submission", () => {
    const pair = constructBootstrapRequest("0x6f93db51c660bbd129a718f903bfea", owner, native);
    expect(pair.kind).toBe("bootstrap");
    expect(pair.featureAmount).toBe("1");
    expect(pair.featureAsset).toBe(native);
    expect(pair.sponsorshipAmount).toBe("150");
    expect(pair.requiredNativeOutputs).toBe("151");
    expect(pair.sponsorshipAsset).toBe(native);
    expect(pair.featureSender).toBe(owner);
    expect(pair.featureScriptRoot).toBe(NoteScript.p2id().root().toHex());
    expect(pair.featureStorage).toHaveLength(2);
    expect(pair.featureNoteId).toBe(pair.sponsorshipFeatureNoteId);
    expect(pair.targetAttachmentPresent).toBe(false);
    expect(pair.submitted).toBe(false);
    expect(pair.walletInvoked).toBe(false);
    expect(pair.walletEnvelope).toEqual({ type: "custom", sender: owner, recipient: pair.targetVaultId });
    expect(pair.requestBytesBase64.length).toBeGreaterThan(0);
    expect(pair.selfDeploymentRequestBytesBase64).toBeTruthy();
  });

  it("serializes a valid self-deployment request with the bootstrap input notes", () => {
    const pair = constructBootstrapRequest("0x6f93db51c660bbd129a718f903bfea", owner, native);
    const bytes = Uint8Array.from(atob(pair.selfDeploymentRequestBytesBase64!), (char) => char.charCodeAt(0));
    const deploymentRequest = TransactionRequest.deserialize(bytes);
    const normalizedBytes = Uint8Array.from(deploymentRequest.serialize());
    const normalizedRequest = TransactionRequest.deserialize(normalizedBytes);
    const stableBytes = Uint8Array.from(normalizedRequest.serialize());
    const serializationEvidence = summarizeRequestSerialization(bytes, normalizedBytes, stableBytes);
    const script = NoteScript.feeSponsorship();
    const scriptBytes = Uint8Array.from(script.serialize());
    const parsedScript = NoteScript.deserialize(scriptBytes);
    const parsedScriptBytes = Uint8Array.from(parsedScript.serialize());
    expect(summarizeRequestSerialization(scriptBytes, parsedScriptBytes, parsedScriptBytes).firstDifferenceOffset).toBeNull();
    parsedScript.free();
    script.free();
    const p2id = NoteScript.p2id();
    const p2idRoot = p2id.root();
    expect(deploymentRequest).toBeTruthy();
    expect(pair.featureScriptRoot).toBe(p2idRoot.toHex());
    expect(pair.featureNoteId).toBe(pair.sponsorshipFeatureNoteId);
    expect(pair.selfDeploymentRequestBytesBase64).not.toBe(pair.requestBytesBase64);
    expect(serializationEvidence.originalByteLength).toBe(serializationEvidence.roundTripByteLength);
    expect(serializationEvidence.firstDifferenceOffset).toBe(435);
    expect(serializationEvidence.originalWindowHex.startsWith("ff 00 00 00 00 00 00 00 ")).toBe(true);
    expect(serializationEvidence.originalWindowHex.split(" ").length).toBeLessThanOrEqual(17);
    expect(serializationEvidence.originalIsSuffixOfRoundTrip).toBe(false);
    expect(serializationEvidence.roundTripIsSuffixOfOriginal).toBe(false);
    expect(serializationEvidence.lastDifferenceOffset).toBeGreaterThan(serializationEvidence.firstDifferenceOffset!);
    expect(serializationEvidence.commonSuffixByteCount).toBeGreaterThan(0);
    p2idRoot.free();
    p2id.free();
    normalizedRequest.free();
    deploymentRequest.free();
  });

  it("confirms expected NTX scripts are not exposed by the installed Web SDK request builder", () => {
    const builder = new TransactionRequestBuilder();
    try {
      expect((builder as unknown as { expectedNtxScripts?: unknown }).expectedNtxScripts).toBeUndefined();
    } finally { builder.free(); }
  });

  it("constructs setup P2ID-root cleanup note with canonical config storage and target", () => {
    const p2idRoot = NoteScript.p2id().root();
    const pair = constructBootstrapCleanupRequest(owner, "0x6f93db51c660bbd129a718f903bfea", p2idRoot.toHex(), native);
    expect(pair.kind).toBe("config-cleanup");
    expect(pair.featureScriptRoot).toBe(NoteScript.networkAccountConfig().root().toHex());
    expect(pair.featureStorage).toEqual([...p2idRoot.toFelts().map((felt) => felt.asInt().toString()), "1"]);
    expect(pair.sponsorshipAmount).toBe("120");
    expect(pair.requiredNativeOutputs).toBe("120");
    expect(pair.featureNoteId).toBe(pair.sponsorshipFeatureNoteId);
    expect(pair.targetAttachmentPresent).toBe(true);
    expect(pair.submitted).toBe(false);
    expect(pair.walletEnvelope.type).toBe("custom");
    p2idRoot.free();
  });

  it("constructs activation through the existing production feature-note builder", async () => {
    await mockArtifacts();
    const activationScript = await loadFeatureScript("activation");
    const pair = await constructActivationRequest(owner, "0x6f93db51c660bbd129a718f903bfea", inherited, native);
    expect(pair.kind).toBe("activation");
    expect(pair.featureSender).toBe(owner);
    expect(pair.featureScriptRoot).toBe(activationScript.root().toHex());
    expect(pair.sponsorshipAmount).toBe("120");
    expect(pair.featureNoteId).toBe(pair.sponsorshipFeatureNoteId);
    expect(pair.targetAttachmentPresent).toBe(true);
    expect(pair.submitted).toBe(false);
    expect(pair.walletInvoked).toBe(false);
  });

  it("does not introduce a second activation note implementation", async () => {
    await mockArtifacts();
    const featurePair = await buildFeaturePair({ kind: "activation", sender: owner, vault: "0x6f93db51c660bbd129a718f903bfea", inheritedFaucet: inherited, nativeFaucet: native, sponsorshipAmount: 120n });
    const dryRun = await constructActivationRequest(owner, "0x6f93db51c660bbd129a718f903bfea", inherited, native);
    expect(dryRun.featureScriptRoot).toBe(featurePair.info.featureRoot);
    expect(dryRun.networkTarget).toBe("NetworkAccountTarget(vault, Always)");
  });
});

import {
  AccountId,
  Felt,
  FeltArray,
  FungibleAsset,
  NetworkAccountTarget,
  Note,
  NoteAssets,
  NoteExecutionHint,
  NoteMetadata,
  NoteArray,
  NoteAndArgs,
  NoteAndArgsArray,
  NoteRecipient,
  NoteScript,
  NoteStorage,
  NoteTag,
  NoteType,
  TransactionRequestBuilder,
  Word,
} from "@miden-sdk/miden-sdk";
import type { Transaction } from "@miden-sdk/miden-wallet-adapter";
import { buildFeaturePair } from "../heirbeat/feature-notes";
import { normalizeAccountId } from "../domain/lifecycle";
import { makeWalletTransactionRequest } from "./wallet-request";
import { releaseSdkValue } from "./sdk-lifetime";

const TEST_OWNER = "0x528f6ca64fdf62410c36b5e00c4521";
const DEFAULT_VAULT_CONFIG = {
  beneficiary: "0x4181277bcf64381105ee61baadb5bc",
  inheritedFaucet: "0x4020542183b9643120d0192be38793",
  nativeFaucet: "0x18101fa522c174b165efd4f70a0385",
};

export interface DryRunNotePairSummary {
  kind: "bootstrap" | "config-cleanup" | "activation";
  targetVaultId: string;
  featureNoteId: string;
  sponsorshipNoteId: string;
  featureScriptRoot: string;
  sponsorshipScriptRoot: string;
  featureSender: string;
  featureType: "public";
  featureStorage: string[];
  sponsorshipFeatureNoteId: string;
  targetAttachmentPresent: boolean;
  sponsorshipAmount: string;
  requiredNativeOutputs: string;
  sponsorshipAsset: string;
  featureAsset?: string;
  featureAmount?: string;
  networkTarget: "NetworkAccountTarget(vault, Always)" | "P2ID target account";
  requestBytesBase64: string;
  selfDeploymentRequestBytesBase64?: string;
  walletEnvelope: { type: "custom"; sender: string; recipient: string };
  submitted: false;
  walletInvoked: false;
};

function asHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function wordFelts(root: Word): Felt[] {
  return root.toFelts();
}

function expectedNoteRoot(script: NoteScript): string {
  const root = script.root();
  try { return root.toHex().toLowerCase(); }
  finally { releaseSdkValue(root, "caller-owned"); releaseSdkValue(script, "caller-owned"); }
}

function noteRoot(note: Note): string {
  const script = note.script();
  const root = script.root();
  try { return root.toHex().toLowerCase(); }
  finally { releaseSdkValue(root, "caller-owned"); releaseSdkValue(script, "caller-owned"); }
}

function sponsorNote(sender: AccountId, target: AccountId, featureId: string, faucet: AccountId, amount: bigint): Note {
  const featureIdWord = Word.fromHex(featureId);
  const storage = new NoteStorage(new FeltArray([
    ...wordFelts(featureIdWord), sender.suffix(), sender.prefix(), new Felt(0n),
  ]));
  const recipient = NoteRecipient.fromScript(NoteScript.feeSponsorship(), storage);
  return new Note(
    new NoteAssets([new FungibleAsset(faucet, amount)]),
    new NoteMetadata(sender, NoteType.Public, NoteTag.withAccountTarget(target)),
    recipient,
  );
}

function requestSummary(kind: DryRunNotePairSummary["kind"], sender: AccountId, target: AccountId, feature: Note, sponsor: Note, networkTarget: DryRunNotePairSummary["networkTarget"], featureAsset?: string, featureAmount?: string): DryRunNotePairSummary {
  const featureStorage = feature.recipient().storage().items();
  const sponsorStorage = sponsor.recipient().storage().items();
  const featureStorageValues = featureStorage.map((felt) => felt.asInt().toString());
  const featureNoteIdWord = Word.newFromFelts(sponsorStorage.slice(0, 4));
  const sponsorshipFeatureNoteId = featureNoteIdWord.toHex();
  const attachments = feature.attachments();
  const targetAttachmentPresent = attachments.some((attachment) => {
    try {
      const targetAttachment = NetworkAccountTarget.fromAttachment(attachment);
      try { return targetAttachment.targetId().toString() === target.toString(); }
      finally { releaseSdkValue(targetAttachment, "caller-owned"); }
    } catch { return false; }
  });
  const metadata = feature.metadata();
  const featureSender = metadata.sender().toString();
  const noteType = metadata.noteType();
  const featureScript = feature.script();
  const featureScriptRoot = featureScript.root();
  const featureScriptRootHex = featureScriptRoot.toHex();
  const sponsorshipScript = sponsor.script();
  const sponsorshipScriptRoot = sponsorshipScript.root();
  const sponsorshipScriptRootHex = sponsorshipScriptRoot.toHex();
  const featureNoteId = feature.id().toString();
  const sponsorshipNoteId = sponsor.id().toString();
  const featureAssets = feature.assets().fungibleAssets();
  const sponsorshipAssets = sponsor.assets().fungibleAssets();
  const sponsorshipAmount = sponsorshipAssets[0].amount().toString();
  const sponsorshipAsset = sponsorshipAssets[0].faucetId().toString();
  // SDK 0.16.3 returns borrowed Felt wrappers from NoteStorage.items(); do not free them.
  releaseSdkValue(featureNoteIdWord, "caller-owned");
  attachments.forEach((attachment) => releaseSdkValue(attachment, "caller-owned"));
  releaseSdkValue(metadata, "caller-owned");
  releaseSdkValue(featureScriptRoot, "caller-owned");
  releaseSdkValue(featureScript, "caller-owned");
  releaseSdkValue(sponsorshipScriptRoot, "caller-owned");
  releaseSdkValue(sponsorshipScript, "caller-owned");
  featureAssets.forEach((asset) => releaseSdkValue(asset, "caller-owned"));
  sponsorshipAssets.forEach((asset) => releaseSdkValue(asset, "caller-owned"));
  if (noteType !== NoteType.Public) throw new Error("Feature note must be public.");
  if (sponsorshipFeatureNoteId !== featureNoteId) throw new Error("Sponsorship note does not reference the feature note ID.");
  const selfDeploymentInputs = kind === "bootstrap"
    ? new NoteAndArgsArray([
        new NoteAndArgs(Note.deserialize(feature.serialize())),
        new NoteAndArgs(Note.deserialize(sponsor.serialize())),
      ])
    : undefined;
  const outputs = new NoteArray([feature, sponsor]);
  const builder = new TransactionRequestBuilder().withOwnOutputNotes(outputs);
  const request = builder.build();
  try {
    const bytes = request.serialize();
    let selfDeploymentRequestBytesBase64: string | undefined;
    if (selfDeploymentInputs) {
      const deploymentBuilder = new TransactionRequestBuilder().withInputNotes(selfDeploymentInputs);
      const deploymentRequest = deploymentBuilder.build();
      selfDeploymentRequestBytesBase64 = encodeBase64(deploymentRequest.serialize());
      releaseSdkValue(deploymentRequest, "caller-owned");
    }
    const walletRequest = makeWalletTransactionRequest(sender.toString(), target.toString(), request);
    if (walletRequest.type !== "custom") throw new Error("Wallet adapter did not create a custom transaction envelope.");
    const payload = walletRequest.payload as { address: string; recipientAddress: string; transactionRequest: string };
    if (payload.address !== sender.toString() || payload.recipientAddress !== target.toString()) {
      throw new Error("Wallet custom transaction envelope has unexpected sender or recipient.");
    }
    if (payload.transactionRequest !== encodeBase64(bytes)) throw new Error("Wallet custom transaction did not preserve the serialized request bytes.");
    return {
      kind,
      targetVaultId: target.toString(),
      featureNoteId,
      sponsorshipNoteId,
      featureScriptRoot: featureScriptRootHex,
      sponsorshipScriptRoot: sponsorshipScriptRootHex,
      featureSender,
      featureType: "public",
      featureStorage: featureStorageValues,
      sponsorshipFeatureNoteId,
      targetAttachmentPresent,
      sponsorshipAmount,
      requiredNativeOutputs: (BigInt(sponsorshipAmount) + BigInt(featureAmount ?? "0")).toString(),
      sponsorshipAsset,
      ...(featureAsset ? { featureAsset } : {}),
      ...(featureAmount ? { featureAmount } : {}),
      networkTarget,
      requestBytesBase64: encodeBase64(bytes),
      ...(selfDeploymentRequestBytesBase64 ? { selfDeploymentRequestBytesBase64 } : {}),
      walletEnvelope: { type: "custom", sender: payload.address, recipient: payload.recipientAddress },
      submitted: false,
      walletInvoked: false,
    };
  } finally {
    releaseSdkValue(request, "caller-owned");
    // withOwnOutputNotes transfers the NoteArray and its note wrappers into the request builder.
    releaseSdkValue(sender, "caller-owned");
    releaseSdkValue(target, "caller-owned");
  }
}

/** Constructs the CLI's one-native-unit bootstrap P2ID plus 150-unit sponsorship pair. */
export function constructBootstrapRequest(vaultHex: string, senderHex = TEST_OWNER, nativeFaucetHex = DEFAULT_VAULT_CONFIG.nativeFaucet): DryRunNotePairSummary {
  const sender = AccountId.fromHex(senderHex);
  const target = AccountId.fromHex(vaultHex);
  const faucet = AccountId.fromHex(nativeFaucetHex);
  const p2idStorage = new NoteStorage(new FeltArray([target.suffix(), target.prefix()]));
  const p2idRecipient = NoteRecipient.fromScript(NoteScript.p2id(), p2idStorage);
  const feature = new Note(
    new NoteAssets([new FungibleAsset(faucet, 1n)]),
    new NoteMetadata(sender, NoteType.Public, NoteTag.withAccountTarget(target)),
    p2idRecipient,
  );
  const sponsor = sponsorNote(sender, target, feature.id().toString(), faucet, 150n);
  return requestSummary("bootstrap", sender, target, feature, sponsor, "P2ID target account", faucet.toString(), "1");
}

export interface PreparedBootstrapFundingWalletRequest {
  /** Adapter envelope only; no WASM wrappers escape this builder. */
  walletRequest: Transaction;
  summary: DryRunNotePairSummary & { outputNoteCount: 2 };
}

/** Builds only the owner wallet's two bootstrap outputs; it never builds or executes the vault deployment request. */
export function prepareBootstrapFundingWalletRequest(args: {
  vaultHex: string;
  senderAccountIdHex: string;
  senderWalletAddress: string;
  nativeFaucetHex?: string;
}): PreparedBootstrapFundingWalletRequest {
  const sender = AccountId.fromHex(args.senderAccountIdHex);
  if (normalizeAccountId(args.senderWalletAddress) !== sender.toString().toLowerCase()) {
    releaseSdkValue(sender, "caller-owned");
    throw new Error("Connected wallet address does not match the bootstrap note sender.");
  }
  const target = AccountId.fromHex(args.vaultHex);
  const faucet = AccountId.fromHex(args.nativeFaucetHex ?? DEFAULT_VAULT_CONFIG.nativeFaucet);
  let feature: Note | undefined;
  let sponsor: Note | undefined;
  let request: ReturnType<TransactionRequestBuilder["build"]> | undefined;
  try {
    const p2idStorage = new NoteStorage(new FeltArray([target.suffix(), target.prefix()]));
    feature = new Note(
      new NoteAssets([new FungibleAsset(faucet, 1n)]),
      new NoteMetadata(sender, NoteType.Public, NoteTag.withAccountTarget(target)),
      NoteRecipient.fromScript(NoteScript.p2id(), p2idStorage),
    );
    const featureIdObject = feature.id();
    let featureNoteId: string;
    try { featureNoteId = featureIdObject.toString().toLowerCase(); }
    finally { releaseSdkValue(featureIdObject, "caller-owned"); }
    sponsor = sponsorNote(sender, target, featureNoteId, faucet, 150n);
    const sponsorshipIdObject = sponsor.id();
    let sponsorshipNoteId: string;
    try { sponsorshipNoteId = sponsorshipIdObject.toString().toLowerCase(); }
    finally { releaseSdkValue(sponsorshipIdObject, "caller-owned"); }

    const featureRoot = expectedNoteRoot(NoteScript.p2id());
    const sponsorshipRoot = expectedNoteRoot(NoteScript.feeSponsorship());
    const roots = [noteRoot(feature), noteRoot(sponsor)];
    if (JSON.stringify([...roots].sort()) !== JSON.stringify([featureRoot, sponsorshipRoot].sort())) {
      throw new Error("Bootstrap funding request contains an unexpected note script.");
    }

    request = new TransactionRequestBuilder()
      .withOwnOutputNotes(new NoteArray([feature, sponsor]))
      .build();
    const ownOutputs = request.expectedOutputOwnNotes();
    let outputIds: string[];
    try { outputIds = ownOutputs.map((note) => {
      const id = note.id();
      try { return id.toString().toLowerCase(); }
      finally { releaseSdkValue(id, "caller-owned"); }
    }); }
    finally { ownOutputs.forEach((note) => releaseSdkValue(note, "caller-owned")); }
    if (JSON.stringify(outputIds) !== JSON.stringify([featureNoteId, sponsorshipNoteId])) {
      throw new Error("Bootstrap funding request must contain exactly the P2ID and its paired sponsorship output.");
    }

    const walletRequest = makeWalletTransactionRequest(args.senderWalletAddress, target.toString(), request);
    const payload = walletRequest.payload as { address?: string; recipientAddress?: string; transactionRequest?: string };
    if (walletRequest.type !== "custom" || payload.address !== args.senderWalletAddress || payload.recipientAddress !== target.toString()) {
      throw new Error("Bootstrap funding wallet envelope has an unexpected sender or target.");
    }
    if (payload.transactionRequest !== encodeBase64(Uint8Array.from(request.serialize()))) {
      throw new Error("Bootstrap funding wallet envelope did not preserve the two-output transaction request.");
    }
    const summary: PreparedBootstrapFundingWalletRequest["summary"] = {
      kind: "bootstrap",
      targetVaultId: target.toString().toLowerCase(),
      featureNoteId,
      sponsorshipNoteId,
      featureScriptRoot: featureRoot,
      sponsorshipScriptRoot: sponsorshipRoot,
      featureSender: sender.toString().toLowerCase(),
      featureType: "public",
      featureStorage: [target.suffix().asInt().toString(), target.prefix().asInt().toString()],
      sponsorshipFeatureNoteId: featureNoteId,
      targetAttachmentPresent: false,
      sponsorshipAmount: "150",
      requiredNativeOutputs: "151",
      sponsorshipAsset: faucet.toString().toLowerCase(),
      featureAsset: faucet.toString().toLowerCase(),
      featureAmount: "1",
      networkTarget: "P2ID target account",
      requestBytesBase64: encodeBase64(Uint8Array.from(request.serialize())),
      walletEnvelope: { type: "custom", sender: payload.address, recipient: payload.recipientAddress },
      submitted: false,
      walletInvoked: false,
      outputNoteCount: 2,
    };
    return { walletRequest, summary };
  } finally {
    releaseSdkValue(request, "caller-owned");
    // withOwnOutputNotes transfers the note wrappers into the request builder.
    releaseSdkValue(sender, "caller-owned");
    releaseSdkValue(target, "caller-owned");
    releaseSdkValue(faucet, "caller-owned");
  }
}

/** Constructs the CLI's setup-only removal of the temporary P2ID note root. */
export function constructBootstrapCleanupRequest(senderHex: string, vaultHex: string, p2idRootHex: string, nativeFaucetHex = DEFAULT_VAULT_CONFIG.nativeFaucet): DryRunNotePairSummary {
  const sender = AccountId.fromHex(senderHex);
  const target = AccountId.fromHex(vaultHex);
  const nativeFaucet = AccountId.fromHex(nativeFaucetHex);
  const root = Word.fromHex(p2idRootHex);
  const storage = new NoteStorage(new FeltArray([...root.toFelts(), new Felt(1n)]));
  const recipient = NoteRecipient.fromScript(NoteScript.networkAccountConfig(), storage);
  const feature = Note.withAttachments(
    new NoteAssets(),
    new NoteMetadata(sender, NoteType.Public, NoteTag.withAccountTarget(target)),
    recipient,
    [new NetworkAccountTarget(target, NoteExecutionHint.always()).toAttachment()],
  );
  const sponsor = sponsorNote(sender, target, feature.id().toString(), nativeFaucet, 120n);
  releaseSdkValue(root, "caller-owned");
  return requestSummary("config-cleanup", sender, target, feature, sponsor, "NetworkAccountTarget(vault, Always)");
}

/** Constructs the exact activation note and paired sponsorship request used by the CLI. */
export async function constructActivationRequest(senderHex: string, vaultHex: string, inheritedFaucetHex: string, nativeFaucetHex = DEFAULT_VAULT_CONFIG.nativeFaucet): Promise<DryRunNotePairSummary> {
  const pair = await buildFeaturePair({
    kind: "activation", sender: senderHex, vault: vaultHex,
    inheritedFaucet: inheritedFaucetHex, nativeFaucet: nativeFaucetHex,
    sponsorshipAmount: 120n,
  });
  return requestSummary(
    "activation",
    AccountId.fromHex(senderHex),
    AccountId.fromHex(vaultHex),
    pair.feature,
    pair.sponsorship,
    "NetworkAccountTarget(vault, Always)",
  );
}

export function componentArtifactChecksums(): Readonly<Record<string, string>> {
  // Filled from the exact miden-standards 0.16.1 .masp artifacts generated by its build script.
  return Object.freeze({
    ownable2step: "ada1851aa114f4bd9c965aaaa413bbb8c7e79f14f0a6ddb32baaec2a93183590",
    ownerControlledAuthority: "c3cadac8eefc5289872e3340daeaf12d7d2aa9040bec66911492ab82ce863755",
    schemaCommitment: "83f41c4edd2eea338265af59fecb0228ca1d6eba5f98f82e2428d4c26b53cba1",
  });
}

export function bytesToHex(bytes: Uint8Array): string { return asHex(bytes); }

import {
  AccountId,
  Felt,
  FeltArray,
  FungibleAsset,
  NetworkAccountTarget,
  Note,
  NoteArray,
  NoteAssets,
  NoteExecutionHint,
  NoteMetadata,
  NoteRecipient,
  NoteScript,
  NoteStorage,
  NoteTag,
  NoteType,
  Package,
  TransactionRequest,
  TransactionRequestBuilder,
  Word,
} from "@miden-sdk/miden-sdk";

export type FeatureKind = "heartbeat" | "deposit" | "claim" | "activation";

const ARTIFACT_PATHS: Record<FeatureKind, string> = {
  heartbeat: "/contracts/check-in-note.masp",
  deposit: "/contracts/deposit-note.masp",
  claim: "/contracts/claim-note.masp",
  activation: "/contracts/activate-vault-note.masp",
};

export async function loadFeatureScript(kind: FeatureKind): Promise<NoteScript> {
  const response = await fetch(ARTIFACT_PATHS[kind]);
  if (!response.ok) throw new Error(`Cannot load ${kind} package artifact (${response.status}). Build the contract packages first.`);
  const pkg = Package.deserialize(new Uint8Array(await response.arrayBuffer()));
  return NoteScript.fromPackage(pkg);
}

export interface BuiltFeaturePair {
  feature: Note;
  sponsorship: Note;
  request: TransactionRequest;
  info: {
    featureId: string;
    featureRoot: string;
    targetId: string;
    executionHint: "always";
    sponsorshipId: string;
    sponsorshipFeatureId: string;
    sponsorshipAsset: string;
    sponsorshipAmount: bigint;
    depositAsset?: string;
    depositAmount?: bigint;
  };
}

function noteFromScript(sender: AccountId, target: AccountId, script: NoteScript, storageItems: Felt[], assets: FungibleAsset[] = []): Note {
  const targetAttachment = new NetworkAccountTarget(target, NoteExecutionHint.always()).toAttachment();
  const metadata = new NoteMetadata(sender, NoteType.Public, NoteTag.withAccountTarget(target));
  const recipient = NoteRecipient.fromScript(script, new NoteStorage(new FeltArray(storageItems)));
  const note = Note.withAttachments(new NoteAssets(assets), metadata, recipient, [targetAttachment]);
  if (!note.isNetworkNote()) throw new Error("Constructed Heirbeat note is not recognized as a network note.");
  const decoded = NetworkAccountTarget.fromAttachment(note.attachments()[0]);
  if (decoded.targetId().toString() !== target.toString() || !decoded.executionHint().canBeConsumed(0)) {
    throw new Error("NetworkAccountTarget did not round-trip to the intended vault with Always semantics.");
  }
  return note;
}

function feeSponsorship(sender: AccountId, target: AccountId, feature: Note, feeFaucet: AccountId, amount: bigint): Note {
  if (amount <= 0n) throw new Error("Sponsorship amount must be positive.");
  // Stable miden-standards 0.16.1 FeeSponsorshipNoteStorage is exactly:
  // feature_note_id word (4 felts), reclaimer suffix, reclaimer prefix, reclaim height (0 = disabled).
  const featureIdWord = Word.fromHex(feature.id().toString());
  const storage = new NoteStorage(new FeltArray([
    ...featureIdWord.toFelts(),
    sender.suffix(),
    sender.prefix(),
    new Felt(0n),
  ]));
  const recipient = NoteRecipient.fromScript(NoteScript.feeSponsorship(), storage);
  return new Note(
    new NoteAssets([new FungibleAsset(feeFaucet, amount)]),
    new NoteMetadata(sender, NoteType.Public, NoteTag.withAccountTarget(target)),
    recipient,
  );
}

export async function buildFeaturePair(args: {
  kind: FeatureKind;
  sender: string;
  vault: string;
  inheritedFaucet: string;
  nativeFaucet: string;
  sponsorshipAmount: bigint;
  depositAmount?: bigint;
}): Promise<BuiltFeaturePair> {
  const sender = AccountId.fromHex(args.sender);
  const target = AccountId.fromHex(args.vault);
  const inheritedFaucet = AccountId.fromHex(args.inheritedFaucet);
  const nativeFaucet = AccountId.fromHex(args.nativeFaucet);
  const script = await loadFeatureScript(args.kind);
  const storageItems = args.kind === "deposit"
    ? [target.suffix(), target.prefix()]
    : [];
  const depositAssets = args.kind === "deposit"
    ? [new FungibleAsset(inheritedFaucet, args.depositAmount ?? 0n)]
    : [];
  if (args.kind === "deposit" && (!args.depositAmount || args.depositAmount <= 0n)) {
    throw new Error("Deposit amount must be greater than zero.");
  }
  const feature = noteFromScript(sender, target, script, storageItems, depositAssets);
  const sponsorship = feeSponsorship(sender, target, feature, nativeFaucet, args.sponsorshipAmount);
  const featureId = feature.id().toString();
  const storedId = Word.fromHex(featureId).toFelts();
  const actualStorage = sponsorship.recipient().storage().items();
  if (actualStorage.length !== 7 || actualStorage.slice(0, 4).some((felt, i) => felt.asInt() !== storedId[i].asInt())) {
    throw new Error("FeeSponsorshipNote feature_note_id storage does not match the feature note.");
  }
  if (sponsorship.assets().fungibleAssets().length !== 1 || sponsorship.assets().fungibleAssets()[0].faucetId().toString() !== nativeFaucet.toString()) {
    throw new Error("FeeSponsorshipNote must contain exactly the configured native fee asset.");
  }

  const outputNotes = new NoteArray();
  outputNotes.push(feature);
  outputNotes.push(sponsorship);
  const request = new TransactionRequestBuilder().withOwnOutputNotes(outputNotes).build();
  return {
    feature,
    sponsorship,
    request,
    info: {
      featureId,
      featureRoot: script.root().toHex(),
      targetId: target.toString(),
      executionHint: "always",
      sponsorshipId: sponsorship.id().toString(),
      sponsorshipFeatureId: featureId,
      sponsorshipAsset: nativeFaucet.toString(),
      sponsorshipAmount: args.sponsorshipAmount,
      ...(args.kind === "deposit" ? { depositAsset: inheritedFaucet.toString(), depositAmount: args.depositAmount } : {}),
    },
  };
}

import { AccountId, Note, NoteScript, NoteType } from "@miden-sdk/miden-sdk";
import { ConsumeTransaction } from "@miden-sdk/miden-wallet-adapter";

export interface ValidatedPayout {
  noteId: string;
  beneficiary: string;
  faucet: string;
  amount: bigint;
}

/** Validates a standard public P2ID output before asking the wallet to consume it. */
export function validateP2idPayout(
  note: Note,
  expectedBeneficiary: string,
  expectedFaucet: string,
  expectedAmount?: bigint,
): ValidatedPayout {
  if (note.metadata().noteType() !== NoteType.Public) throw new Error("Payout note must be public.");
  if (note.recipient().script().root().toHex() !== NoteScript.p2id().root().toHex()) {
    throw new Error("Payout note does not use the canonical P2ID script.");
  }
  const storage = note.recipient().storage().items();
  if (storage.length !== 2) throw new Error("P2ID payout storage has an unexpected layout.");
  const beneficiary = AccountId.fromPrefixSuffix(storage[1], storage[0]).toString();
  if (beneficiary.toLowerCase() !== AccountId.fromHex(expectedBeneficiary).toString().toLowerCase()) {
    throw new Error("P2ID payout recipient does not match the configured beneficiary.");
  }
  const assets = note.assets().fungibleAssets();
  if (assets.length !== 1 || assets[0].faucetId().toString().toLowerCase() !== AccountId.fromHex(expectedFaucet).toString().toLowerCase()) {
    throw new Error("P2ID payout must contain exactly the configured inherited asset.");
  }
  const amount = assets[0].amount();
  if (expectedAmount !== undefined && amount !== expectedAmount) {
    throw new Error(`P2ID payout amount mismatch: expected ${expectedAmount}, received ${amount}.`);
  }
  return { noteId: note.id().toString(), beneficiary, faucet: assets[0].faucetId().toString(), amount };
}

/** Creates the official wallet-adapter consume request after payout validation. */
export function makeP2idConsumeRequest(payout: ValidatedPayout): ConsumeTransaction {
  if (payout.amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Wallet adapter v0.16 represents consume amounts as JavaScript numbers; this amount exceeds the safe integer range.");
  }
  return new ConsumeTransaction(payout.faucet, payout.noteId, "public", Number(payout.amount));
}

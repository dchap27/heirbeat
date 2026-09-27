import { describe, expect, it } from "vitest";
import {
  AccountId,
  FeltArray,
  FungibleAsset,
  Note,
  NoteAssets,
  NoteMetadata,
  NoteRecipient,
  NoteScript,
  NoteStorage,
  NoteTag,
  NoteType,
} from "@miden-sdk/miden-sdk";
import { makeP2idConsumeRequest, validateP2idPayout } from "./payout";

const sender = AccountId.fromHex("0x39fcc854fe715ad1446afb9859df04");
const beneficiary = AccountId.fromHex("0x4181277bcf64381105ee61baadb5bc");
const inherited = AccountId.fromHex("0x4020542183b9643120d0192be38793");
const otherFaucet = AccountId.fromHex("0x18101fa522c174b165efd4f70a0385");

function payout(target = beneficiary, faucet = inherited, amount = 1n): Note {
  const storage = new NoteStorage(new FeltArray([target.suffix(), target.prefix()]));
  return new Note(
    new NoteAssets([new FungibleAsset(faucet, amount)]),
    new NoteMetadata(sender, NoteType.Public, NoteTag.withAccountTarget(target)),
    NoteRecipient.fromScript(NoteScript.p2id(), storage),
  );
}

describe("P2ID payout and wallet consume request", () => {
  it("uses the stable v0.16 P2ID script root pinned by the vault", () => {
    expect(Array.from(NoteScript.p2id().root().toU64s())).toEqual([
      3753793277686139666n,
      16926746659472928710n,
      1136859898937662014n,
      10130066283336208623n,
    ]);
  });

  it("validates recipient, canonical script, asset and amount before making wallet request", () => {
    const note = payout();
    const validated = validateP2idPayout(note, beneficiary.toString(), inherited.toString(), 1n);
    const request = makeP2idConsumeRequest(validated);
    expect(request.faucetId).toBe(inherited.toString());
    expect(request.noteId).toBe(note.id().toString());
    expect(request.noteType).toBe("public");
    expect(request.amount).toBe(1);
  });

  it("rejects a substituted beneficiary, faucet, or payout amount", () => {
    const note = payout();
    expect(() => validateP2idPayout(note, sender.toString(), inherited.toString())).toThrow(/recipient/);
    expect(() => validateP2idPayout(note, beneficiary.toString(), otherFaucet.toString())).toThrow(/configured inherited asset/);
    expect(() => validateP2idPayout(note, beneficiary.toString(), inherited.toString(), 2n)).toThrow(/amount mismatch/);
  });

  it("refuses consume amounts that the wallet adapter number field cannot represent exactly", () => {
    const huge = payout(beneficiary, inherited, BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    const validated = validateP2idPayout(huge, beneficiary.toString(), inherited.toString());
    expect(() => makeP2idConsumeRequest(validated)).toThrow(/safe integer range/);
  });
});

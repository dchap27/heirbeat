import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccountId,
  NetworkAccountTarget,
  NoteType,
  NoteTag,
  Word,
} from "@miden-sdk/miden-sdk";
import { buildFeaturePair, loadFeatureScript, type FeatureKind } from "./feature-notes";
import { makeWalletTransactionRequest } from "../miden/wallet-request";

const root = resolve(import.meta.dirname, "../../..");
const owner = "0xa61714a99ec7619109e397cbac32cd";
const beneficiary = "0x4181277bcf64381105ee61baadb5bc";
const vault = "0x39fcc854fe715ad1446afb9859df04";
const inherited = "0x4020542183b9643120d0192be38793";
const native = "0x18101fa522c174b165efd4f70a0385";
afterEach(() => vi.unstubAllGlobals());

async function mockArtifactFetch() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const name = new URL(String(input), "http://localhost").pathname.split("/").at(-1)?.replace(".masp", "") ?? "";
    const bytes = await readFile(resolve(root, `contracts/${name}/target/miden/release/${name}.masp`));
    return new Response(bytes, { status: 200 });
  });
}

describe("browser Heirbeat note construction", () => {
  it.each(["heartbeat", "deposit", "claim", "activation"] as FeatureKind[])("constructs exact %s note and matching sponsorship", async (kind) => {
    await mockArtifactFetch();
    const sender = kind === "claim" ? beneficiary : owner;
    const pair = await buildFeaturePair({
      kind, sender, vault, inheritedFaucet: inherited, nativeFaucet: native,
      sponsorshipAmount: 150n, ...(kind === "deposit" ? { depositAmount: 3n } : {}),
    });
    const target = AccountId.fromHex(vault);

    expect(pair.feature.metadata().noteType()).toBe(NoteType.Public);
    expect(pair.feature.metadata().sender().toString()).toBe(sender);
    expect(pair.feature.metadata().tag().asU32()).toBe(NoteTag.withAccountTarget(target).asU32());
    expect(pair.feature.isNetworkNote()).toBe(true);
    expect(pair.feature.script().root().toHex()).toBe(pair.info.featureRoot);
    const targetAttachment = NetworkAccountTarget.fromAttachment(pair.feature.attachments()[0]);
    expect(targetAttachment.targetId().toString()).toBe(vault);
    expect(targetAttachment.executionHint().canBeConsumed(0)).toBe(true);
    expect(pair.info.sponsorshipFeatureId).toBe(pair.info.featureId);
    expect(pair.sponsorship.script().root().toHex()).toBe((await import("@miden-sdk/miden-sdk")).NoteScript.feeSponsorship().root().toHex());
    expect(pair.sponsorship.metadata().noteType()).toBe(NoteType.Public);
    expect(pair.sponsorship.metadata().sender().toString()).toBe(sender);
    expect(pair.sponsorship.metadata().tag().asU32()).toBe(NoteTag.withAccountTarget(target).asU32());

    const featureId = Word.fromHex(pair.info.featureId).toFelts();
    const sponsorStorage = pair.sponsorship.recipient().storage().items();
    expect(sponsorStorage).toHaveLength(7);
    expect(sponsorStorage.slice(0, 4).map((felt) => felt.asInt())).toEqual(featureId.map((felt) => felt.asInt()));
    // FeeSponsorshipNote's canonical reclaimer defaults to sender; routing is
    // independently carried by the Network Account tag.
    const reclaimer = AccountId.fromHex(sender);
    expect(sponsorStorage[4].asInt()).toBe(reclaimer.suffix().asInt());
    expect(sponsorStorage[5].asInt()).toBe(reclaimer.prefix().asInt());
    expect(sponsorStorage[6].asInt()).toBe(0n);
    expect(pair.sponsorship.assets().fungibleAssets()).toHaveLength(1);
    expect(pair.sponsorship.assets().fungibleAssets()[0].faucetId().toString()).toBe(native);
    expect(pair.sponsorship.assets().fungibleAssets()[0].amount()).toBe(150n);
    expect(pair.request.serialize().length).toBeGreaterThan(0);
    expect(pair.request.expectedOutputOwnNotes().map((note) => note.id().toString())).toEqual([
      pair.info.featureId,
      pair.info.sponsorshipId,
    ]);
    const walletRequest = makeWalletTransactionRequest(sender, vault, pair.request);
    expect(walletRequest.type).toBe("custom");
    expect((walletRequest.payload as { address: string }).address).toBe(sender);
    expect((walletRequest.payload as { recipientAddress: string }).recipientAddress).toBe(vault);
    expect(Buffer.from((walletRequest.payload as { transactionRequest: string }).transactionRequest, "base64"))
      .toEqual(Buffer.from(pair.request.serialize()));

    if (kind === "deposit") {
      expect(pair.feature.assets().fungibleAssets()).toHaveLength(1);
      expect(pair.feature.assets().fungibleAssets()[0].faucetId().toString()).toBe(inherited);
      expect(pair.feature.assets().fungibleAssets()[0].amount()).toBe(3n);
      expect(pair.feature.recipient().storage().items().map((felt) => felt.asInt())).toEqual([
        target.suffix().asInt(), target.prefix().asInt(),
      ]);
    } else {
      expect(pair.feature.assets().fungibleAssets()).toHaveLength(0);
      expect(pair.feature.recipient().storage().items()).toHaveLength(0);
    }
  });

  it("rejects zero-amount deposits and zero sponsorship", async () => {
    await mockArtifactFetch();
    await expect(buildFeaturePair({ kind: "deposit", sender: owner, vault, inheritedFaucet: inherited, nativeFaucet: native, sponsorshipAmount: 150n, depositAmount: 0n })).rejects.toThrow(/greater than zero/);
    await expect(buildFeaturePair({ kind: "heartbeat", sender: owner, vault, inheritedFaucet: inherited, nativeFaucet: native, sponsorshipAmount: 0n })).rejects.toThrow(/positive/);
  });

  it("loads the checked-in contract package bytes as the note script", async () => {
    await mockArtifactFetch();
    const script = await loadFeatureScript("heartbeat");
    expect(script.root().toHex()).toBeTruthy();
  });
});

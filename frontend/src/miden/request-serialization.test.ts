import { describe, expect, it } from "vitest";
import {
  assertDeploymentRequestSemantics,
  summarizeRequestSerialization,
} from "./request-serialization";

describe("deployment request serialization diagnostics", () => {
  it("reports bounded lengths, first difference, windows, and normalization stability", () => {
    const original = Uint8Array.from([1, 2, 3, 4, 5]);
    const normalized = Uint8Array.from([1, 2, 9, 4, 5, 6]);
    const summary = summarizeRequestSerialization(original, normalized, normalized);

    expect(summary).toMatchObject({
      originalByteLength: 5,
      roundTripByteLength: 6,
      firstDifferenceOffset: 2,
      differingByteCount: 2,
      originalIsPrefixOfRoundTrip: false,
      roundTripIsPrefixOfOriginal: false,
      stableAfterSecondRoundTrip: true,
    });
    expect(summary.originalWindowHex).toBe("01 02 03 04 05");
    expect(summary.roundTripWindowHex).toBe("01 02 09 04 05 06");
    expect(summary.originalWindowHex.length).toBeLessThanOrEqual(8 * 3);
  });

  it("accepts only the expected vault, ordered bootstrap pair, and standard scripts", () => {
    const base = {
      actingVaultId: "0xvault",
      expectedVaultId: "0xvault",
      featureNoteId: "0xfeature",
      sponsorshipNoteId: "0xsponsor-note",
      sponsorshipFeatureNoteId: "0xfeature",
      featureScriptRoot: "0xp2id",
      sponsorshipScriptRoot: "0xsponsor",
      expectedFeatureScriptRoot: "0xp2id",
      expectedSponsorshipScriptRoot: "0xsponsor",
      inputNoteIds: ["0xfeature", "0xsponsor-note"],
    };
    expect(() => assertDeploymentRequestSemantics(base)).not.toThrow();
    expect(() => assertDeploymentRequestSemantics({ ...base, actingVaultId: "0xother" })).toThrow(/acting vault/);
    expect(() => assertDeploymentRequestSemantics({ ...base, inputNoteIds: ["0xsponsor-note", "0xfeature"] })).toThrow(/order/);
    expect(() => assertDeploymentRequestSemantics({ ...base, sponsorshipFeatureNoteId: "0xother" })).toThrow(/paired/);
    expect(() => assertDeploymentRequestSemantics({ ...base, sponsorshipScriptRoot: "0xcustom" })).toThrow(/unexpected/);
  });
});

/** Bounded, non-secret byte evidence for the local SDK request diagnostic. */
export interface RequestSerializationDiff {
  originalByteLength: number;
  roundTripByteLength: number;
  firstDifferenceOffset: number | null;
  lastDifferenceOffset: number | null;
  commonSuffixByteCount: number;
  differingByteCount: number;
  originalWindowHex: string;
  roundTripWindowHex: string;
  originalIsPrefixOfRoundTrip: boolean;
  roundTripIsPrefixOfOriginal: boolean;
  originalIsSuffixOfRoundTrip: boolean;
  roundTripIsSuffixOfOriginal: boolean;
  stableAfterSecondRoundTrip: boolean;
}

function hexWindow(bytes: Uint8Array, start: number, end: number): string {
  return Array.from(bytes.slice(start, end), (byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

function startsWith(left: Uint8Array, right: Uint8Array): boolean {
  return left.length <= right.length && left.every((byte, index) => byte === right[index]);
}

function endsWith(left: Uint8Array, right: Uint8Array): boolean {
  return left.length <= right.length && left.every((byte, index) => byte === right[right.length - left.length + index]);
}

export function summarizeRequestSerialization(
  original: Uint8Array,
  roundTrip: Uint8Array,
  secondRoundTrip: Uint8Array,
  windowRadius = 8,
): RequestSerializationDiff {
  let firstDifferenceOffset: number | null = null;
  let lastDifferenceOffset: number | null = null;
  let differingByteCount = Math.abs(original.length - roundTrip.length);
  const sharedLength = Math.min(original.length, roundTrip.length);
  for (let i = 0; i < sharedLength; i += 1) {
    if (original[i] !== roundTrip[i]) {
      firstDifferenceOffset ??= i;
      lastDifferenceOffset = i;
      differingByteCount += 1;
    }
  }
  const offset = firstDifferenceOffset ?? sharedLength;
  let commonSuffixByteCount = 0;
  while (commonSuffixByteCount < sharedLength &&
    original[original.length - 1 - commonSuffixByteCount] === roundTrip[roundTrip.length - 1 - commonSuffixByteCount]) {
    commonSuffixByteCount += 1;
  }
  const start = Math.max(0, offset - windowRadius);
  const end = Math.min(Math.max(original.length, roundTrip.length), offset + windowRadius + 1);
  return {
    originalByteLength: original.length,
    roundTripByteLength: roundTrip.length,
    firstDifferenceOffset,
    lastDifferenceOffset,
    commonSuffixByteCount,
    differingByteCount,
    originalWindowHex: hexWindow(original, start, Math.min(end, original.length)),
    roundTripWindowHex: hexWindow(roundTrip, start, Math.min(end, roundTrip.length)),
    originalIsPrefixOfRoundTrip: startsWith(original, roundTrip),
    roundTripIsPrefixOfOriginal: startsWith(roundTrip, original),
    originalIsSuffixOfRoundTrip: endsWith(original, roundTrip),
    roundTripIsSuffixOfOriginal: endsWith(roundTrip, original),
    stableAfterSecondRoundTrip: roundTrip.length === secondRoundTrip.length &&
      roundTrip.every((byte, index) => byte === secondRoundTrip[index]),
  };
}

/**
 * The Web SDK exposes only a subset of TransactionRequest's Rust accessors.
 * Keep this semantic guard tied to the exact inputs used to build the request;
 * subsequent local execution validates that reconstructed request against the
 * inserted account and those note scripts without any network submission.
 */
export function assertDeploymentRequestSemantics(input: {
  actingVaultId: string;
  expectedVaultId: string;
  featureNoteId: string;
  sponsorshipNoteId: string;
  sponsorshipFeatureNoteId: string;
  featureScriptRoot: string;
  sponsorshipScriptRoot: string;
  expectedFeatureScriptRoot: string;
  expectedSponsorshipScriptRoot: string;
  inputNoteIds: string[];
}): void {
  if (input.actingVaultId !== input.expectedVaultId) throw new Error("Deployment request acting vault changed during reconstruction.");
  if (input.inputNoteIds.length !== 2 || input.inputNoteIds[0] !== input.featureNoteId || input.inputNoteIds[1] !== input.sponsorshipNoteId) {
    throw new Error("Deployment request input-note order or sponsorship pairing is invalid.");
  }
  if (input.featureNoteId !== input.sponsorshipFeatureNoteId) throw new Error("Sponsorship note is not paired to the bootstrap feature note.");
  if (input.featureScriptRoot !== input.expectedFeatureScriptRoot || input.sponsorshipScriptRoot !== input.expectedSponsorshipScriptRoot) {
    throw new Error("Deployment request contains an unexpected bootstrap note script.");
  }
}

import { deriveDeadline, deriveRoleWithDiagnostic } from "./lifecycle";
import type { VaultSnapshot } from "./types";

export type CheckInOperationState =
  | "idle" | "preparing" | "wallet_review" | "wallet_rejected" | "wallet_accepted"
  | "feature_note_committed" | "ntx_pending" | "ntx_executing" | "executed" | "failed" | "unknown";

export interface CheckInRecord {
  vaultId: string;
  state: CheckInOperationState;
  featureNoteId?: string;
  sponsorshipNoteId?: string;
  walletTransactionId?: string;
  preLastCheckIn?: string;
  preDeadline?: string;
  postLastCheckIn?: string;
  postDeadline?: string;
  availableNative?: string;
  requiredNative?: string;
  featureNoteStatus?: string;
  sponsorshipNoteStatus?: string;
  ntxStatus?: string;
  message?: string;
  diagnostic?: { stage: string; errorName: string; errorMessage: string };
}

export const CHECK_IN_RECORD_STORAGE_KEY = "heirbeat.checkin-operations.v1";
const operationStates = new Set<CheckInOperationState>([
  "idle", "preparing", "wallet_review", "wallet_rejected", "wallet_accepted", "feature_note_committed",
  "ntx_pending", "ntx_executing", "executed", "failed", "unknown",
]);

/** Restores only validated plain public evidence; no SDK/WASM objects can be deserialized here. */
export function loadCheckInRecords(serialized: string | null): Record<string, CheckInRecord> {
  if (!serialized) return {};
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, CheckInRecord> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const candidate = value as Record<string, unknown>;
      if (typeof candidate.vaultId !== "string" || candidate.vaultId.toLowerCase() !== key.toLowerCase()) continue;
      if (typeof candidate.state !== "string" || !operationStates.has(candidate.state as CheckInOperationState)) continue;
      const record: CheckInRecord = { vaultId: candidate.vaultId, state: candidate.state as CheckInOperationState };
      for (const field of ["featureNoteId", "sponsorshipNoteId", "walletTransactionId", "preLastCheckIn", "preDeadline", "postLastCheckIn", "postDeadline", "availableNative", "requiredNative", "featureNoteStatus", "sponsorshipNoteStatus", "ntxStatus", "message"] as const) {
        if (typeof candidate[field] === "string") record[field] = candidate[field] as string;
      }
      if (candidate.diagnostic && typeof candidate.diagnostic === "object") {
        const diagnostic = candidate.diagnostic as Record<string, unknown>;
        if (typeof diagnostic.stage === "string" && typeof diagnostic.errorName === "string" && typeof diagnostic.errorMessage === "string") {
          record.diagnostic = { stage: diagnostic.stage, errorName: diagnostic.errorName, errorMessage: diagnostic.errorMessage };
        }
      }
      result[key.toLowerCase()] = record;
    }
    return result;
  } catch {
    return {};
  }
}

export interface CheckInEligibility {
  allowed: boolean;
  role: "owner" | "beneficiary" | "observer";
  reason?: string;
}

export const CHECK_IN_HELP_TEXT = "Renew this vault's inactivity timer and keep it protected from an inactivity claim. This check-in affects this vault only.";

const unresolved = new Set<CheckInOperationState>([
  "preparing", "wallet_review", "wallet_accepted", "feature_note_committed", "ntx_pending", "ntx_executing", "unknown",
]);

export function checkInIsUnresolved(state: CheckInOperationState): boolean {
  return unresolved.has(state);
}

export function checkInEligibility(snapshot: VaultSnapshot, connectedAddress: string | null, state: CheckInOperationState = "idle"): CheckInEligibility {
  if (snapshot.claimed) return { allowed: false, role: "observer", reason: "This vault has already been claimed." };
  if (!snapshot.activated) return { allowed: false, role: "observer", reason: "Finalize this vault before checking in." };
  if (!connectedAddress) return { allowed: false, role: "observer", reason: "Connect the vault owner's wallet to check in." };
  const roleResult = deriveRoleWithDiagnostic(connectedAddress, snapshot.owner, snapshot.beneficiary);
  if (roleResult.diagnostic) return { allowed: false, role: "observer", reason: "Unable to verify connected wallet identity." };
  if (roleResult.role !== "owner") return {
    allowed: false,
    role: roleResult.role,
    reason: roleResult.role === "beneficiary" ? "No owner actions are available for this wallet." : "Connect the vault owner's wallet to check in.",
  };
  if (state !== "idle" && checkInIsUnresolved(state)) return { allowed: false, role: "owner", reason: "A check-in for this vault is unresolved. Check its status before starting another." };
  return { allowed: true, role: "owner" };
}

export function requiredNativeForCheckIn(sponsorshipAmount: bigint, verificationBaseFee: bigint, otherNativeOutputs = 0n): bigint {
  if (sponsorshipAmount <= 0n || verificationBaseFee < 0n || otherNativeOutputs < 0n) throw new Error("Invalid native fee preflight inputs.");
  return sponsorshipAmount + 17n * verificationBaseFee + otherNativeOutputs;
}

export function availableNativeFromWalletAssets(assets: Array<{ faucetId: string; amount: string }>, nativeFaucet: string): bigint {
  const matching = assets.find((asset) => asset.faucetId.toLowerCase() === nativeFaucet.toLowerCase());
  if (!matching) return 0n;
  if (!/^\d+$/.test(matching.amount)) throw new Error("Wallet returned an invalid native asset balance.");
  return BigInt(matching.amount);
}

export function checkInExecutionResult(pre: VaultSnapshot, post: VaultSnapshot): { executed: boolean; deadline?: bigint; reason?: string } {
  if (post.accountId.toLowerCase() !== pre.accountId.toLowerCase()) return { executed: false, reason: "Fresh state belongs to a different vault." };
  if (post.claimed) return { executed: false, reason: "The vault became claimed; this is not a confirmed heartbeat." };
  if (!post.activated || post.owner.toLowerCase() !== pre.owner.toLowerCase() || post.beneficiary.toLowerCase() !== pre.beneficiary.toLowerCase() || post.faucet.toLowerCase() !== pre.faucet.toLowerCase() || post.timeoutBlocks !== pre.timeoutBlocks) {
    return { executed: false, reason: "Vault policy changed or is inconsistent; heartbeat was not confirmed." };
  }
  if (post.lastCheckIn <= pre.lastCheckIn) return { executed: false, reason: "The fresh vault state has not yet reflected the check-in." };
  return { executed: true, deadline: deriveDeadline(post.lastCheckIn, post.timeoutBlocks) };
}

export function userSafeCheckInError(stage: string): string {
  if (stage === "fee_preflight") return "The wallet does not have enough native fee balance for this check-in.";
  if (stage === "wallet_assets") return "Unable to read the wallet's native fee balance. Check wallet access and retry.";
  if (stage === "prepare_request") return "Unable to prepare the check-in request. Review advanced diagnostics before retrying.";
  if (stage === "wallet_request") return "The wallet request did not complete. Check its status before retrying.";
  if (stage === "status_refresh") return "Unable to confirm the check-in yet. Refresh status before retrying.";
  return "Check-in could not be completed. Review advanced diagnostics.";
}

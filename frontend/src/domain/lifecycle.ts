import type { DerivedVaultState, VaultLifecycleState, VaultRole, VaultSnapshot } from "./types";
import { AccountId } from "@miden-sdk/miden-sdk";

export function deriveDeadline(lastCheckIn: bigint, timeoutBlocks: bigint): bigint {
  return lastCheckIn + timeoutBlocks;
}

export function deriveRole(walletAccountId: string | null, owner: string, beneficiary: string): VaultRole {
  if (!walletAccountId) return "observer";
  const connectedId = normalizeAccountId(walletAccountId);
  if (connectedId === normalizeAccountId(owner)) return "owner";
  if (connectedId === normalizeAccountId(beneficiary)) return "beneficiary";
  return "observer";
}

/** Wallets may expose AccountId as Bech32 while chain snapshots use canonical hex. */
export function normalizeAccountId(value: string): string {
  try {
    return AccountId.fromHex(value).toString().toLowerCase();
  } catch {
    return AccountId.fromBech32(value).toString().toLowerCase();
  }
}

export function deriveLifecycle(snapshot: VaultSnapshot): DerivedVaultState {
  const deadline = deriveDeadline(snapshot.lastCheckIn, snapshot.timeoutBlocks);
  const remainingBlocks = deadline > BigInt(snapshot.currentReferenceBlock)
    ? deadline - BigInt(snapshot.currentReferenceBlock)
    : 0n;
  let lifecycle: VaultLifecycleState;
  if (snapshot.claimed) lifecycle = "claimed";
  else if (!snapshot.activated) lifecycle = "setup";
  else if (remainingBlocks === 0n) lifecycle = "claimable";
  else if (remainingBlocks <= snapshot.timeoutBlocks / 5n) lifecycle = "warning";
  else lifecycle = "active";
  return {
    deadline,
    remainingBlocks,
    eligible: snapshot.activated && !snapshot.claimed && remainingBlocks === 0n,
    lifecycle,
    role: "observer",
  };
}

import type { DerivedVaultState, VaultLifecycleState, VaultRole, VaultSnapshot } from "./types";
import { AccountId, Address } from "@miden-sdk/miden-sdk";

export function deriveDeadline(lastCheckIn: bigint, timeoutBlocks: bigint): bigint {
  return lastCheckIn + timeoutBlocks;
}

export function deriveRole(walletAccountId: string | null, owner: string, beneficiary: string): VaultRole {
  if (!walletAccountId) return "observer";
  try {
    const connectedId = normalizeAccountId(walletAccountId);
    if (connectedId === normalizeAccountId(owner)) return "owner";
    if (connectedId === normalizeAccountId(beneficiary)) return "beneficiary";
    return "observer";
  } catch {
    // A malformed wallet/provider value must never crash a read-only render or
    // accidentally grant a role.
    return "observer";
  }
}

/** Normalize hex AccountIds and Bech32 wallet addresses to canonical AccountId hex. */
export function normalizeAccountId(value: string): string {
  const accountId = /^0x/i.test(value)
    ? AccountId.fromHex(value)
    : Address.fromBech32(value).accountId();
  return accountId.toString().toLowerCase();
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

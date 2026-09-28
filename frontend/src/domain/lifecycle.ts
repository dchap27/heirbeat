import type { DerivedVaultState, VaultLifecycleState, VaultRole, VaultSnapshot } from "./types";
import { AccountId, Address } from "@miden-sdk/miden-sdk";

export function deriveDeadline(lastCheckIn: bigint, timeoutBlocks: bigint): bigint {
  return lastCheckIn + timeoutBlocks;
}

export function deriveRole(walletAccountId: string | null, owner: string, beneficiary: string): VaultRole {
  return deriveRoleWithDiagnostic(walletAccountId, owner, beneficiary).role;
}

export function deriveRoleWithDiagnostic(walletAccountId: string | null, owner: string, beneficiary: string): {
  role: VaultRole;
  diagnostic?: { stage: "derive_role"; errorName: string; errorMessage: string };
} {
  if (!walletAccountId) return { role: "observer" };
  try {
    const connectedId = normalizeAccountId(walletAccountId);
    if (connectedId === normalizeAccountId(owner)) return { role: "owner" };
    if (connectedId === normalizeAccountId(beneficiary)) return { role: "beneficiary" };
    return { role: "observer" };
  } catch (cause) {
    // A malformed wallet/provider value must never crash a read-only render or
    // accidentally grant a role.
    return {
      role: "observer",
      diagnostic: {
        stage: "derive_role",
        errorName: cause instanceof Error ? cause.name : typeof cause,
        errorMessage: cause instanceof Error ? cause.message : String(cause),
      },
    };
  }
}

/** Normalize hex AccountIds and Bech32 wallet addresses to canonical AccountId hex. */
export function normalizeAccountId(value: string): string {
  const isHex = /^0x/i.test(value);
  const address = isHex ? undefined : Address.fromBech32(value);
  const accountId = isHex ? AccountId.fromHex(value) : address!.accountId();
  try {
    return accountId.toString().toLowerCase();
  } finally {
    accountId.free();
    address?.free();
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
  else lifecycle = "active";
  return {
    deadline,
    remainingBlocks,
    eligible: snapshot.activated && !snapshot.claimed && remainingBlocks === 0n,
    lifecycle,
    role: "observer",
  };
}

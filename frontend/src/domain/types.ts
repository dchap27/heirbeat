export type VaultRole = "owner" | "beneficiary" | "observer";
export type VaultLifecycleState =
  | "setup"
  | "active"
  | "warning"
  | "claimable"
  | "claimPending"
  | "claimed"
  | "unknown";
export type OperationStatus =
  | "preparing"
  | "walletSubmitted"
  | "featureNoteCommitted"
  | "ntxPending"
  | "ntxExecuting"
  | "executed"
  | "failed"
  | "unknown";

export interface VaultSnapshot {
  accountId: string;
  owner: string;
  beneficiary: string;
  faucet: string;
  nativeFeeFaucet: string;
  timeoutBlocks: bigint;
  lastCheckIn: bigint;
  activated: boolean;
  claimed: boolean;
  inheritedBalance: bigint;
  nativeBalance: bigint;
  noteAllowlist: string[];
  transactionScriptAllowlist: string[];
  currentReferenceBlock: number;
  inheritedAssetSymbol?: string;
  inheritedAssetName?: string;
  inheritedAssetDecimals?: number;
}

export interface DerivedVaultState {
  deadline: bigint;
  remainingBlocks: bigint;
  eligible: boolean;
  lifecycle: VaultLifecycleState;
  role: VaultRole;
}

export interface OperationEvidence {
  featureNoteId?: string;
  sponsorshipNoteId?: string;
  fundingTransactionId?: string;
  networkTransactionId?: string;
  executionBlock?: number;
  payoutNoteId?: string;
  payoutTransactionId?: string;
  error?: string;
}

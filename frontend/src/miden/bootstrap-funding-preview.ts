import { AccountId, Endpoint, NoteScript, RpcClient } from "@miden-sdk/miden-sdk";
import { requiredNativeForCheckIn } from "../domain/check-in";
import { normalizeAccountId } from "../domain/lifecycle";
import { NATIVE_FEE_FAUCET_ID, TESTNET_ENDPOINTS } from "./endpoints";
import { inspectNoteIndependently, type NoteInspection } from "./preview-evidence";
import type { PreparedBootstrapFundingWalletRequest } from "./bootstrap-requests";
import { releaseSdkValue } from "./sdk-lifetime";

export const BOOTSTRAP_PREVIEW_OWNER_ID = "0x528f6ca64fdf62410c36b5e00c4521";
export const BOOTSTRAP_PREVIEW_VAULT_ID = "0x27c655040bca51d14069e50380bf6f";
export const BOOTSTRAP_PREVIEW_SPONSORSHIP = 150n;
export const BOOTSTRAP_PREVIEW_P2ID_AMOUNT = 1n;

export interface BootstrapNetworkPreflight {
  referenceBlock: number;
  verificationBaseFee: bigint;
  feeFaucetId: string;
  vaultExists: boolean;
}

export interface BootstrapFundingPreflight {
  ownerAccountId: string;
  vaultAccountId: string;
  referenceBlock: number;
  verificationBaseFee: string;
  nativeFeeFaucet: string;
  ownerNativeBalance: string;
  p2idAmount: string;
  sponsorshipAmount: string;
  feeReserve: string;
  requiredNativeBalance: string;
  featureNoteStatusBefore: NoteInspection["classification"];
  sponsorshipNoteStatusBefore: NoteInspection["classification"];
  vaultExists: false;
};

export interface BootstrapPublicPreflight {
  ownerAccountId: string;
  vaultAccountId: string;
  referenceBlock: number;
  verificationBaseFee: string;
  nativeFeeFaucet: string;
  p2idAmount: string;
  sponsorshipAmount: string;
  featureNoteStatusBefore: NoteInspection["classification"];
  sponsorshipNoteStatusBefore: NoteInspection["classification"];
  vaultExists: false;
}

export interface BootstrapPostCancelEvidence {
  classification: "CANCEL_PREVIEW_PROVEN_NO_CHAIN_MUTATION" | "CANCEL_PREVIEW_INCOMPLETE" | "UNEXPECTED_CHAIN_EVIDENCE";
  manualCancelConfirmed: boolean;
  transactionId: null;
  vaultExecutionInvoked: boolean;
  publicRpcMutationInvoked: boolean;
  vaultExists: boolean;
  featureNoteStatus: NoteInspection["classification"];
  sponsorshipNoteStatus: NoteInspection["classification"];
  ownerNativeBefore: string | null;
  ownerNativeAfter: string | null;
  ownerNativeBalanceUnchanged: boolean | null;
  safeCancelConfirmed: boolean;
  accountHistory: "not_available_from_public_rpc";
}

export class BootstrapPreviewBlockedError extends Error {
  constructor(readonly stage: string, message: string) {
    super(message);
    this.name = "BootstrapPreviewBlockedError";
  }
}

export type BootstrapWalletOutcome =
  | { kind: "transaction_id_returned"; transactionId: string }
  | { kind: "wallet_rejected_or_failed"; transactionId: null; errorName: string; errorMessage: string }
  | { kind: "resolved_without_id"; transactionId: null };

/** A rejection remains ambiguous until a human confirms Cancel and chain reads agree. */
export function mapBootstrapWalletOutcome(transactionId: string | null | undefined, error?: unknown): BootstrapWalletOutcome {
  if (transactionId) return { kind: "transaction_id_returned", transactionId };
  if (error !== undefined) {
    const candidate = error as { name?: string; message?: string };
    return {
      kind: "wallet_rejected_or_failed",
      transactionId: null,
      errorName: candidate?.name ?? "Error",
      errorMessage: candidate?.message ?? String(error),
    };
  }
  return { kind: "resolved_without_id", transactionId: null };
}

type PreviewRpc = {
  getBlockHeaderByNumber(blockNumber?: number, includeMmrProof?: boolean): Promise<{
    blockNum(): number;
    verificationBaseFee(): number;
    feeFaucetId(): AccountId;
    free(): void;
  }>;
  getAccountDetails(accountId: AccountId): Promise<{ free(): void; isPrivate(): boolean; account(): { vault(): { getBalance(faucet: AccountId): bigint; free(): void }; free(): void } | undefined }>;
  free(): void;
};

type RpcFactory = (endpoint: string) => PreviewRpc;
const createRpc: RpcFactory = (endpoint) => new RpcClient(new Endpoint(endpoint));

/** Reads an on-chain native balance only when the owner account is public. Private account assets
 * are not available through public RPC; this deliberately fails closed instead of prompting the wallet. */
export async function readPublicOwnerNativeBalance(endpoint: string, ownerAccountId: string, rpcFactory: RpcFactory = createRpc): Promise<bigint> {
  let rpc: PreviewRpc | undefined;
  let owner: AccountId | undefined;
  let faucet: AccountId | undefined;
  let fetched: Awaited<ReturnType<PreviewRpc["getAccountDetails"]>> | undefined;
  let account: ReturnType<NonNullable<typeof fetched>["account"]> | undefined;
  let vault: ReturnType<NonNullable<ReturnType<NonNullable<typeof fetched>["account"]>>["vault"]> | undefined;
  try {
    rpc = rpcFactory(endpoint);
    owner = AccountId.fromHex(normalizeAccountId(ownerAccountId));
    faucet = AccountId.fromHex(NATIVE_FEE_FAUCET_ID);
    fetched = await rpc.getAccountDetails(owner);
    if (fetched.isPrivate()) {
      throw new BootstrapPreviewBlockedError("read_owner_balance", "The owner account is private; public RPC cannot verify its native balance without a wallet asset request.");
    }
    account = fetched.account();
    if (!account) throw new BootstrapPreviewBlockedError("read_owner_balance", "The owner account has no public account state available from RPC.");
    vault = account.vault();
    return vault.getBalance(faucet);
  } catch (cause) {
    if (cause instanceof BootstrapPreviewBlockedError) throw cause;
    throw new BootstrapPreviewBlockedError("read_owner_balance", cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause));
  } finally {
    try { vault?.free(); } catch { /* cleanup must not mask the read */ }
    try { account?.free(); } catch { /* cleanup must not mask the read */ }
    try { fetched?.free(); } catch { /* cleanup must not mask the read */ }
    try { faucet?.free(); } catch { /* cleanup must not mask the read */ }
    try { owner?.free(); } catch { /* cleanup must not mask the read */ }
    try { rpc?.free(); } catch { /* cleanup must not mask the read */ }
  }
}

function isAccountNotFound(cause: unknown): boolean {
  const error = cause as { name?: string; message?: string };
  return /(?:resource|account)(?:\s+\w+){0,3}\s+(?:was\s+)?not found|accountnotfound/i.test(
    `${error?.name ?? ""} ${error?.message ?? String(cause)}`,
  );
}

/** Read-only endpoint checks. A successful account-details response always fails closed as "exists". */
export async function readBootstrapNetworkPreflight(
  endpoint: string,
  vaultAccountId: string,
  rpcFactory: RpcFactory = createRpc,
): Promise<BootstrapNetworkPreflight> {
  const rpc = rpcFactory(endpoint);
  const id = AccountId.fromHex(vaultAccountId);
  let header: Awaited<ReturnType<PreviewRpc["getBlockHeaderByNumber"]>> | undefined;
  let feeFaucet: AccountId | undefined;
  let fetched: Awaited<ReturnType<PreviewRpc["getAccountDetails"]>> | undefined;
  try {
    header = await rpc.getBlockHeaderByNumber(undefined, false);
    const referenceBlock = header.blockNum();
    const rawFee = header.verificationBaseFee();
    if (!Number.isSafeInteger(referenceBlock) || referenceBlock < 0) {
      throw new BootstrapPreviewBlockedError("read_network_header", "Miden Testnet returned an invalid reference block.");
    }
    if (!Number.isSafeInteger(rawFee) || rawFee < 0) {
      throw new BootstrapPreviewBlockedError("read_network_header", "Miden Testnet returned an invalid verification base fee.");
    }
    feeFaucet = header.feeFaucetId();
    const feeFaucetId = feeFaucet.toString().toLowerCase();
    let vaultExists = false;
    try {
      fetched = await rpc.getAccountDetails(id);
      vaultExists = true;
    } catch (cause) {
      if (!isAccountNotFound(cause)) {
        throw new BootstrapPreviewBlockedError("check_vault_absent", `Unable to establish that the candidate vault is undeployed: ${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}`);
      }
    }
    return { referenceBlock, verificationBaseFee: BigInt(rawFee), feeFaucetId, vaultExists };
  } catch (cause) {
    if (cause instanceof BootstrapPreviewBlockedError) throw cause;
    throw new BootstrapPreviewBlockedError("read_network_header", cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause));
  } finally {
    try { fetched?.free(); } catch { /* read result cleanup must not mask the read outcome */ }
    try { feeFaucet?.free(); } catch { /* read result cleanup must not mask the read outcome */ }
    try { header?.free(); } catch { /* read result cleanup must not mask the read outcome */ }
    try { id.free(); } catch { /* read result cleanup must not mask the read outcome */ }
    try { rpc.free(); } catch { /* read result cleanup must not mask the read outcome */ }
  }
}

function assertRequestShape(
  request: PreparedBootstrapFundingWalletRequest,
  ownerAccountId: string,
  vaultAccountId: string,
): void {
  const summary = request.summary;
  const owner = normalizeAccountId(ownerAccountId);
  const vault = normalizeAccountId(vaultAccountId);
  if (summary.kind !== "bootstrap" || summary.featureType !== "public") {
    throw new BootstrapPreviewBlockedError("validate_request", "Only a public bootstrap P2ID request is allowed in this preview.");
  }
  if (normalizeAccountId(summary.featureSender) !== owner
    || normalizeAccountId(summary.walletEnvelope.sender) !== owner
    || normalizeAccountId(summary.targetVaultId) !== vault
    || normalizeAccountId(summary.walletEnvelope.recipient) !== vault) {
    throw new BootstrapPreviewBlockedError("validate_request", "Bootstrap request owner or target does not match the expected accounts.");
  }
  if (summary.outputNoteCount !== 2
    || summary.featureAmount !== "1"
    || summary.sponsorshipAmount !== "150"
    || summary.requiredNativeOutputs !== "151"
    || summary.featureAsset?.toLowerCase() !== NATIVE_FEE_FAUCET_ID
    || summary.sponsorshipAsset.toLowerCase() !== NATIVE_FEE_FAUCET_ID
    || summary.sponsorshipFeatureNoteId.toLowerCase() !== summary.featureNoteId.toLowerCase()
    || !bootstrapRootsAreStandard(summary)
    || summary.networkTarget !== "P2ID target account"
    || summary.targetAttachmentPresent
    || summary.submitted
    || summary.walletInvoked) {
    throw new BootstrapPreviewBlockedError("validate_request", "Bootstrap request contains an unexpected output, amount, pairing, target, or prior action.");
  }
}

function bootstrapRootsAreStandard(summary: PreparedBootstrapFundingWalletRequest["summary"]): boolean {
  const p2id = NoteScript.p2id();
  const sponsorship = NoteScript.feeSponsorship();
  const p2idRoot = p2id.root();
  const sponsorshipRoot = sponsorship.root();
  try {
    return summary.featureScriptRoot.toLowerCase() === p2idRoot.toHex().toLowerCase()
      && summary.sponsorshipScriptRoot.toLowerCase() === sponsorshipRoot.toHex().toLowerCase();
  } finally {
    releaseSdkValue(p2idRoot, "caller-owned");
    releaseSdkValue(sponsorshipRoot, "caller-owned");
    releaseSdkValue(p2id, "caller-owned");
    releaseSdkValue(sponsorship, "caller-owned");
  }
}

function requireAbsentNote(note: NoteInspection, stage: string): void {
  if (note.classification !== "not_found") {
    throw new BootstrapPreviewBlockedError(stage, `Expected a fresh, absent bootstrap note; RPC classified it as ${note.classification}.`);
  }
}

export async function preflightBootstrapFunding(args: {
  endpoint?: string;
  connectedAddress: string;
  ownerNativeBalance: bigint;
  request: PreparedBootstrapFundingWalletRequest;
  networkRead?: typeof readBootstrapNetworkPreflight;
  noteRead?: typeof inspectNoteIndependently;
}): Promise<BootstrapFundingPreflight> {
  const publicPreflight = await preflightBootstrapPublic({
    endpoint: args.endpoint,
    connectedAddress: args.connectedAddress,
    request: args.request,
    networkRead: args.networkRead,
    noteRead: args.noteRead,
  });
  return completeBootstrapFundingPreflight(publicPreflight, args.ownerNativeBalance);
}

/** Public/local-only gates that must pass before asking the wallet to disclose assets. */
export async function preflightBootstrapPublic(args: {
  endpoint?: string;
  connectedAddress: string;
  request: PreparedBootstrapFundingWalletRequest;
  networkRead?: typeof readBootstrapNetworkPreflight;
  noteRead?: typeof inspectNoteIndependently;
}): Promise<BootstrapPublicPreflight> {
  const endpoint = args.endpoint ?? TESTNET_ENDPOINTS[0];
  let ownerAccountId: string;
  try { ownerAccountId = normalizeAccountId(args.connectedAddress); }
  catch { throw new BootstrapPreviewBlockedError("verify_owner", "Unable to verify the connected wallet identity."); }
  if (ownerAccountId !== BOOTSTRAP_PREVIEW_OWNER_ID) {
    throw new BootstrapPreviewBlockedError("verify_owner", "Connect the configured bootstrap owner wallet before previewing.");
  }
  if (args.request.summary.targetVaultId.toLowerCase() !== BOOTSTRAP_PREVIEW_VAULT_ID) {
    throw new BootstrapPreviewBlockedError("verify_vault", "The preview request does not target the approved deterministic vault candidate.");
  }
  assertRequestShape(args.request, ownerAccountId, BOOTSTRAP_PREVIEW_VAULT_ID);

  const network = await (args.networkRead ?? readBootstrapNetworkPreflight)(endpoint, BOOTSTRAP_PREVIEW_VAULT_ID);
  if (network.vaultExists) {
    throw new BootstrapPreviewBlockedError("check_vault_absent", "The candidate vault already exists on Miden Testnet; wallet preview is blocked.");
  }
  if (network.feeFaucetId.toLowerCase() !== NATIVE_FEE_FAUCET_ID) {
    throw new BootstrapPreviewBlockedError("verify_fee_asset", "The current network fee faucet does not match the configured native asset; fee preflight is blocked.");
  }

  const noteRead = args.noteRead ?? inspectNoteIndependently;
  const [feature, sponsorship] = await Promise.all([
    noteRead(endpoint, "bootstrap_p2id", args.request.summary.featureNoteId),
    noteRead(endpoint, "bootstrap_sponsorship", args.request.summary.sponsorshipNoteId),
  ]);
  requireAbsentNote(feature, "check_feature_note_absent");
  requireAbsentNote(sponsorship, "check_sponsorship_note_absent");

  return {
    ownerAccountId,
    vaultAccountId: BOOTSTRAP_PREVIEW_VAULT_ID,
    referenceBlock: network.referenceBlock,
    verificationBaseFee: network.verificationBaseFee.toString(),
    nativeFeeFaucet: network.feeFaucetId,
    p2idAmount: BOOTSTRAP_PREVIEW_P2ID_AMOUNT.toString(),
    sponsorshipAmount: BOOTSTRAP_PREVIEW_SPONSORSHIP.toString(),
    featureNoteStatusBefore: feature.classification,
    sponsorshipNoteStatusBefore: sponsorship.classification,
    vaultExists: false,
  };
}

export function completeBootstrapFundingPreflight(
  publicPreflight: BootstrapPublicPreflight,
  ownerNativeBalance: bigint,
): BootstrapFundingPreflight {
  const available = ownerNativeBalance;
  const verificationBaseFee = BigInt(publicPreflight.verificationBaseFee);
  const required = requiredNativeForCheckIn(BOOTSTRAP_PREVIEW_SPONSORSHIP, verificationBaseFee, BOOTSTRAP_PREVIEW_P2ID_AMOUNT);
  if (available < required) {
    throw new BootstrapPreviewBlockedError("fee_preflight", `Insufficient native balance. Required ${required} units; wallet-authorized balance is ${available}.`);
  }
  return {
    ownerAccountId: publicPreflight.ownerAccountId,
    vaultAccountId: publicPreflight.vaultAccountId,
    referenceBlock: publicPreflight.referenceBlock,
    verificationBaseFee: publicPreflight.verificationBaseFee,
    nativeFeeFaucet: publicPreflight.nativeFeeFaucet,
    ownerNativeBalance: available.toString(),
    p2idAmount: publicPreflight.p2idAmount,
    sponsorshipAmount: publicPreflight.sponsorshipAmount,
    feeReserve: (17n * verificationBaseFee).toString(),
    requiredNativeBalance: required.toString(),
    featureNoteStatusBefore: publicPreflight.featureNoteStatusBefore,
    sponsorshipNoteStatusBefore: publicPreflight.sponsorshipNoteStatusBefore,
    vaultExists: publicPreflight.vaultExists,
  };
}

/** Wallet asset IDs are Bech32 addresses; normalize before comparing so unrelated assets never count. */
export function nativeBalanceFromWalletAssets(
  assets: readonly { faucetId: string; amount: string }[],
  nativeFaucetId = NATIVE_FEE_FAUCET_ID,
): bigint {
  let balance = 0n;
  for (const asset of assets) {
    let faucetId: string;
    try { faucetId = normalizeAccountId(asset.faucetId); }
    catch { continue; }
    if (faucetId !== normalizeAccountId(nativeFaucetId)) continue;
    if (!/^\d+$/.test(asset.amount)) {
      throw new BootstrapPreviewBlockedError("read_wallet_assets", "Wallet returned an invalid native asset amount.");
    }
    balance += BigInt(asset.amount);
  }
  return balance;
}

export async function verifyBootstrapAfterCancel(args: {
  endpoint?: string;
  request: PreparedBootstrapFundingWalletRequest["summary"];
  manualCancelConfirmed: boolean;
  transactionId: string | null;
  vaultExecutionInvoked?: boolean;
  publicRpcMutationInvoked?: boolean;
  ownerNativeBefore: string | null;
  readOwnerNativeBalance?: () => Promise<bigint>;
  networkRead?: typeof readBootstrapNetworkPreflight;
  noteRead?: typeof inspectNoteIndependently;
}): Promise<BootstrapPostCancelEvidence> {
  if (args.transactionId !== null) {
    throw new BootstrapPreviewBlockedError("post_cancel_hard_stop", "A transaction ID was returned; automatic post-cancel classification is stopped.");
  }
  const endpoint = args.endpoint ?? TESTNET_ENDPOINTS[0];
  const [network, feature, sponsorship, assets] = await Promise.all([
    (args.networkRead ?? readBootstrapNetworkPreflight)(endpoint, BOOTSTRAP_PREVIEW_VAULT_ID),
    (args.noteRead ?? inspectNoteIndependently)(endpoint, "bootstrap_p2id", args.request.featureNoteId),
    (args.noteRead ?? inspectNoteIndependently)(endpoint, "bootstrap_sponsorship", args.request.sponsorshipNoteId),
    args.readOwnerNativeBalance ? args.readOwnerNativeBalance() : Promise.resolve(null),
  ]);
  const ownerNativeAfter = assets?.toString() ?? null;
  const ownerNativeBalanceUnchanged = ownerNativeAfter !== null && args.ownerNativeBefore !== null
    ? ownerNativeAfter === args.ownerNativeBefore
    : null;
  const hasUnexpectedChainEvidence = network.vaultExists
    || feature.classification !== "not_found" && feature.classification !== "query_error"
    || sponsorship.classification !== "not_found" && sponsorship.classification !== "query_error"
    || ownerNativeBalanceUnchanged === false
    || args.vaultExecutionInvoked === true
    || args.publicRpcMutationInvoked === true;
  const chainAbsenceProven = args.manualCancelConfirmed
    && args.transactionId === null
    && !network.vaultExists
    && feature.classification === "not_found"
    && sponsorship.classification === "not_found"
    && args.vaultExecutionInvoked !== true
    && args.publicRpcMutationInvoked !== true;
  const classification = hasUnexpectedChainEvidence
    ? "UNEXPECTED_CHAIN_EVIDENCE"
    : chainAbsenceProven
      ? "CANCEL_PREVIEW_PROVEN_NO_CHAIN_MUTATION"
      : "CANCEL_PREVIEW_INCOMPLETE";
  return {
    classification,
    manualCancelConfirmed: args.manualCancelConfirmed,
    transactionId: null,
    vaultExecutionInvoked: args.vaultExecutionInvoked ?? false,
    publicRpcMutationInvoked: args.publicRpcMutationInvoked ?? false,
    vaultExists: network.vaultExists,
    featureNoteStatus: feature.classification,
    sponsorshipNoteStatus: sponsorship.classification,
    ownerNativeBefore: args.ownerNativeBefore,
    ownerNativeAfter,
    ownerNativeBalanceUnchanged,
    safeCancelConfirmed: classification === "CANCEL_PREVIEW_PROVEN_NO_CHAIN_MUTATION",
    accountHistory: "not_available_from_public_rpc",
  };
}

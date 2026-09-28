import { AccountId } from "@miden-sdk/miden-sdk";

export type VaultOpenStatus = "idle" | "validating" | "loading" | "loaded" | "invalid_account_id" | "not_found" | "incompatible_account" | "rpc_error" | "sdk_error";
export type VaultReadStage = "normalize_vault_account_id" | "initialize_client" | "sync_client" | "parse_account_id" | "import_or_get_account" | "read_account" | "decode_vault_state" | "read_faucet_metadata" | "derive_role" | "dispose_cleanup";

export interface VaultReadDiagnostic {
  stage: string;
  errorName: string;
  errorMessage: string;
}

export class VaultReadError extends Error implements VaultReadDiagnostic {
  readonly stage: string;
  readonly errorName: string;
  readonly errorMessage: string;

  constructor(stage: string, cause: unknown) {
    const errorName = cause instanceof Error ? cause.name : typeof cause;
    const errorMessage = cause instanceof Error ? cause.message : String(cause);
    super(errorMessage);
    this.name = "VaultReadError";
    this.stage = stage;
    this.errorName = errorName;
    this.errorMessage = errorMessage;
  }
}

export interface ParsedVaultLocation {
  accountId: string | null;
  requested: boolean;
}

/** Accepts an Miden hex AccountId or Bech32 AccountId and returns canonical hex. */
export function parseVaultAccountId(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("Enter a vault Account ID.");
  const id = /^0x/i.test(value) ? AccountId.fromHex(value) : AccountId.fromBech32(value);
  try { return id.toString().toLowerCase(); }
  finally { id.free(); }
}

export function parseVaultLocation(pathname: string, search: string): ParsedVaultLocation {
  const queryId = new URLSearchParams(search).get("vault");
  const pathMatch = pathname.match(/^\/vault\/([^/]+)\/?$/);
  let pathId: string | null = null;
  try { pathId = pathMatch ? decodeURIComponent(pathMatch[1] ?? "") : null; }
  catch { pathId = pathMatch?.[1] ?? null; }
  const raw = queryId ?? pathId;
  if (!raw) return { accountId: null, requested: false };
  try { return { accountId: parseVaultAccountId(raw), requested: true }; }
  catch { return { accountId: raw, requested: true }; }
}

export function classifyVaultReadError(error: unknown): Exclude<VaultOpenStatus, "idle" | "validating" | "loading" | "loaded" | "invalid_account_id"> {
  const message = error instanceof Error ? error.message : String(error);
  if (/account.*(?:not found|does not exist)|resource not found|not found in (?:the )?network/i.test(message)) return "not_found";
  if (/not a Network Account|not a Heirbeat vault|storage is missing|missing (?:owner|beneficiary|timeout_blocks|last_check_in|activated|claimed)/i.test(message)) return "incompatible_account";
  if (error instanceof VaultReadError && (/^(?:decode_vault_state|dispose_cleanup)/.test(error.stage) || /RuntimeError|WebAssembly/.test(error.errorName))) return "sdk_error";
  if (/null pointer passed to rust|wasm|webassembly|runtime error|panicked|out of bounds/i.test(message)) return "sdk_error";
  return "rpc_error";
}

export function userSafeVaultError(status: VaultOpenStatus): string | null {
  switch (status) {
    case "not_found": return "No public account was found for this Account ID on Miden Testnet.";
    case "incompatible_account": return "This account is not a readable Heirbeat Network Account.";
    case "rpc_error": return "Unable to read this vault from Miden Testnet. Check your connection and try again.";
    case "sdk_error": return "The browser client could not decode this vault. Try again, or open developer diagnostics for details.";
    case "invalid_account_id": return "Enter a valid Miden Account ID in hex or Bech32 format.";
    default: return null;
  }
}

export function shortenedAccountId(accountId: string, edge = 7): string {
  if (accountId.length <= edge * 2 + 3) return accountId;
  return `${accountId.slice(0, edge)}…${accountId.slice(-edge)}`;
}

/** Convert raw fungible units using on-chain faucet decimals without Number precision loss. */
export function formatAssetAmount(amount: bigint, decimals?: number): string {
  if (decimals === undefined || decimals <= 0) return amount.toString();
  if (!Number.isInteger(decimals) || decimals > 38) return amount.toString();
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

import { Transaction } from "@miden-sdk/miden-wallet-adapter";
import type { TransactionRequest } from "@miden-sdk/miden-sdk";

/** Wraps an already-built SDK request in the official wallet adapter's custom request envelope. */
export function makeWalletTransactionRequest(senderAccountId: string, targetAccountId: string, request: TransactionRequest): Transaction {
  return Transaction.createCustomTransaction(senderAccountId, targetAccountId, request);
}

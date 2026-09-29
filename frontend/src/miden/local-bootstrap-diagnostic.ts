import {
  Account,
  AccountId,
  Felt,
  FeltArray,
  FungibleAsset,
  MidenClient,
  Note,
  NoteAndArgs,
  NoteAndArgsArray,
  NoteAssets,
  NoteMetadata,
  NoteRecipient,
  NoteScript,
  NoteStorage,
  NoteTag,
  NoteType,
  TransactionRequest,
  TransactionRequestBuilder,
  Word,
} from "@miden-sdk/miden-sdk";
import { constructVaultAccount, type VaultAccountConstructionSummary } from "./vault-account";
import { releaseSdkValue } from "./sdk-lifetime";
import { assertDeploymentRequestSemantics, summarizeRequestSerialization, type RequestSerializationDiff } from "./request-serialization";
import { lateExecutionIsSuccess, waitForDiagnosticExecution } from "./execution-watchdog";

export const LOCAL_BOOTSTRAP_STORE = "mock_client_db";
const TEST_OWNER = "0x528f6ca64fdf62410c36b5e00c4521";
const TEST_BENEFICIARY = "0x4181277bcf64381105ee61baadb5bc";
const TEST_INHERITED_FAUCET = "0x4020542183b9643120d0192be38793";
const TEST_NATIVE_FAUCET = "0x18101fa522c174b165efd4f70a0385";
const TEST_TIMEOUT_BLOCKS = 1_000_000;

export type BootstrapStageName =
  | "initialize_browser_client"
  | "construct_vault"
  | "classify_network_account"
  | "insert_vault_local"
  | "construct_bootstrap_p2id"
  | "construct_fee_sponsorship"
  | "construct_deployment_request"
  | "prepare_transaction"
  | "execute_transaction_locally"
  | "prove_transaction_locally";

export interface BootstrapStage {
  stage: BootstrapStageName;
  status: "running" | "success" | "failed" | "timed_out";
  detail?: string;
  elapsedMs?: number;
  lastCompletedSubstage?: string;
  promiseMayStillBeRunning?: boolean;
  errorName?: string;
  errorMessage?: string;
}

export interface BootstrapDiagnosticEvidence {
  storeName?: string;
  vaultAccountId?: string;
  expectedRustAccountId?: string;
  accountIdMatchesRustFixture?: boolean;
  accountTypeExport?: Array<[string, string]>;
  accountTypePublicRuntimeValue?: string;
  accountStorageMode?: string;
  accountPublic?: boolean;
  accountIdPublic?: boolean;
  accountIdPrefix?: string;
  featureNoteId?: string;
  sponsorshipNoteId?: string;
  sponsorshipPairedFeatureNoteId?: string;
  inputScriptRoots?: string[];
  deploymentTransactionId?: string;
  executedAccountId?: string;
  inputNoteCount?: number;
  outputNoteCount?: number;
  expectedScriptsStandardOnly?: boolean;
  requestSerialization?: RequestSerializationDiff;
  deploymentRequestSemantics?: "validated";
  expectedOwnOutputNoteCount?: number;
  executionTiming?: {
    startedAtUtc: string;
    elapsedMs: number;
    lastCompletedSubstage: string;
    eventLoopResponsiveTicks: number;
    eventLoopResponsive: boolean | null;
    promiseSettled: boolean;
    indexedDbRequests: "not_instrumented";
    workerCpuUsage: "not_exposed_to_page";
    workerAvailable: boolean;
    lateSettlement?: "fulfilled_ignored" | "rejected_ignored";
    lateError?: string;
  };
  accountStorageRuntime?: VaultAccountConstructionSummary["accountStorageRuntime"];
  walletInvoked: false;
  rpcSubmissionCalled: false;
}

export type BootstrapStageReporter = (stage: BootstrapStage, evidence: BootstrapDiagnosticEvidence) => void;
export const LOCAL_EXECUTION_TIMEOUT_MS = 90_000;
let unresolvedLocalExecution = false;

export function hasUnresolvedLocalExecution(): boolean {
  return unresolvedLocalExecution;
}

class StageError extends Error {
  constructor(readonly stage: BootstrapStageName, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = cause instanceof Error ? cause.name : "Error";
  }
}

function base64Bytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function deterministicWord(value: bigint): Word {
  return Word.newFromFelts([new Felt(value), new Felt(0n), new Felt(0n), new Felt(0n)]);
}

function noteRoot(note: Note): string {
  const script = note.script();
  const root = script.root();
  try { return root.toHex().toLowerCase(); }
  finally {
    releaseSdkValue(root, "caller-owned");
    releaseSdkValue(script, "caller-owned");
  }
}

function expectedNoteRoot(script: NoteScript): string {
  const root = script.root();
  try { return root.toHex().toLowerCase(); }
  finally { releaseSdkValue(root, "caller-owned"); releaseSdkValue(script, "caller-owned"); }
}

function assertStandardBootstrapScripts(roots: string[]): void {
  const p2id = NoteScript.p2id();
  const fee = NoteScript.feeSponsorship();
  const p2idRoot = p2id.root();
  const feeRoot = fee.root();
  try {
    const expected = [p2idRoot.toHex().toLowerCase(), feeRoot.toHex().toLowerCase()].sort();
    if (JSON.stringify([...roots].sort()) !== JSON.stringify(expected)) {
      throw new Error("Bootstrap includes an unexpected/nonstandard note script; refusing local preparation without expected_ntx_scripts support.");
    }
  } finally {
    releaseSdkValue(p2idRoot, "caller-owned");
    releaseSdkValue(feeRoot, "caller-owned");
    releaseSdkValue(p2id, "caller-owned");
    releaseSdkValue(fee, "caller-owned");
  }
}

export function isBootstrapDiagnosticEnabled(isDevelopmentBuild: boolean): boolean {
  return isDevelopmentBuild;
}

export function bootstrapScriptsAreStandard(roots: string[]): boolean {
  try { assertStandardBootstrapScripts(roots); return true; }
  catch { return false; }
}

export function networkAccountClassificationError(account: {
  networkAccount: boolean;
  accountPublic: boolean;
  accountIdPublic: boolean;
  networkNoteAllowlistCount: number | null;
}): string | null {
  if (!account.networkAccount) {
    return `Constructed account is not classified as a Network Account (isPublic=${account.accountPublic}, accountIdIsPublic=${account.accountIdPublic}, noteAllowlistCount=${account.networkNoteAllowlistCount}).`;
  }
  if (!account.accountPublic || !account.accountIdPublic || !account.networkNoteAllowlistCount) {
    return "Network Account classification metadata is inconsistent; refusing local insertion.";
  }
  return null;
}

export function stageFailure(stage: BootstrapStageName, cause: unknown): BootstrapStage {
  return {
    stage,
    status: "failed",
    errorName: cause instanceof Error ? cause.name : "Error",
    errorMessage: cause instanceof Error ? cause.message : String(cause),
  };
}

/**
 * Runs only against Miden's isolated mock client. It never creates an RPC
 * client and has no wallet or submit call in this module.
 */
export async function runLocalBootstrapDiagnostic(report: BootstrapStageReporter): Promise<BootstrapDiagnosticEvidence> {
  if (!isBootstrapDiagnosticEnabled(import.meta.env.DEV)) throw new Error("Local bootstrap diagnostic is available only in development builds.");
  if (unresolvedLocalExecution) throw new Error("A previous local SDK execution is still unresolved; do not start another diagnostic.");
  const evidence: BootstrapDiagnosticEvidence = { walletInvoked: false, rpcSubmissionCalled: false };
  let client: MidenClient | undefined;
  let account: Account | undefined;
  let owner: AccountId | undefined;
  let vaultId: AccountId | undefined;
  let nativeFaucet: AccountId | undefined;
  let p2id: Note | undefined;
  let sponsorship: Note | undefined;
  let request: ReturnType<TransactionRequestBuilder["build"]> | undefined;
  let execution: Awaited<ReturnType<MidenClient["transactions"]["executeRequest"]>> | undefined;
  let deferCleanup = false;
  let didCleanup = false;
  const cleanup = () => {
    if (didCleanup) return;
    didCleanup = true;
    releaseSdkValue(request, "caller-owned");
    releaseSdkValue(execution?.result, "caller-owned");
    releaseSdkValue(p2id, "caller-owned");
    releaseSdkValue(sponsorship, "caller-owned");
    releaseSdkValue(owner, "caller-owned");
    releaseSdkValue(vaultId, "caller-owned");
    releaseSdkValue(nativeFaucet, "caller-owned");
    releaseSdkValue(account, "caller-owned");
    client?.terminate();
  };
  const run = async <T,>(stage: BootstrapStageName, detail: string, action: () => Promise<T> | T): Promise<T> => {
    report({ stage, status: "running", detail }, { ...evidence });
    try {
      const value = await action();
      report({ stage, status: "success", detail }, { ...evidence });
      return value;
    } catch (cause) {
      const diagnostic = stageFailure(stage, cause);
      report(diagnostic, { ...evidence });
      throw new StageError(stage, cause);
    }
  };

  try {
    await run("initialize_browser_client", "Create mock RPC client in the SDK mock IndexedDB store; no testnet endpoint is configured.", async () => {
      client = await MidenClient.createMock({ seed: new Uint8Array(32).fill(0x81) });
      evidence.storeName = await client.storeIdentifier();
      if (evidence.storeName !== LOCAL_BOOTSTRAP_STORE) {
        throw new Error(`Unexpected SDK mock store '${evidence.storeName}'. Expected isolated '${LOCAL_BOOTSTRAP_STORE}'.`);
      }
    });

    const vault = await run("construct_vault", "Built deterministic Heirbeat account candidate with CLI-equivalent components.", async () =>
      constructVaultAccount({
        owner: TEST_OWNER,
        beneficiary: TEST_BENEFICIARY,
        inheritedFaucet: TEST_INHERITED_FAUCET,
        nativeFaucet: TEST_NATIVE_FAUCET,
        timeoutBlocks: TEST_TIMEOUT_BLOCKS,
        testSeed: new Uint8Array(32).fill(0x48),
      }));
    evidence.vaultAccountId = vault.accountId;
    evidence.expectedRustAccountId = "0x27c655040bca51d14069e50380bf6f";
    evidence.accountIdMatchesRustFixture = vault.accountId === evidence.expectedRustAccountId;
    evidence.accountTypeExport = vault.accountTypeExport;
    evidence.accountTypePublicRuntimeValue = vault.accountTypePublicRuntimeValue;
    evidence.accountStorageMode = vault.accountStorageMode;
    evidence.accountPublic = vault.accountPublic;
    evidence.accountIdPublic = vault.accountIdPublic;
    evidence.accountIdPrefix = vault.accountIdPrefix;
    evidence.accountStorageRuntime = vault.accountStorageRuntime;
    await run("classify_network_account", "Check the SDK runtime classification and public note-allowlist metadata before local insertion.", () => {
      const error = networkAccountClassificationError(vault);
      if (error) throw new Error(error);
    });
    account = Account.deserialize(base64Bytes(vault.serializedAccountBase64));
    owner = AccountId.fromHex(TEST_OWNER);
    vaultId = AccountId.fromHex(vault.accountId);
    nativeFaucet = AccountId.fromHex(TEST_NATIVE_FAUCET);

    await run("insert_vault_local", "Insert only into the isolated mock-client store; no normal testnet client is opened.", async () => {
      await client!.accounts.insert({ account: account!, overwrite: true });
    });

    await run("construct_bootstrap_p2id", "Create deterministic public 1-unit P2ID note targeted to the new vault.", () => {
      const storage = new NoteStorage(new FeltArray([vaultId!.suffix(), vaultId!.prefix()]));
      const recipient = new NoteRecipient(deterministicWord(1n), NoteScript.p2id(), storage);
      p2id = new Note(
        new NoteAssets([new FungibleAsset(nativeFaucet!, 1n)]),
        new NoteMetadata(owner!, NoteType.Public, NoteTag.withAccountTarget(vaultId!)),
        recipient,
      );
      const id = p2id.id();
      try { evidence.featureNoteId = id.toString(); }
      finally { releaseSdkValue(id, "caller-owned"); }
      evidence.inputScriptRoots = [noteRoot(p2id)];
    });

    await run("construct_fee_sponsorship", "Create deterministic 150-unit sponsorship note paired to the P2ID feature note.", () => {
      const featureId = Word.fromHex(evidence.featureNoteId!);
      evidence.sponsorshipPairedFeatureNoteId = featureId.toHex().toLowerCase();
      const storage = new NoteStorage(new FeltArray([
        ...featureId.toFelts(), owner!.suffix(), owner!.prefix(), new Felt(0n),
      ]));
      sponsorship = new Note(
        new NoteAssets([new FungibleAsset(nativeFaucet!, 150n)]),
        new NoteMetadata(owner!, NoteType.Public, NoteTag.withAccountTarget(vaultId!)),
        new NoteRecipient(deterministicWord(2n), NoteScript.feeSponsorship(), storage),
      );
      const id = sponsorship.id();
      try { evidence.sponsorshipNoteId = id.toString(); }
      finally { releaseSdkValue(id, "caller-owned"); }
      evidence.inputScriptRoots = [...evidence.inputScriptRoots!, noteRoot(sponsorship)];
    });

    await run("construct_deployment_request", "Build self-deployment request against the locally inserted vault using its two bootstrap notes as inputs.", () => {
      assertStandardBootstrapScripts(evidence.inputScriptRoots!);
      const noteAndArgs = new NoteAndArgsArray([
        new NoteAndArgs(Note.deserialize(p2id!.serialize())),
        new NoteAndArgs(Note.deserialize(sponsorship!.serialize())),
      ]);
      request = new TransactionRequestBuilder().withInputNotes(noteAndArgs).build();
    });
    evidence.expectedScriptsStandardOnly = true;

    await run("prepare_transaction", "Deserialize and semantically validate the self-deployment request locally; report bounded serialization normalization evidence.", () => {
      // The generated 0.16.3 binding returns a subarray into WASM linear memory.
      // Copy before any further SDK call can reuse that memory.
      const encoded = Uint8Array.from(request!.serialize());
      if (encoded.length === 0) throw new Error("Serialized deployment request is empty.");
      let roundTrip: TransactionRequest | undefined = TransactionRequest.deserialize(encoded);
      try {
        const roundTripBytes = Uint8Array.from(roundTrip.serialize());
        const secondRoundTrip = TransactionRequest.deserialize(roundTripBytes);
        try {
          const secondRoundTripBytes = Uint8Array.from(secondRoundTrip.serialize());
          evidence.requestSerialization = summarizeRequestSerialization(encoded, roundTripBytes, secondRoundTripBytes);
        } finally { releaseSdkValue(secondRoundTrip, "caller-owned"); }

        const featureId = evidence.featureNoteId!.toLowerCase();
        const sponsorshipId = evidence.sponsorshipNoteId!.toLowerCase();
        const expectedOwnOutputs = roundTrip.expectedOutputOwnNotes();
        evidence.expectedOwnOutputNoteCount = expectedOwnOutputs.length;
        expectedOwnOutputs.forEach((note) => releaseSdkValue(note, "caller-owned"));
        if (expectedOwnOutputs.length !== 0) throw new Error("Self-deployment request unexpectedly declares own output notes.");
        assertDeploymentRequestSemantics({
          actingVaultId: vaultId!.toString(),
          expectedVaultId: evidence.vaultAccountId!,
          featureNoteId: featureId,
          sponsorshipNoteId: sponsorshipId,
          sponsorshipFeatureNoteId: evidence.sponsorshipPairedFeatureNoteId!,
          featureScriptRoot: evidence.inputScriptRoots![0],
          sponsorshipScriptRoot: evidence.inputScriptRoots![1],
          expectedFeatureScriptRoot: expectedNoteRoot(NoteScript.p2id()),
          expectedSponsorshipScriptRoot: expectedNoteRoot(NoteScript.feeSponsorship()),
          inputNoteIds: [featureId, sponsorshipId],
        });
        evidence.deploymentRequestSemantics = "validated";

        // Execute the reconstructed request below, so the mock client's local
        // transaction validation also checks the serialized request contents.
        releaseSdkValue(request, "caller-owned");
        request = roundTrip;
        roundTrip = undefined;
      } finally { releaseSdkValue(roundTrip, "caller-owned"); }
    });

    report({
      stage: "execute_transaction_locally",
      status: "running",
      detail: "executeRequest dispatched to the SDK mock-client worker; waiting for local TransactionResult (no proving, submission, or persistence).",
      lastCompletedSubstage: "request dispatched; SDK exposes no finer execution progress",
    }, { ...evidence });
    const executePromise = client!.transactions.executeRequest(vaultId!, request!);
    const waited = await waitForDiagnosticExecution(executePromise, LOCAL_EXECUTION_TIMEOUT_MS, (progress) => {
      evidence.executionTiming = {
        startedAtUtc: progress.startedAtUtc,
        elapsedMs: progress.elapsedMs,
        lastCompletedSubstage: "request dispatched; waiting for SDK TransactionResult",
        eventLoopResponsiveTicks: progress.heartbeatCount,
        eventLoopResponsive: true,
        promiseSettled: false,
        indexedDbRequests: "not_instrumented",
        workerCpuUsage: "not_exposed_to_page",
        workerAvailable: typeof Worker !== "undefined",
      };
      report({
        stage: "execute_transaction_locally",
        status: "running",
        detail: `Still waiting for SDK execution response (${progress.elapsedMs} ms elapsed).`,
        elapsedMs: progress.elapsedMs,
        lastCompletedSubstage: evidence.executionTiming.lastCompletedSubstage,
        promiseMayStillBeRunning: true,
      }, { ...evidence });
    });

    if (waited.kind === "timed_out") {
      deferCleanup = true;
      unresolvedLocalExecution = true;
      const lastTick = waited.elapsedMs;
      const start = evidence.executionTiming?.startedAtUtc ?? new Date(Date.now() - lastTick).toISOString();
      evidence.executionTiming = {
        startedAtUtc: start,
        elapsedMs: waited.elapsedMs,
        lastCompletedSubstage: "request dispatched; no worker response received",
        eventLoopResponsiveTicks: evidence.executionTiming?.eventLoopResponsiveTicks ?? 0,
        eventLoopResponsive: (evidence.executionTiming?.eventLoopResponsiveTicks ?? 0) > 0 ? true : null,
        promiseSettled: false,
        indexedDbRequests: "not_instrumented",
        workerCpuUsage: "not_exposed_to_page",
        workerAvailable: typeof Worker !== "undefined",
      };
      report({
        stage: "execute_transaction_locally",
        status: "timed_out",
        detail: `Timed out waiting after ${waited.elapsedMs} ms. The SDK promise may still be running; no cancellation was sent.`,
        elapsedMs: waited.elapsedMs,
        lastCompletedSubstage: evidence.executionTiming.lastCompletedSubstage,
        promiseMayStillBeRunning: true,
      }, { ...evidence });
      void waited.settlement.then((settlement) => {
        const lateSuccess = lateExecutionIsSuccess(settlement);
        evidence.executionTiming = {
          ...evidence.executionTiming!,
          elapsedMs: Math.max(waited.elapsedMs, Date.now() - Date.parse(start)),
          promiseSettled: true,
          lateSettlement: settlement.status === "fulfilled" ? "fulfilled_ignored" : "rejected_ignored",
          ...(settlement.status === "rejected" ? { lateError: settlement.reason instanceof Error ? `${settlement.reason.name}: ${settlement.reason.message}` : String(settlement.reason) } : {}),
        };
        if (settlement.status === "fulfilled") releaseSdkValue(settlement.value.result, "caller-owned");
        cleanup();
        unresolvedLocalExecution = false;
        report({
          stage: "execute_transaction_locally",
          status: "timed_out",
          detail: lateSuccess ? "SDK completed after timeout; late result was ignored, not marked as a validated success." : "SDK promise settled after timeout; diagnostic remains timed out and does not advance.",
          elapsedMs: evidence.executionTiming.elapsedMs,
          lastCompletedSubstage: "SDK promise settled late; result ignored",
          promiseMayStillBeRunning: false,
        }, { ...evidence });
      });
      return { ...evidence };
    }

    if (waited.settlement.status === "rejected") {
      const failure = stageFailure("execute_transaction_locally", waited.settlement.reason);
      report({ ...failure, elapsedMs: waited.elapsedMs, lastCompletedSubstage: "SDK execution promise rejected" }, { ...evidence });
      throw new StageError("execute_transaction_locally", waited.settlement.reason);
    }

    execution = waited.settlement.value;
    evidence.executionTiming = {
      startedAtUtc: evidence.executionTiming?.startedAtUtc ?? new Date(Date.now() - waited.elapsedMs).toISOString(),
      elapsedMs: waited.elapsedMs,
      lastCompletedSubstage: "SDK returned TransactionResult",
      eventLoopResponsiveTicks: evidence.executionTiming?.eventLoopResponsiveTicks ?? 0,
      eventLoopResponsive: (evidence.executionTiming?.eventLoopResponsiveTicks ?? 0) > 0 ? true : null,
      promiseSettled: true,
      indexedDbRequests: "not_instrumented",
      workerCpuUsage: "not_exposed_to_page",
      workerAvailable: typeof Worker !== "undefined",
    };
    try {
      evidence.deploymentTransactionId = execution.id.toString();
      const executed = execution.result.executedTransaction();
      try {
        const finalHeader = executed.finalAccountHeader();
        try {
          const finalId = finalHeader.id();
          try { evidence.executedAccountId = finalId.toString(); }
          finally { releaseSdkValue(finalId, "caller-owned"); }
        } finally { releaseSdkValue(finalHeader, "caller-owned"); }
        const inputs = executed.inputNotes();
        try { evidence.inputNoteCount = inputs.numNotes(); }
        finally { releaseSdkValue(inputs, "caller-owned"); }
        const outputs = executed.outputNotes();
        try { evidence.outputNoteCount = outputs.numNotes(); }
        finally { releaseSdkValue(outputs, "caller-owned"); }
      } finally { releaseSdkValue(executed, "caller-owned"); }
    } catch (cause) {
      throw new StageError("execute_transaction_locally", cause);
    }
    report({ stage: "execute_transaction_locally", status: "success", detail: "SDK returned a locally executed TransactionResult; no proof or submission occurred.", elapsedMs: waited.elapsedMs, lastCompletedSubstage: "TransactionResult decoded" }, { ...evidence });

    await run("prove_transaction_locally", "Prove locally with the SDK default local prover. The resulting proof is not submitted.", async () => {
      await execution!.prove();
    });
    return { ...evidence };
  } finally {
    if (!deferCleanup) cleanup();
  }
}

export function deleteLocalBootstrapStore(factory: IDBFactory = indexedDB): Promise<"deleted" | "blocked"> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(LOCAL_BOOTSTRAP_STORE);
    request.onsuccess = () => resolve("deleted");
    request.onblocked = () => resolve("blocked");
    request.onerror = () => reject(request.error ?? new Error("Could not delete the app-owned mock database."));
  });
}

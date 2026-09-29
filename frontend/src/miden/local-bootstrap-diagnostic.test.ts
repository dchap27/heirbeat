import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AccountStorage, NoteScript } from "@miden-sdk/miden-sdk";
import { releaseSdkValue } from "./sdk-lifetime";
import { plainWordValues } from "./vault-account";
import { lateExecutionIsSuccess, waitForDiagnosticExecution } from "./execution-watchdog";
import {
  bootstrapScriptsAreStandard,
  deleteLocalBootstrapStore,
  isBootstrapDiagnosticEnabled,
  LOCAL_BOOTSTRAP_STORE,
  networkAccountClassificationError,
  stageFailure,
} from "./local-bootstrap-diagnostic";

describe("local bootstrap diagnostic guardrails", () => {
  it("records elapsed time and responsive event-loop heartbeats while execution is pending", async () => {
    vi.useFakeTimers();
    try {
      let finish!: (value: string) => void;
      const pending = new Promise<string>((resolve) => { finish = resolve; });
      const progress = vi.fn();
      const wait = waitForDiagnosticExecution(pending, 5_000, progress, 1_000);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(progress).toHaveBeenCalledTimes(2);
      expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({ elapsedMs: 2_000, heartbeatCount: 2 });
      finish("done");
      await expect(wait).resolves.toMatchObject({ kind: "settled", elapsedMs: 2_000, settlement: { status: "fulfilled", value: "done" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports timeout without cancelling the underlying SDK promise and ignores a late success", async () => {
    vi.useFakeTimers();
    try {
      let finish!: (value: string) => void;
      const pending = new Promise<string>((resolve) => { finish = resolve; });
      const wait = waitForDiagnosticExecution(pending, 2_000, () => undefined, 500);
      await vi.advanceTimersByTimeAsync(2_000);
      const timedOut = await wait;
      expect(timedOut.kind).toBe("timed_out");
      expect(timedOut).toMatchObject({ kind: "timed_out", elapsedMs: 2_000 });
      expect(lateExecutionIsSuccess({ status: "fulfilled", value: "late" })).toBe(false);
      finish("late");
      await expect(timedOut.settlement).resolves.toEqual({ status: "fulfilled", value: "late" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports rejection as a settled failure rather than a timeout or success", async () => {
    await expect(waitForDiagnosticExecution(Promise.reject(new Error("execution failed")), 100, () => undefined))
      .resolves.toMatchObject({ kind: "settled", settlement: { status: "rejected", reason: expect.objectContaining({ message: "execution failed" }) } });
  });

  it("is enabled only in Vite development builds", () => {
    expect(isBootstrapDiagnosticEnabled(true)).toBe(true);
    expect(isBootstrapDiagnosticEnabled(false)).toBe(false);
  });

  it("uses the SDK mock client's dedicated deterministic store, separate from the testnet client store", () => {
    expect(LOCAL_BOOTSTRAP_STORE).toBe("mock_client_db");
    expect(LOCAL_BOOTSTRAP_STORE).not.toContain("rpc.testnet.miden.io");
  });

  it("accepts only the standard P2ID and FeeSponsorship bootstrap script roots", () => {
    const p2id = NoteScript.p2id();
    const fee = NoteScript.feeSponsorship();
    const unexpected = NoteScript.networkAccountConfig();
    const p2idRoot = p2id.root();
    const feeRoot = fee.root();
    const unexpectedRoot = unexpected.root();
    try {
      expect(bootstrapScriptsAreStandard([p2idRoot.toHex(), feeRoot.toHex()])).toBe(true);
      expect(bootstrapScriptsAreStandard([p2idRoot.toHex(), feeRoot.toHex(), unexpectedRoot.toHex()])).toBe(false);
      expect(bootstrapScriptsAreStandard([unexpectedRoot.toHex()])).toBe(false);
    } finally {
      p2idRoot.free(); feeRoot.free(); unexpectedRoot.free();
      p2id.free(); fee.free(); unexpected.free();
    }
  });

  it("keeps failures attached to their exact stage without losing raw error details", () => {
    expect(stageFailure("execute_transaction_locally", new TypeError("missing note proof"))).toEqual({
      stage: "execute_transaction_locally",
      status: "failed",
      errorName: "TypeError",
      errorMessage: "missing note proof",
    });
  });

  it("reports a failed Network Account classification without touching a storage-like runtime value", () => {
    const runtime = {
      networkAccount: false,
      accountPublic: true,
      accountIdPublic: true,
      networkNoteAllowlistCount: null,
      storage: { constructor: { name: "AccountStorageView" } },
    };
    const message = networkAccountClassificationError(runtime);
    expect(message).toContain("isPublic=true");
    expect(message).toContain("accountIdIsPublic=true");
    expect(message).toContain("noteAllowlistCount=null");
    expect(runtime.storage).not.toHaveProperty("free");
  });

  it("does not free browser-like or borrowed/transferred storage values", async () => {
    const { disposeOwnedAccountStorage } = await import("./vault-account");
    const browserStorage = { constructor: { name: "AccountStorageView" } };
    const calls: string[] = [];
    const wrapperLike = { free: () => calls.push("free") };
    expect(disposeOwnedAccountStorage(browserStorage, "caller-owned")).toBe("runtime-managed");
    const typedButMissingDisposer = { constructor: { name: "StorageView" } } as unknown as AccountStorage;
    expect(disposeOwnedAccountStorage(typedButMissingDisposer, "caller-owned")).toBe("runtime-managed");
    expect(disposeOwnedAccountStorage(wrapperLike, "borrowed")).toBe("not-owned");
    expect(disposeOwnedAccountStorage(wrapperLike, "transferred")).toBe("not-owned");
    expect(calls).toEqual([]);
  });

  it("does not dispose the browser StorageResult returned by storage.getItem", () => {
    const frees = vi.fn();
    const storageResult = {
      constructor: { name: "StorageResult" },
      toFelts: () => [
        { asInt: () => 10n, free: frees },
        { asInt: () => 20n, free: frees },
        { asInt: () => 30n, free: frees },
        { asInt: () => 40n, free: frees },
      ],
    };
    expect(() => plainWordValues(storageResult)).not.toThrow();
    expect(plainWordValues(storageResult)).toEqual(["10", "20", "30", "40"]);
    expect(frees).toHaveBeenCalledTimes(8);
    expect(storageResult).not.toHaveProperty("free");
  });

  it("releases known caller-owned wrappers once, skips unknown ownership, and reports missing browser disposers", () => {
    const owned = { free: vi.fn() };
    const borrowed = { free: vi.fn() };
    const browserOwnedShape = { constructor: { name: "SdkWord" } };
    expect(releaseSdkValue(owned, "caller-owned")).toBe("released");
    expect(releaseSdkValue(owned, "caller-owned")).toBe("already-released");
    expect(releaseSdkValue(borrowed, "borrowed")).toBe("not-owned");
    expect(releaseSdkValue(browserOwnedShape, "caller-owned")).toBe("runtime-managed");
    expect(owned.free).toHaveBeenCalledTimes(1);
    expect(borrowed.free).not.toHaveBeenCalled();
  });

  it("does not let a destructor error mask the original construction or classification failure", () => {
    const brokenDestructor = { free: () => { throw new TypeError("bad WASM pointer"); } };
    expect(releaseSdkValue(brokenDestructor, "caller-owned")).toBe("cleanup-failed");
    const primary = new Error("account construction failed");
    expect(primary.message).toBe("account construction failed");
  });

  it("keeps construction, Network Account classification, and insertion as separate diagnostic stages", async () => {
    const source = await readFile(resolve(import.meta.dirname, "local-bootstrap-diagnostic.ts"), "utf8");
    const stages = ["construct_vault", "classify_network_account", "insert_vault_local"];
    expect(stages.every((stage) => source.includes(`"${stage}"`))).toBe(true);
    expect(source.indexOf('"construct_vault"')).toBeLessThan(source.indexOf('"classify_network_account"'));
    expect(source.indexOf('"classify_network_account"')).toBeLessThan(source.indexOf('"insert_vault_local"'));
  });

  it("keeps a timed-out execution visibly unresolved and never upgrades a late result to success", async () => {
    const source = await readFile(resolve(import.meta.dirname, "local-bootstrap-diagnostic.ts"), "utf8");
    const component = await readFile(resolve(import.meta.dirname, "../components/LocalBootstrapDiagnostic.tsx"), "utf8");
    expect(source).toContain('status: "timed_out"');
    expect(source).toContain("promiseMayStillBeRunning: true");
    expect(source).toContain('lateSettlement: settlement.status === "fulfilled" ? "fulfilled_ignored" : "rejected_ignored"');
    expect(source).toContain('stage: "execute_transaction_locally",\n          status: "timed_out"');
    expect(component).toContain("evidence.executionTiming?.promiseSettled === false || hasUnresolvedLocalExecution()");
    expect(component).toContain("disabled={running || executionPending}");
    expect(component).toContain("The diagnostic timed out while the SDK operation may still be running. It was not cancelled");
  });

  it("uses explicit runtime ownership cleanup and does not call storage?.free directly", async () => {
    const source = await readFile(resolve(import.meta.dirname, "vault-account.ts"), "utf8");
    expect(source).toContain("storage = account.storage();");
    expect(source).toContain('disposeOwnedAccountStorage(storage, "caller-owned")');
    expect(source).not.toContain("storage?.free();");
    expect(source).not.toContain("accountStorage.free();");
    expect(source).toContain("const networkAccount = account.isNetworkAccount();");
  });

  it("does not include wallet or submission calls in the local diagnostic implementation", async () => {
    const source = await readFile(resolve(import.meta.dirname, "local-bootstrap-diagnostic.ts"), "utf8");
    expect(source).not.toMatch(/requestTransaction|requestConsume|submitNewTransaction|\.submit\s*\(/);
    expect(source).toContain("createMock");
    expect(source).toContain("executeRequest");
    expect(source).toContain("\.prove()");
  });

  it("returns only plain, serializable state from the diagnostic reporter contract", () => {
    const state = {
      storeName: LOCAL_BOOTSTRAP_STORE,
      vaultAccountId: "0x27c655040bca51d14069e50380bf6f",
      featureNoteId: "0x01",
      walletInvoked: false as const,
      rpcSubmissionCalled: false as const,
    };
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it("deletes only the isolated SDK mock database when the developer explicitly requests reset", async () => {
    let requestedName = "";
    const fakeRequest = {} as IDBOpenDBRequest;
    const factory = {
      deleteDatabase(name: string) {
        requestedName = name;
        queueMicrotask(() => fakeRequest.onsuccess?.(new Event("success")));
        return fakeRequest;
      },
    } as unknown as IDBFactory;
    await expect(deleteLocalBootstrapStore(factory)).resolves.toBe("deleted");
    expect(requestedName).toBe(LOCAL_BOOTSTRAP_STORE);
  });

  it("keeps WASM wrappers out of React diagnostic state and uses only a mock client", async () => {
    const component = await readFile(resolve(import.meta.dirname, "../components/LocalBootstrapDiagnostic.tsx"), "utf8");
    const app = await readFile(resolve(import.meta.dirname, "../App.tsx"), "utf8");
    const source = await readFile(resolve(import.meta.dirname, "local-bootstrap-diagnostic.ts"), "utf8");
    expect(component).not.toContain("@miden-sdk/miden-sdk");
    expect(component).toContain("useState<BootstrapStage[]>");
    expect(component).toContain("useState<BootstrapDiagnosticEvidence>");
    expect(app).toContain("import.meta.env.DEV");
    expect(source).toContain("MidenClient.createMock");
    expect(source).not.toContain("MidenClient.createTestnet");
    expect(source).toContain("client!.accounts.insert");
    expect(source).toContain("client!.transactions.executeRequest(vaultId!, request!)");
  });
});

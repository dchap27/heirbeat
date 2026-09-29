import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultSnapshot } from "../domain/types";
import type { CheckInRecord } from "../domain/check-in";

const { inspect, readVault } = vi.hoisted(() => ({ inspect: vi.fn(), readVault: vi.fn() }));
vi.mock("./preview-evidence", () => ({ inspectNoteIndependently: inspect }));
vi.mock("../heirbeat/vault", () => ({ readVaultFromRpc: readVault }));
import { refreshCheckInStatus } from "./check-in";

const before: VaultSnapshot = {
  accountId: "0x01", owner: "0x02", beneficiary: "0x03", faucet: "0x04", nativeFeeFaucet: "0x05",
  timeoutBlocks: 10n, lastCheckIn: 100n, activated: true, claimed: false, inheritedBalance: 1n,
  nativeBalance: 0n, noteAllowlist: [], transactionScriptAllowlist: [], currentReferenceBlock: 101,
};
const record: CheckInRecord = {
  vaultId: before.accountId, state: "wallet_accepted", featureNoteId: "0xfeature", sponsorshipNoteId: "0xsponsor",
  walletTransactionId: "0xwallet-tx", preLastCheckIn: "100", preDeadline: "110",
};
const status = (networkStatus: string, classification = "query_error") => ({
  networkStatus, classification, inclusionFound: false, operations: [], label: "feature_note", noteId: "id",
});

beforeEach(() => { inspect.mockReset(); readVault.mockReset(); });

describe("read-only heartbeat status tracking", () => {
  it("keeps Pending distinct from committed/executed and queries both note IDs as strings", async () => {
    inspect.mockResolvedValueOnce(status("Pending")).mockResolvedValueOnce(status("", "committed_unconsumed"));
    const result = await refreshCheckInStatus("https://rpc.testnet.miden.io", before, record);
    expect(result.record.state).toBe("ntx_pending");
    expect(result.record.postLastCheckIn).toBeUndefined();
    expect(inspect).toHaveBeenNthCalledWith(1, expect.any(String), "feature_note", "0xfeature");
    expect(inspect).toHaveBeenNthCalledWith(2, expect.any(String), "sponsorship_note", "0xsponsor");
    expect(readVault).not.toHaveBeenCalled();
  });

  it("marks feature-note commitment without claiming execution", async () => {
    inspect.mockResolvedValueOnce(status("", "committed_unconsumed")).mockResolvedValueOnce(status("", "committed_unconsumed"));
    const result = await refreshCheckInStatus("https://rpc.testnet.miden.io", before, record);
    expect(result.record.state).toBe("feature_note_committed");
    expect(result.record.postLastCheckIn).toBeUndefined();
    expect(readVault).not.toHaveBeenCalled();
  });

  it("requires NullifierCommitted plus fresh increased vault state to confirm", async () => {
    inspect.mockResolvedValueOnce(status("NullifierCommitted")).mockResolvedValueOnce(status("NullifierCommitted"));
    readVault.mockResolvedValue({ snapshot: { ...before, lastCheckIn: 102n, currentReferenceBlock: 102 }, diagnostics: [] });
    const result = await refreshCheckInStatus("https://rpc.testnet.miden.io", before, record);
    expect(result.record.state).toBe("executed");
    expect(result.record.postLastCheckIn).toBe("102");
    expect(result.record.postDeadline).toBe("112");
  });

  it("does not confirm when fresh state is unchanged or becomes claimed", async () => {
    inspect.mockResolvedValue(status("NullifierCommitted"));
    readVault.mockResolvedValueOnce({ snapshot: before, diagnostics: [] }).mockResolvedValueOnce({ snapshot: { ...before, claimed: true }, diagnostics: [] });
    const unchanged = await refreshCheckInStatus("https://rpc.testnet.miden.io", before, record);
    const claimed = await refreshCheckInStatus("https://rpc.testnet.miden.io", before, record);
    expect(unchanged.record.state).toBe("unknown");
    expect(claimed.record.state).toBe("unknown");
    expect(claimed.record.message).toContain("not a confirmed heartbeat");
  });

  it("preserves note query failures as unknown diagnostics for read-only retry", async () => {
    inspect.mockResolvedValueOnce({ ...status("", "query_error"), operations: [{ stage: "feature_get_network_note_status_call", outcome: "error", errorName: "Error", errorMessage: "offline" }] })
      .mockResolvedValueOnce(status("", "not_found"));
    const result = await refreshCheckInStatus("https://rpc.testnet.miden.io", before, record);
    expect(result.record.state).toBe("unknown");
    expect(result.record.diagnostic).toMatchObject({ stage: "feature_get_network_note_status_call", errorMessage: "offline" });
  });
});

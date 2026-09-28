import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { deriveLifecycle, deriveRole } from "../domain/lifecycle";
import type { VaultSnapshot } from "../domain/types";
import { HomePage } from "../pages/HomePage";
import { OpenVaultForm } from "./OpenVaultForm";
import {
  AdvancedVaultDetails,
  InheritanceCard,
  LifecycleTimeline,
  VaultActions,
  VaultDashboard,
} from "./VaultDashboard";

const owner = "0xa61714a99ec761910e397cbac32cd";
const beneficiary = "0x4181277bcf64381105ee61baadb5bc";
const snapshot: VaultSnapshot = {
  accountId: "0xc01fe4f8003940514cdfc0bb2be577",
  owner,
  beneficiary,
  faucet: "0x4020542183b9643120d0192be38793",
  nativeFeeFaucet: "0x18101fa522c174b165efd4f70a0385",
  timeoutBlocks: 10n,
  lastCheckIn: 507636n,
  activated: true,
  claimed: true,
  inheritedBalance: 0n,
  nativeBalance: 169n,
  noteAllowlist: ["0xcheckin", "0xclaim", "0xdeposit"],
  transactionScriptAllowlist: ["0xexpiration"],
  currentReferenceBlock: 507700,
  inheritedAssetSymbol: "HBTESTV",
  inheritedAssetDecimals: 6,
};

describe("read-only product surfaces", () => {
  it("renders the empty dashboard with explicit vault access and no fake discovery", () => {
    const html = renderToStaticMarkup(<HomePage hasVault={false} onOpen={() => {}} onCreate={() => {}} />);
    expect(html).toContain("Your digital inheritance,");
    expect(html).toContain("Open existing vault");
    expect(html).toContain("Vaults are opened using their Account ID");
    expect(html).not.toContain("My vaults");
  });

  it("separates inherited assets from network fee balance", () => {
    const html = renderToStaticMarkup(<InheritanceCard snapshot={snapshot} />);
    expect(html).toContain("HBTESTV");
    expect(html).toContain("Network fee balance");
    expect(html).toContain("Separate from inheritance assets");
    expect(html).toContain("native fee units");
  });

  it("maps active, claimable, setup and claimed chain states", () => {
    expect(deriveLifecycle({ ...snapshot, claimed: false, currentReferenceBlock: 507645 }).lifecycle).toBe("active");
    expect(deriveLifecycle({ ...snapshot, claimed: false, currentReferenceBlock: 507646 }).lifecycle).toBe("claimable");
    expect(deriveLifecycle({ ...snapshot, claimed: false, activated: false }).lifecycle).toBe("setup");
    expect(deriveLifecycle(snapshot).lifecycle).toBe("claimed");
  });

  it("highlights the current lifecycle stage", () => {
    const html = renderToStaticMarkup(<LifecycleTimeline state="claimed" />);
    expect(html).toContain("aria-current=\"step\"");
    expect(html).toContain("Claimed");
    expect(html).toContain("class=\"complete \"");
    expect(html).toContain("aria-current=\"step\"");
  });

  it("shows no mutation controls for an observer or a terminal vault", () => {
    expect(deriveRole("0xa123456789abcdef0123456789abcdef", owner, beneficiary)).toBe("observer");
    const html = renderToStaticMarkup(<VaultActions snapshot={snapshot} role="observer" />);
    expect(html).toContain("Inheritance claimed");
    expect(html).not.toContain("<button");
  });

  it("keeps owner and beneficiary actions disabled until live action support exists", () => {
    const active = { ...snapshot, claimed: false, currentReferenceBlock: 507645 };
    const ownerHtml = renderToStaticMarkup(<VaultActions snapshot={active} role="owner" />);
    expect(ownerHtml).toContain("Check in · coming soon");
    expect(ownerHtml).toContain("disabled");
    const beneficiaryHtml = renderToStaticMarkup(<VaultActions snapshot={active} role="beneficiary" />);
    expect(beneficiaryHtml).toContain("Claim becomes available at block 507646");
    expect(beneficiaryHtml).toContain("disabled");
    const claimableHtml = renderToStaticMarkup(<VaultActions snapshot={{ ...active, currentReferenceBlock: 507646 }} role="beneficiary" />);
    expect(claimableHtml).toContain("Claim is available");
    expect(claimableHtml).toContain("disabled");
  });

  it("renders advanced raw on-chain details separately", () => {
    const html = renderToStaticMarkup(<AdvancedVaultDetails snapshot={snapshot} endpoint="https://rpc.testnet.miden.io" />);
    expect(html).toContain("Advanced details");
    expect(html).toContain("Note allowlist roots");
    expect(html).toContain("Transaction-script roots");
    expect(html).toContain("Current reference block");
  });

  it("keeps WASM errors out of normal vault-opening copy but preserves them in closed developer details", () => {
    const html = renderToStaticMarkup(<OpenVaultForm
      value={snapshot.accountId}
      status="sdk_error"
      detail="The browser client could not decode this vault. Try again, or open developer diagnostics for details."
      diagnostics={[{ stage: "decode_vault_state", errorName: "RuntimeError", errorMessage: "null pointer passed to rust" }]}
      onChange={() => {}}
      onSubmit={() => {}}
    />);
    expect(html).toContain("The browser client could not decode this vault");
    expect(html).toContain("<details class=\"developer-details\">");
    expect(html).toContain("Stage: decode_vault_state");
    expect(html).toContain("null pointer passed to rust");
    expect(html).not.toContain("network read failed");
  });

  it("renders claimed terminal state as an observer without enabling actions", () => {
    const html = renderToStaticMarkup(<VaultDashboard snapshot={snapshot} connectedAccount="0xa123456789abcdef0123456789abcdef" endpoint="https://rpc.testnet.miden.io" onClose={() => {}} />);
    expect(html).toContain("Claimed");
    expect(html).toContain("Observer");
    expect(html).toContain("No operation in progress");
    expect(html).toContain("Inheritance claimed");
    expect(html).not.toContain("Preview Heirbeat");
    expect(html).not.toContain("Preview P2ID");
  });
});

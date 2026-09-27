# Heirbeat Security Findings

Assessment scope: source and local test review on `sprint7-1-config-freeze`; no live-testnet mutation or protocol redesign. Findings distinguish code defects from accepted key custody and infrastructure assumptions.

## Findings

### S7-01 — Deployment finalization accepted temporary P2ID input permission

- **Severity:** HIGH
- **Status:** MITIGATED
- **Affected component:** `integration/src/bin/testnet_lifecycle.rs` deployment/resume verification
- **Description:** The CLI's vault verifier accepted either the final hardened note roots or the bootstrap set with P2ID. A resumed deployment could interpret a still-bootstrap-configured vault as finalized and skip cleanup.
- **Exploit scenario:** An interrupted `deploy-vault` has persisted a pending vault with P2ID still input-allowlisted. A rerun sees the bootstrap roots as valid and writes the vault ID as complete, leaving the extra public input script enabled.
- **Impact:** Broadens the Network Account's note execution surface beyond the required final policy.
- **Evidence/test:** Found by source review of `verify_vault` and its `finalized` check. The CLI now shares an exact hardened allowlist validator, which rejects missing roots, extra roots, P2ID, and transaction-script broadening.
- **Mitigation:** Deployment completion now requires `activated == 1`, exactly check-in, claim, deposit, and FeeSponsorship note roots, and exactly the canonical expiration transaction-script root. Bootstrap P2ID and NetworkAccountConfig are absent from the activated state.
- **Residual risk:** Bootstrap cleanup and activation are live external transactions; failure leaves deployment incomplete and the CLI does not report the vault as finalized.

### S7-02 — Compromised owner can keep an active vault ineligible

- **Severity:** HIGH
- **Status:** OPEN
- **Affected component:** Vault owner authority / heartbeat policy
- **Description:** While active, the configured owner can refresh heartbeat indefinitely. A compromised owner key can do the same and postpone beneficiary eligibility. The current protocol has no owner rotation, recovery, freeze, or maximum-heartbeat policy.
- **Exploit scenario:** An attacker controls the owner key and periodically submits valid check-in notes, preventing the inactivity deadline from being reached.
- **Impact:** Beneficiary access can be delayed indefinitely. The attacker still cannot claim without beneficiary authority and cannot change the beneficiary through current Heirbeat feature procedures.
- **Evidence/test:** Owner-only heartbeat and heartbeat extension are exercised by MockChain tests; this outcome follows directly from the authorized state transition.
- **Mitigation:** No mitigation exists in the current protocol. Keep owner keys strongly protected and disclose this limitation to vault creators/beneficiaries.
- **Residual risk:** Protocol-level recovery/rotation would change governance semantics and requires architectural review before production; no new mechanism is introduced here.

### S7-03 — Owner-authorized Network Account configuration was mutable after deployment

- **Severity:** HIGH
- **Status:** MITIGATED
- **Affected component:** v0.16 `NetworkAccountConfigNote` and account access-control policy
- **Description:** Before this sprint, the standard `NetworkAccountConfigNote` root remained allowed after deployment, so the owner could continue changing note roots, transaction-script roots, and fee-policy roots. The v0.16 config script calls `AuthNetworkAccount` mutation procedures gated by account-wide Authority.
- **Exploit scenario:** An owner key holder, or an attacker with that key, submits an authorized config note after the vault was considered live and changes the accepted execution surface.
- **Impact:** Could add an unreviewed execution path or remove required Heirbeat paths.
- **Evidence/test:** Stable v0.16 `network_account_config.masm` and `network_account.masm` source inspected. New MockChain activation coverage proves setup config works before activation, activation consumes exactly once, post-activation add/remove note roots and tx-script changes are rejected, state is atomic, and heartbeat/claim still succeed.
- **Mitigation:** The immutable vault activation procedure checks owner sender, unclaimed/unactivated state, P2ID absence, and activation input-note composition. It atomically sets `activated=1` and writes empty values to the NetworkAccountConfig and activation roots in AuthNetworkAccount's note-allowlist map. AuthNetworkAccount uses initial storage for its allowlist check, so activation finishes while later config-note transactions fail before script execution. The CLI requires the exact pre-activation roots and expiration-only tx script before activation.
- **Residual risk:** Miden exposes no in-component enumeration for arbitrary map entries. The component enforces removal of the config path and P2ID absence; the CLI checks the complete exact pre-activation set. A raw owner bypassing the CLI can create extra roots before activation and then freeze them in place. This is a setup trust boundary, not post-activation config authority.

### S7-04 — Local keystore compromise or loss compromises account authority

- **Severity:** CRITICAL for theft-capable compromise; HIGH for unrecoverable loss
- **Status:** OPEN
- **Affected component:** Miden keystore and local workstation
- **Description:** A party able to read/use the local signing keys can submit transactions as those accounts. Loss of the only key material may make accounts inaccessible. Workspace ignore rules prevent accidental Git tracking but do not encrypt or back up credentials.
- **Exploit scenario:** Malware, host administrator, shell access, or backup exposure copies/uses keystore entries; alternatively, durable state is deleted.
- **Impact:** Owner/beneficiary/faucet authority can be exercised by the attacker; key loss can prevent heartbeat, claim, minting, or payout consumption.
- **Evidence/test:** CLI opens a filesystem keystore and verifies key presence. Static audit found no serialization or logging of key contents. Restart tests establish persistence, not confidentiality/recovery.
- **Mitigation:** Keys remain in the keystore; public JSON config and lifecycle records contain public identifiers only; config rejects unknown fields so accidental secret-like fields are not accepted as config.
- **Residual risk:** Host security, encryption-at-rest, backup, key rotation, and recovery remain operator responsibilities. A production key-custody and recovery design requires security review.

### S7-05 — NTX operator or public-testnet service can delay/censor Network Account actions

- **Severity:** HIGH for sustained censorship; MEDIUM for delay
- **Status:** OPEN
- **Affected component:** Public NTX builder/operator, node, note discovery
- **Description:** Public-testnet Network Account feature notes require service discovery and operator execution. A user cannot directly submit the post-deployment Network Account transaction through the tested public endpoint.
- **Exploit scenario:** The NTX service ignores a valid targeted feature note or sponsorship, or the node/service is unavailable.
- **Impact:** Deposit, heartbeat, or claim can be delayed or censored. This is a liveness failure, not a contract authorization bypass.
- **Evidence/test:** End-to-end testnet deposit/heartbeat/claim used `NetworkAccountTarget::new(vault, Always)` and automatic NTX execution; prior direct submission was rejected by the endpoint.
- **Mitigation:** Canonical attachment, feature-note/sponsorship pairing, bounded polling, observable transaction/note status.
- **Residual risk:** No permissionless public fallback or censorship-proof liveness mechanism was established. NTX liveness and censorship assumptions require operational/architectural review before production.

### S7-06 — Excess fee sponsorship recovery is not established

- **Severity:** LOW
- **Status:** OPEN
- **Affected component:** Standard FeeSponsorshipNote / Network Account fee policy
- **Description:** The CLI pairs sponsorship by exact feature-note ID and uses a fixed practical amount. This review did not establish whether an amount above the actual fee is refunded, retained, or otherwise recoverable under every v0.16 fee path.
- **Exploit scenario:** A sender overfunds a sponsorship note, or a third party deliberately creates a large sponsor amount for an accepted note.
- **Impact:** Fee assets may be temporarily or permanently stranded; no inherited asset is changed by sponsorship alone.
- **Evidence/test:** Pairing/mismatch is unit tested and live sponsorship has been exercised. Excess/refund behavior lacks a targeted test.
- **Mitigation:** Avoid excessive amounts; use the existing conservative sponsorship amount and inspect committed fee balances.
- **Residual risk:** Confirm exact standard fee/refund semantics before changing fee defaults.

### S7-07 — Faucet authority can inflate test-asset supply

- **Severity:** MEDIUM
- **Status:** ACCEPTED
- **Affected component:** Configured fungible faucet
- **Description:** Test faucets use a single-signature allow-all mint policy within a configured maximum supply. Faucet key compromise can issue assets and invalidate simple supply/accounting expectations.
- **Exploit scenario:** Attacker with faucet signer mints more test tokens than the lifecycle record expects.
- **Impact:** Test accounting becomes misleading; it does not rewrite the vault's configured faucet or its authorization state.
- **Evidence/test:** Faucet supply/balances are read from chain in CLI verify and were reconciled in the live lifecycle.
- **Mitigation:** Keep faucet key separate and treat the asset as test-only; verify total supply and balances.
- **Residual risk:** No production issuance governance is claimed.

### S7-08 — Contract SDK graph contains an SDK-pinned protocol release candidate

- **Severity:** INFO
- **Status:** MITIGATED
- **Affected component:** Contract compiler dependency graph
- **Description:** The official contract SDK `miden 0.14.0` resolves through `miden-base-macros 0.14.0` to `miden-protocol 0.16.0-rc.4`. The host integration graph independently resolves stable protocol `0.16.1` and VM `0.29.4`.
- **Exploit scenario:** An unreviewed dependency upgrade or graph unification could compile against a different ABI/runtime surface.
- **Impact:** Package/runtime incompatibility or changed protocol assumptions.
- **Evidence/test:** `cargo tree` confirms the RC is below the contract SDK; host `cargo tree -p integration` shows stable protocol only. Package loading and behavioral tests run against the stable host stack.
- **Mitigation:** Exact version pins and separate contract/host lockfiles; no patch or override is used.
- **Residual risk:** Recheck graph isolation and artifact execution whenever the official toolchain or SDK is upgraded.

### S7-09 — Local CLI configuration is public metadata and must stay non-secret

- **Severity:** LOW
- **Status:** MITIGATED
- **Affected component:** `TestnetConfig`, CLI JSON and lifecycle record
- **Description:** Configuration is serialized JSON. Unknown fields were previously ignored by Serde, allowing a secret-like field to coexist in a config file without being part of the typed model. The config now denies unknown fields.
- **Exploit scenario:** A user mistakenly places a private key or seed in the public config and assumes the CLI manages it safely.
- **Impact:** Secret exposure through local files or backups, independent of account protocol authorization.
- **Evidence/test:** Config serialization test and new test rejecting `private_key`; code audit found no debug output of key bytes.
- **Mitigation:** Keystore-only key storage, deny unknown config fields, no raw key logging, and public-only JSON/status values.
- **Residual risk:** Operators can still create arbitrary files or expose the keystore; the CLI cannot secure a compromised host.

## Severity summary

- **Critical:** 1 open key-compromise risk (S7-04); protocol attack paths for forged sender, unauthorized claim, unsupported asset, replay, and payout substitution are mitigated by existing tests/invariants.
- **High:** 2 open architectural/operational risks (S7-02 owner compromise and S7-05 NTX censorship); S7-01 and S7-03 are mitigated.
- **Medium:** faucet issuance/accounting accepted (S7-07); NTX delay and sponsorship denial/stranding are captured as operational residual risks.
- **Low:** excess sponsorship recovery open (S7-06); local config handling mitigated (S7-09).
- **Info:** version graph pinning is mitigated and monitored (S7-08).

S7-03 is mitigated for the MVP activation model: post-activation configuration is blocked at the account's note-authorization layer, not only by CLI checks. Exact setup-state verification remains a CLI precondition because map enumeration is unavailable in the account component. The open HIGH items are explicitly architectural/operational risks and should be reviewed before production deployment.

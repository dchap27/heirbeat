# Heirbeat Security Findings

Assessment scope: source and local test review on `sprint7-security-hardening`; no live-testnet mutation or protocol redesign. Findings distinguish code defects from accepted key custody and infrastructure assumptions.

## Findings

### S7-01 — Deployment finalization accepted temporary P2ID input permission

- **Severity:** HIGH
- **Status:** MITIGATED
- **Affected component:** `integration/src/bin/testnet_lifecycle.rs` deployment/resume verification
- **Description:** The CLI's vault verifier accepted either the final hardened note roots or the bootstrap set with P2ID. A resumed deployment could interpret a still-bootstrap-configured vault as finalized and skip cleanup.
- **Exploit scenario:** An interrupted `deploy-vault` has persisted a pending vault with P2ID still input-allowlisted. A rerun sees the bootstrap roots as valid and writes the vault ID as complete, leaving the extra public input script enabled.
- **Impact:** Broadens the Network Account's note execution surface beyond the required final policy.
- **Evidence/test:** Found by source review of `verify_vault` and its `finalized` check. The CLI now shares an exact hardened allowlist validator, which rejects missing roots, extra roots, P2ID, and transaction-script broadening.
- **Mitigation:** Deployment completion now requires exactly check-in, claim, deposit, NetworkAccountConfig, and FeeSponsorship note roots plus exactly the canonical expiration transaction-script root. Bootstrap P2ID is rejected as a final state.
- **Residual risk:** Deployment cleanup remains a live external transaction; a failed cleanup leaves deployment incomplete and CLI config does not mark the vault active.

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

### S7-03 — Owner-authorized Network Account configuration can change the accepted surface

- **Severity:** HIGH
- **Status:** OPEN
- **Affected component:** v0.16 `NetworkAccountConfigNote` and account access-control policy
- **Description:** The standardized config-note procedure can update note/transaction-script allowlists when authorized by the account's configured access-control component. This is a governance capability, not immutable Heirbeat policy. An authorized owner can add P2ID or remove a Heirbeat/system root.
- **Exploit scenario:** An owner key holder issues an authorized config note that broadens accepted roots, or an attacker with the owner key does so.
- **Impact:** The configured execution surface changes; adding a malicious script could create an authorization path outside the reviewed Heirbeat procedures.
- **Evidence/test:** `security` coverage in `fee_sponsorship_bootstraps_empty_network_account` proves a beneficiary-sent config note is rejected, while the configured owner can remove/re-add P2ID, a Heirbeat root, and the expiration transaction-script root, and can remove the config/sponsorship roots. Exact local allowlist checks reject unexpected state before CLI feature operations.
- **Mitigation:** Owner authorization, exact hardened-state validation in CLI preflight, and public state verification.
- **Residual risk:** CLI validation cannot stop an owner-authorized config update or constrain the standard component on-chain. Making roots immutable or changing governance requires architectural review.

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
- **High:** 3 open architectural/operational risks (S7-02 owner compromise, S7-03 config governance, S7-05 NTX censorship) plus S7-01 mitigated.
- **Medium:** faucet issuance/accounting accepted (S7-07); NTX delay and sponsorship denial/stranding are captured as operational residual risks.
- **Low:** excess sponsorship recovery open (S7-06); local config handling mitigated (S7-09).
- **Info:** version graph pinning is mitigated and monitored (S7-08).

No unresolved code defect in the local contract procedures was identified in this sprint. The open HIGH items are explicitly architectural/operational risks and should be reviewed before production deployment.

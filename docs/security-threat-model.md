# Heirbeat Security Threat Model

**Scope.** This document describes the current v0.16 Heirbeat heartbeat and inheritance implementation, the productized lifecycle CLI, and its public-testnet execution environment. It is a security review of existing behavior, not a claim of a formal audit. No live-testnet mutations are part of this review.

## System overview

Heirbeat is a public Miden Network Account containing the `heirbeat-vault` component. Its persistent protocol state is `owner`, `asset_faucet`, `beneficiary`, `claimed`, `last_check_in`, and `timeout_blocks`. The `check-in-note`, `claim-note`, and `deposit-note` scripts invoke the installed vault procedures. A check-in and a claim derive sender identity from the active note context. A claim is eligible when the transaction reference block is at least `last_check_in + timeout_blocks`; it sets the terminal flag and creates a standard P2ID output for the stored beneficiary while removing the entire configured-faucet balance. Deposits accept only the configured fungible faucet and do not update heartbeat state.

The vault is public and recognized as a Network Account through the standardized v0.16 storage/configuration components. Its hardened note roots are exactly the three Heirbeat scripts, `NetworkAccountConfigNote`, and `FeeSponsorshipNote`. Its transaction-script allowlist is exactly the canonical expiration script. P2ID is a permitted temporary deployment/bootstrap input root only; the CLI must remove it before reporting deployment complete. Network Account feature notes carry `NetworkAccountTarget(vault, Always)` and are discovered/executed by the NTX builder. The user submits the ordinary wallet transaction that commits the feature and paired sponsorship notes; the user does not submit the Network Account transaction.

## Protected assets

| Asset | Security property | Boundary |
|---|---|---|
| Inherited fungible assets | Only the configured faucet is admitted; eligible claim transfers the full balance once | On-chain vault and transaction kernel |
| Owner authority | Only the configured owner may refresh `last_check_in` | Active-note sender and vault component |
| Beneficiary authority | Only the configured beneficiary may claim | Active-note sender and vault component |
| Heartbeat freshness and timeout correctness | Reference block is protocol context; widened deadline arithmetic does not wrap | Transaction context and vault storage |
| Claim exclusivity / terminal state | One successful claim, no later heartbeat or deposit | Vault storage and note nullifiers |
| Payout destination and amount | Stored beneficiary and pre-claim full balance determine P2ID | Vault procedure and canonical P2ID code |
| Network Account configuration / allowlists | Only intended input scripts and expiration transaction script remain enabled | Standard account components and owner-authorized config note |
| Sponsorship accounting | Fee sponsorship is separate from inherited-asset balance | Network Account fee policy and sponsorship note |
| Local signing keys and faucet authority | Keys stay in the Miden keystore | Client process, filesystem, host |
| Durable CLI state and public identifiers | Configuration describes the same network/accounts as chain state | CLI config, SQLite store, RPC |
| Credential privacy | Seeds, private keys, and authentication material must not enter logs/config/records | Workstation and CLI output |

On-chain assets and authorization state are distinct from client-side keys and data. The public-testnet operator, node, faucet, and the local workstation are separate trust domains; one does not inherit the guarantees of another.

## Actors and authority

| Actor | Permissions / capabilities | Must not be able to do |
|---|---|---|
| Owner | Send authorized heartbeat and deposits; authorize standard account configuration updates under the installed access-control policy | Claim as beneficiary or change beneficiary through current Heirbeat procedures |
| Beneficiary | Claim after the deadline and consume a P2ID addressed to them | Claim early or redirect payout using note arguments |
| Attacker / malicious normal wallet sender | Create arbitrary notes, tags, attachments, and sponsorship notes; pay fees for their transactions | Forge the kernel-provided active-note sender or mutate vault state through an unallowlisted root |
| Malicious owner | Heartbeat repeatedly and deposit supported assets | Claim as beneficiary or rewrite Heirbeat state through the three feature procedures |
| Malicious beneficiary | Attempt early/repeated claim and consume beneficiary-bound payout | Claim before deadline, claim twice, or redirect the vault payout |
| Compromised owner key | Exercise owner authority, including repeated heartbeat and owner-authorized account configuration | Claim absent beneficiary authority |
| Compromised beneficiary key | Exercise beneficiary authority; after eligibility it can claim legitimately | Claim before eligibility or make the vault pay another account under current claim semantics |
| Compromised faucet signer | Mint under the faucet's configured policy and cause supply/accounting inflation | Change an already-configured Heirbeat faucet ID via a feature note |
| Malicious fee sponsor | Offer missing, mismatched, replayed, too-small, or excessive sponsorship | Change owner, beneficiary, timeout, claimed state, or inherited balance through sponsorship alone |
| Malicious target constructor | Attach a wrong/missing/malformed `NetworkAccountTarget` | Cause a different vault's authorization state to accept a note solely through the tag |
| NTX builder/operator | Discover, order, delay, censor, or execute eligible Network Account note pairs under service policy | Change verified contract authorization rules without a valid transaction/proof |
| Miden node | Serve public chain data, accept normal wallet transactions, and expose note/transaction status | Forge a valid transaction proof under the assumed protocol cryptography |
| Local CLI user | Select commands, config paths, RPC endpoint, and explicit mutation confirmation | Bypass on-chain checks by changing only local JSON |
| Compromised local machine | Read or use local keys and stores; alter CLI binary/config | Be treated as a trusted signer; host compromise defeats local key confidentiality |
| Future frontend/wallet integrator | Construct and submit user transactions | Treat display/config values as authorization or pass caller-controlled payout identity/amount |

## Trust boundaries and assumptions

1. **Contract boundary:** the vault component is installed in the account procedure index; check-in, claim, and deposit note scripts link the exact component implementation. Sender authorization uses `active_note::get_sender()`. The contract and note packages are trusted source/build artifacts. Package loading and procedure-root identity have been exercised locally.
2. **Network Account boundary:** standardized Network Account auth checks the note root allowlist and standard configuration/sponsorship paths. Owner-authorized configuration is powerful and can alter note/transaction-script roots. The CLI verifies exact hardened roots before feature-note construction and deployment completion. That is a client guard, not an on-chain immutable allowlist.
3. **NTX service boundary:** a valid public feature note needs the canonical target attachment; routing tags alone do not establish the target. The NTX service is required for liveness. Sponsorship pairing is by `feature_note_id`. Public-testnet operator discovery, ordering, liveness, and censorship are trusted operational assumptions.
4. **Wallet/client boundary:** wallet transactions are authenticated by keys held in the Miden keystore. P2ID consumption requires beneficiary account control and fee liquidity. Local JSON is public configuration only; the SQLite store and keystore are sensitive local state.
5. **Faucet boundary:** the configured inherited faucet controls issuance. A compromised or allow-all faucet signer can inflate test-asset supply. The native fee faucet funds transaction execution and is not the inherited asset.
6. **Workstation/Codespace boundary:** filesystem access, backups, malware, shell/process access, and loss of durable storage can disclose or destroy keys. Git ignore rules do not encrypt files.

### Assumptions

- Miden signature/hash/proof systems, account-state commitments, note nullifiers, and transaction execution are sound for the deployed protocol version.
- The public RPC's verified data and the configured endpoint refer to the intended Miden testnet. Public-testnet behavior is not a production guarantee.
- Contract packages and root constants are reviewed and built with the recorded toolchain; runtime and compiler dependency graphs remain intentionally version-pinned.
- Account keys remain secret and usable; local storage and the CLI binary are not compromised.
- The NTX builder/operator eventually processes valid, discoverable, sufficiently sponsored notes. This is a liveness assumption, not an authorization guarantee.
- The configured faucet is the complete supported inherited-asset set. There is no beneficiary rotation, owner recovery, partial allocation, or claim reversal.

### Attacker capabilities

Assume an attacker can create public notes, choose note metadata and attachments, submit wallet transactions for accounts they control, observe public chain state, delay their own submissions, replay already-seen identifiers, provide malformed inputs, and sponsor or withhold fees. Without key compromise, they cannot sign for owner, beneficiary, faucet, or vault authorities. They may exploit network-service delay/censorship and local operator mistakes. A compromised machine/key is analyzed separately because it crosses the signer boundary.

## Security invariants

| ID | Invariant |
|---|---|
| I1 | Only the configured owner may heartbeat. |
| I2 | Only the configured beneficiary may claim. |
| I3 | Claim succeeds only when reference block `>= last_check_in + timeout_blocks`. |
| I4 | A heartbeat cannot move `last_check_in` backwards. |
| I5 | `claimed` is terminal. |
| I6 | A claimed vault rejects heartbeat. |
| I7 | A claimed vault rejects every later claim. |
| I8 | Successful claim removes the full supported inherited balance. |
| I9 | The payout target is the stored beneficiary. |
| I10 | Payout amount is the full balance immediately before claim. |
| I11 | Caller input cannot select payout amount. |
| I12 | Caller input cannot select payout destination. |
| I13 | Only the configured faucet's fungible asset is accepted. |
| I14 | NFT/non-fungible deposits are rejected. |
| I15 | Native fee assets are not inherited assets. |
| I16 | Deposit does not change owner, beneficiary, timeout, claimed, or heartbeat. |
| I17 | Fee sponsorship does not change inheritance state. |
| I18 | An unallowlisted note root cannot dispatch a vault procedure. |
| I19 | A feature note's decoded `NetworkAccountTarget` must equal the intended vault. |
| I20 | Note metadata cannot forge the active sender exposed by the transaction context. |
| I21 | Claim state and asset/payout changes are transaction-atomic. |
| I22 | Failed output construction cannot persist `claimed=true` while stranding assets. |
| I23 | Failed claim cannot move assets. |
| I24 | Configuration updates do not silently broaden roots; exact hardened state is checked before use. |
| I25 | P2ID is absent from the vault's post-bootstrap input allowlist. |
| I26 | Public CLI config/JSON/lifecycle records contain no keys or seed material. |
| I27 | CLI reruns do not silently duplicate configured creation or terminal operations. |
| I28 | A committed note nullifier prevents second consumption/execution. |
| I29 | Deadline arithmetic widens validated u32 values to u64 and does not wrap. |
| I30 | A failed or missing `NetworkAccountTarget` cannot be treated as an NTX-discovered vault feature note. |
| I31 | The payout uses the canonical v0.16 P2ID script root and a single configured fungible asset. |
| I32 | CLI mutation preflight checks local owner/beneficiary/faucet against on-chain storage and requires a hardened allowlist. |

`timeout_blocks=0` mathematically makes the deadline equal `last_check_in`; the product CLI rejects zero timeout for newly created vaults. Contract arithmetic still uses widened values and exact inclusive-boundary comparison. The current vault has no separate trusted block input supplied by the caller.

## Attack surface and abuse cases

Severity: **CRITICAL** means direct unauthorized loss/theft or authorization bypass; **HIGH** means permanent lock, state corruption, or serious security-boundary failure; **MEDIUM** means griefing/fee denial/stranded value; **LOW** means recoverable or diagnostic issue; **INFO** means an explicit assumption or operational dependency. Status is assessed for current code after this sprint's CLI hardening.

| Attack ID | Attack | Preconditions | Target | Expected impact | Existing mitigation | Test coverage | Residual risk | Severity | Status |
|---|---|---|---|---|---|---|---|---|---|
| A01 | Owner key compromise | Owner key stolen while active | Freshness | Attacker can heartbeat indefinitely and delay claim | Sender check; no claim authority | `wrong_owner_cannot_check_in`, owner/terminal tests | No owner recovery/rotation | HIGH | OPEN |
| A02 | Beneficiary key compromise | Beneficiary key stolen | Payout | Attacker can claim after eligibility as the authorized beneficiary | Sender check and deadline | wrong claimant, spoof, claim boundary | Key custody is external | HIGH | ACCEPTED |
| A03 | Faucet key compromise | Faucet authority stolen | Asset supply | Unauthorized issuance under faucet policy | Vault pins one faucet ID; supply policy is faucet-defined | configured/unsupported faucet tests | Allow-all test faucet signer can inflate its asset | HIGH | ACCEPTED |
| A04 | Malformed deposit note | Attacker crafts wrong storage/assets/script args | Vault deposit | Rejection or attempted state/asset corruption | Script root, recipient validation, whole-note asset validation, atomicity | unsupported/mixed/NFT/recipient tests | Compiler/runtime defects remain possible | MEDIUM | MITIGATED |
| A05 | Malformed claim note | Attacker supplies malformed claim context | Claim | Early or redirected payout | Active sender, terminal/deadline/balance checks; fixed output fields | wrong claimant, early, payout tests | Package correctness remains trusted | CRITICAL | MITIGATED |
| A06 | Malformed heartbeat note | Invalid metadata/script/arguments | Freshness | Unauthorized freshness update | Allowlist, sender check, canonical script | wrong owner, spoof tests | Liveness can still be consumed by owner | HIGH | MITIGATED |
| A07 | Forged note sender | Sender metadata claims owner/beneficiary | Authorization | Unauthorized heartbeat/claim | Kernel active-note sender is authenticated context | attacker spoof tests | Key compromise bypasses identity assumption | CRITICAL | MITIGATED |
| A08 | Wrong target attachment | Note targets another account | NTX routing | Wrong account execution or intended vault not reached | Decode and compare target to configured vault | `security_target_rejects_wrong_and_unrelated_network_accounts` | Service-specific routing behavior | MEDIUM | MITIGATED |
| A09 | Missing target attachment | Feature note has only routing tag | NTX discovery | Note remains unprocessed | Required canonical attachment helper and pre-submit assertion | `security_target_rejects_missing_and_malformed_attachments`; live auto-exec evidence | Operator discovery/liveness | MEDIUM | MITIGATED |
| A10 | Mismatched sponsorship feature ID | Sponsor points at another note | Fee pairing | Feature execution fails or sponsor is stranded | `feature_note_id` validation | sponsorship-pair tests | Pairing/discovery service may delay | MEDIUM | MITIGATED |
| A11 | Excessive sponsorship grief | Sponsor offers excessive native amount | Fee reserve | Excess could be locked or consumed per standard fee behavior | Standard fee policy and feature pairing | No end-to-end excess-recovery test | Refund/reclaim behavior not established here | LOW | OPEN |
| A12 | Underfunded sponsorship | Sponsor amount below execution fee | NTX execution | Feature note fails/awaits fees | Fee sponsorship; bounded operator processing | live fee costs, helper validation | Exact fee schedule/service policy can change | MEDIUM | MITIGATED |
| A13 | Unsupported faucet deposit | Different faucet | Inherited assets | Unsupported value enters claim balance | Asset key checked against stored faucet before any addition | `other_faucet_and_nft_deposits_are_rejected_atomically` | Asset model/version bugs | CRITICAL | MITIGATED |
| A14 | NFT deposit | NFT or mixed note | Inherited assets | Unsupported asset confusion | Entire deposit asset list validated before additions | NFT and mixed-asset tests | Future asset-model changes need review | CRITICAL | MITIGATED |
| A15 | Multiple deposit aggregation | Several deposits before claim | Balance | Incorrect partial/full payout | Claim reads current vault balance, not caller amount | multi-deposit test | Only one faucet supported by design | LOW | MITIGATED |
| A16 | Early claim | Beneficiary claims before deadline | Claim | Premature transfer | Reference-block comparison | early claim and exact-boundary test | Depends on v0.16 context semantics | CRITICAL | MITIGATED |
| A17 | Exact-deadline edge | Claim at deadline boundary | Claim | Off-by-one premature or delayed claim | Inclusive `>=` comparison | exact deadline test | Reference block is not wall-clock time | MEDIUM | MITIGATED |
| A18 | Stale heartbeat race | Old ref block arrives after newer heartbeat | Freshness | Deadline moved backwards | Contract rejects `current < last_check_in` | stale-reference code; add explicit ordering coverage if future harness supports it | Same-block check-in does not extend beyond that block | MEDIUM | MITIGATED |
| A19 | Second claim | Two claim notes submitted | Claim exclusivity | Duplicate payout | Terminal claimed guard and nullifier | repeated claim and atomic two-claim tests | Transactions are ordered; second fails | CRITICAL | MITIGATED |
| A20 | Heartbeat after claim | Owner submits after terminal transition | Terminal state | Reactivated vault | Explicit claimed guard | terminal-state test | None known in current procedures | HIGH | MITIGATED |
| A21 | Deposit after claim | Any sender deposits after claim | Terminal state | Assets stranded in terminal vault | Explicit deposit claimed guard | post-claim deposit test | Note may remain unconsumed | MEDIUM | MITIGATED |
| A22 | Payout recipient substitution | Caller asks for attacker destination | Payout | Theft | Destination is stored beneficiary, not note args | payout recipient and attacker-consumption tests | Compromised beneficiary key remains authority | CRITICAL | MITIGATED |
| A23 | Payout amount manipulation | Caller supplies amount | Payout | Partial/overdrawn payout | Contract reads full active-account asset balance | full and multiple-deposit payout tests | Arithmetic/VM defect residual | CRITICAL | MITIGATED |
| A24 | P2ID root mismatch | Pinned root differs from stable standard | Payout | Payout unspendable or wrong script | Pinned root compared to canonical standards; live P2ID consumed | root equality and payout test | Version upgrade must re-verify | HIGH | MITIGATED |
| A25 | Config-note abuse | Config operation attempts root/state change | Authorization | Authorization surface changed | Standard owner/access-control component; config root is explicit | owner-only config-note test; beneficiary config note rejected | Recheck standard authority when changing component versions | HIGH | OPEN |
| A26 | Allowlist broadening | Extra note root inserted | Network auth | Unreviewed script dispatch | Exact set validator before mutation/finalization | security allowlist exact/extra-root tests | Owner-authorized config may intentionally broaden it | HIGH | MITIGATED |
| A27 | P2ID input acceptance | Bootstrap P2ID remains allowed | Network auth | Unintended input script accepted | Exact hardened validator forbids P2ID; finalization now rejects bootstrap state | security P2ID reintroduction test | Deployment cleanup is an operational step | HIGH | MITIGATED |
| A28 | Transaction replay | Reuse committed transaction | State transitions | Duplicate state mutation | Miden transaction/account nonce and chain commitments | MockChain transaction execution; Miden protocol semantics | Chain/protocol cryptography assumed | LOW | MITIGATED |
| A29 | Note replay | Consume same note twice | Note effects | Duplicate deposit/claim | Note nullifier uniqueness | deposit/claim/repeated note tests | Nullifier state is chain-enforced | CRITICAL | MITIGATED |
| A30 | Duplicate CLI submission | Retry mutating CLI command | Lifecycle | Duplicate notes/transactions | Pending-stage IDs, claimed guards, config duplicate protections, `--yes` | CLI safety tests and implementation review | Crash between submit and persistence can require reconciliation | MEDIUM | MITIGATED |
| A31 | Stale local state | CLI uses old account snapshot | Mutation | Invalid or misdirected transaction | Mutations sync first and compare stored account fields | live CLI/read-only smoke plus code path | Sync/RPC trust and races remain | MEDIUM | MITIGATED |
| A32 | Wrong durable config | Wrong owner/faucet/vault IDs configured | Mutation | Funds sent to wrong target | On-chain storage comparison in feature preflight; fixed testnet RPC check | config/state tests | `configure` is operator-controlled | HIGH | MITIGATED |
| A33 | Wrong RPC/network | Config points to another network | Mutation | Cross-network confusion/loss | CLI currently rejects endpoints other than public testnet endpoint | config loader and smoke test | Endpoint DNS/TLS/node trust | HIGH | MITIGATED |
| A34 | Keystore loss | Durable credential store lost | Wallet authority | Funds/authority inaccessible | Persistent ignored store and restart checks | restart/resync live evidence | No on-chain recovery mechanism | HIGH | ACCEPTED |
| A35 | Compromised local machine | Attacker reads keystore/process memory | All local authority | Key theft and forged user transactions | Filesystem isolation/secret separation only | No host compromise test | Requires OS/secret-management controls | CRITICAL | ACCEPTED |
| A36 | NTX liveness failure | Builder does not discover/execute | Deposit/heartbeat/claim | Delay or permanent inability to progress | Target attachment, sponsorship, polling | live NTX execution evidence | Operator availability | MEDIUM | ACCEPTED |
| A37 | NTX censorship | Operator withholds selected feature notes | Lifecycle liveness | Delayed heartbeat/claim/deposit | Public committed notes and explicit target | No censorship proof | No permissionless user-submit route on public testnet | HIGH | ACCEPTED |
| A38 | Node inconsistency | RPC serves stale/conflicting data | Client decisions | Incorrect status/preflight or denial | Verifying RPC client, sync and committed-state checks | testnet sync and restart tests | Availability/consistency are infrastructure trust | MEDIUM | ACCEPTED |
| A39 | Sponsorship denial of service | Sponsor absent or invalid pair | NTX processing | Feature note not processed | Sponsorship helper and bounded polling | pair validation; live sponsorship path | A malicious third party can withhold its own funds | MEDIUM | MITIGATED |
| A40 | Timeout arithmetic overflow | Large u32 state values | Eligibility | Claim becomes early due to wrap | Validate u32 and widen to u64 before sum | overflow and boundary tests | Felt storage integrity assumed | CRITICAL | MITIGATED |
| A41 | Procedure-root mismatch | Note invokes absent/different account procedure | Dispatch | Denial or wrong dispatch | Exact package linking and procedure-root checks | 17+ MockChain runtime tests and linkage diagnostic | Toolchain changes require rebuild/recheck | HIGH | MITIGATED |
| A42 | Dependency/version mismatch | Host/compiler protocol line diverges | Proof/runtime | Rejected package or changed semantics | Exact lockfiles, stable host graph, explicit RC SDK edge | cargo tree/compatibility tests | Future upgrades require compatibility review | HIGH | MITIGATED |
| A43 | Faucet supply/accounting mismatch | Faucet signer/policy issues extra units | Accounting | Misreported asset totals | On-chain faucet supply and balance checks | live faucet accounting evidence | Test faucet authority may allow unlimited mint within cap | MEDIUM | ACCEPTED |
| A44 | Stranded note | Wrong/missing target or no reclaim path | Asset availability | Value locked in committed note | Canonical attachment assertion; inspect before submission | malformed note historical case documented | No general recovery for already committed malformed notes established | MEDIUM | ACCEPTED |
| A45 | Beneficiary fee starvation | P2ID arrives, beneficiary lacks native fee | Payout consumption | Inherited asset remains in unconsumed note | Normal wallet fee funding and clear preflight | live P2ID consumption proof | Beneficiary must obtain fee liquidity | MEDIUM | ACCEPTED |
| A46 | Account replacement mistake | Owner/beneficiary ID in config is stale | Authority | Wrong signer or unreachable payout | Config-to-chain checks and signer checks | CLI validation tests/read-only verify | Human provisioning error | HIGH | MITIGATED |
| A47 | Config diverges from chain | Local metadata differs from deployed account | Operations | Incorrect status or transaction | Exact on-chain field/root checks before feature command | CLI validation and testnet verification | Public IDs in local record can still be stale | MEDIUM | MITIGATED |
| A48 | Claimed-state rollback | Attempt to restore active state | Terminal state | Repeat claim or reactivation | Vault procedures never clear claimed; chain state commitment | post-claim terminal tests | Owner config authority is separate; installed protocol exposes no reset | CRITICAL | MITIGATED |

### Race and ordering analysis

- **Heartbeat vs claim around deadline:** account transactions are applied in chain order. A heartbeat ordered first updates the stored reference block; the claim evaluated afterward uses that state and may become ineligible under the new deadline. A claim ordered first and eligible atomically claims/drains; the later heartbeat fails the terminal guard. MockChain tests the heartbeat extension then claim before/at the new deadline, but does not model adversarial NTX queue ordering on live testnet.
- **Two simultaneous claims:** only the first transaction can transition `claimed` from false to true and drain assets. Later execution reads the committed claimed state and fails; note nullifiers prevent reusing an already consumed note. The transaction builder does not create two valid state transitions against the same committed account state and both then commit.
- **Deposit vs claim:** order is authoritative. Deposit first contributes to the balance included by a later eligible claim. Claim first sets terminal state; subsequent deposit is rejected. An already committed deposit note may remain unconsumed if the network operator does not process it.
- **Config change vs feature note:** config and feature transactions use ordered account state. Current CLI checks a freshly synced exact allowlist before constructing, but another owner-authorized config transaction may be ordered before execution. Network Account authentication at execution is authoritative and rejects a newly unallowlisted script.
- **Duplicate sponsorship:** each sponsorship references one feature note ID and is itself a one-time note. A wrong or replayed sponsorship does not authorize a second feature execution. Exact refund/recovery behavior for overfunding is not established by current tests.

## Miden-specific trust assumptions

- Active note sender is provided by the transaction context and tested against forgery attempts; note metadata and account-target tags are not sender authentication.
- Note consumption is one-time through nullifier semantics. Transaction proofs and account state commitments are assumed valid under the stable v0.16 protocol.
- MockChain retains historical note records; depending on the path, a consumed-note replay is rejected by transaction execution or by block nullifier validation. Replay coverage checks that no second committed state transition occurs. MockChain's configured verification fee is zero, so it cannot establish real nonzero-fee underfunding thresholds; live sponsorship behavior is the evidence for fee collection.
- `NetworkAccountTarget` is a public attachment used by the NTX service to discover intended work; it is not a substitute for the vault's script allowlist or sender checks.
- Network Account configuration and fee-sponsorship scripts are standard v0.16 components and must remain installed/allowlisted. The config component is an owner governance path, not immutable policy.
- `NetworkAccountConfigNote` actions are authorized against the account-wide `Authority` component using the note sender; `AccessControl::Ownable2Step` makes the configured owner the authorized party in Heirbeat's deployment. Standard actions can add/remove note roots, transaction-script roots, and fee-policy roots, with updates applying to later account transactions. MockChain tests exercise unauthorized beneficiary rejection and owner removal/re-addition of P2ID, a Heirbeat root, and the expiration script; they also show the owner can remove the config/sponsorship roots themselves.
- Fee sponsorship funds Network Account transaction costs; it is separate from Heirbeat's configured inherited faucet. An ordinary wallet cannot rely on the Network Account sponsorship collection path for its own transaction fees.
- Public-testnet NTX service policy, RPC behavior, faucet availability, cadence, and censorship resistance are not protocol guarantees and may differ from mainnet/production.

### Version baseline reviewed

The local source/lockfile baseline is Miden toolchain `0.16.0` via midenup `1.0.1`, `cargo-miden` `0.10.0`, `midenc` `0.10.0`, and contract SDK `miden` `0.14.0`. `rust-toolchain.toml` declares `nightly-2026-09-01`; the active compiler observed for this review is `rustc 1.100.0-nightly (0dfb098f3 2026-08-31)`. The host graph pins `miden-client` and SQLite store `0.16.0`; `miden-protocol`, `miden-standards`, `miden-tx`, and `miden-testing` `0.16.1`; and the Miden VM/core family (`miden-core`, `miden-core-lib`, `miden-assembly`, `miden-assembly-syntax`, `miden-processor`, `miden-crypto`, `miden-mast-package`) `0.29.4`. CLI-relevant lockfile versions include `anyhow 1.0.104`, `rand 0.10.2`, `serde 1.0.229`, `serde_json 1.0.151`, and `tokio 1.53.1`; the CLI uses a small manual argument parser and adds no `clap` dependency. The SDK-side contract graph resolves `miden-protocol 0.16.0-rc.4` through `miden-base-macros 0.14.0`; it is not present in the host integration graph. This transitive SDK pin is kept as supplied by the official compiler toolchain and is not overridden.

## Operational risks and residual risks

- **Owner compromise can indefinitely postpone eligibility:** an attacker with the owner key can keep producing valid heartbeats while the vault is active. They still cannot claim or change the beneficiary through Heirbeat procedures. There is no owner rotation, emergency freeze, or recovery mechanism in this protocol version. This is an explicit high-severity governance/availability risk, not a hidden authorization bypass.
- **Beneficiary compromise is authority compromise:** before deadline, the key cannot claim; at or after deadline, the key holder can perform the intended claim. Payout remains bound to the beneficiary Account ID, but the attacker controlling its key can consume it. This is expected authority semantics.
- **Faucet key compromise:** a compromised allow-all test faucet signer can issue assets and corrupt supply expectations. It cannot change the vault's pinned faucet ID through deposit/claim.
- **Key loss or workstation compromise:** account keys are not recoverable by the CLI. Protect and back up the keystore using a separate secure process; a workspace directory and `.gitignore` are not encryption.
- **Liveness/censorship:** NTX builder/operator, public note discovery, and fee-faucet availability can delay or censor valid Network Account actions. User direct submission of a post-deployment Network Account transaction is not available on the tested public testnet.
- **Committed malformed notes:** a committed note with invalid/missing target attachment can remain stranded; no general post-commit attachment/recovery mechanism was proven. Inspect dry-run output before submission.
- **Payout fee liquidity:** the beneficiary may need native fee assets to consume a P2ID. The payout remains addressed to the beneficiary, but delivery into the account vault is delayed until a fee-paying transaction is possible.
- **Protocol immutability is limited:** owner-authorized NetworkAccountConfig updates can change the account's accepted roots or transaction scripts. The CLI detects deviation before its own mutations; it cannot prevent a valid owner from authorizing a different policy.

## Severity model

- **CRITICAL:** direct theft/loss of inherited assets, unauthorized claim, permanent authorization bypass, or payout to attacker.
- **HIGH:** permanent vault lock, claim-state corruption, allowlist bypass, replay causing a duplicated state change, or serious authority compromise.
- **MEDIUM:** griefing requiring user recovery, fee denial, stale-state-induced failures, NTX liveness/censorship, or stranded notes without theft.
- **LOW:** poor diagnostics, harmless duplicate attempts, or recoverable operational errors.
- **INFO:** documented trust assumptions, UX limits, and infrastructure dependencies.

Severity describes impact under the stated preconditions; key compromise and operator censorship are not represented as contract exploits.

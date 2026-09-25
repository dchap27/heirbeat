# Heirbeat

Heirbeat implements a PUBLIC Miden Network Account with owner-authorized heartbeats, beneficiary inactivity claims, and fungible-asset custody. An eligible claim pays the **entire supported balance** to the configured beneficiary through a standard P2ID note. MockChain regressions and a complete public-testnet lifecycle have been exercised; privacy, messages, and frontend remain future milestones.

## Public Testnet Status

The live lifecycle completed on the Miden v0.16 public testnet (`https://rpc.testnet.miden.io`) using the NTX builder's automatic execution path. The Heirbeat Network Account `0x39fcc854fe715ad1446afb9859df04` holds state for owner `0xa61714a99ec7619109e397cbac32cd` and beneficiary `0x4181277bcf64381105ee61baadb5bc`; inherited faucet `0x4020542183b9643120d0192be38793` is HBTESTV. A 100-unit deposit was followed by heartbeat at reference block `450117`, eligibility at block `450127`, beneficiary claim, full-balance P2ID payout, and beneficiary consumption.

Public evidence: deposit funding transaction `0xcc74cf283012db4bcb2d2c8a51ca65aa98799b95fe2cb933d060c30730f5fa9c`, deposit note `0x6c55c4c1ee74b846a1cb468b2d1cc37790ed8cc4c189d29a7b8600c72eb74beb`; heartbeat funding transaction `0xc8f5ac51141b85884bde037ab6e82fc126b081b91ea9f98045fcfd2d34893bdf`, note `0x92da7ad5fad0defb64bf847dc49f7320b443bbcbeb1d4f71a9fadc318254f680`; claim funding transaction `0x63c579af38e75eaa466bf38437d724b370a18a3396564d6f6e3c52ad8627fb68`, claim note `0x9a432906999582825c1e15d69f53312a6f8e84c8787bb26029ffcba850cc852d`, vault claim transaction `0xd3fac87bb0cbce14fd4d09d08425d3e34173f629571f21b043f35c765041c478`; payout note `0xf5d28de2a49084c4d7126b3701e0024fc4747d0b5e63ef79e05cc8e6385294e0`, consumed by transaction `0xdc525ae744a532051ca3fefe78a348db875347d3cf2d57204c6929917bac86eb`. Final HBTESTV accounting is owner `10` + beneficiary `100` + vault `0` + the untouched malformed committed note `100` = faucet supply `210`. This is an early testnet protocol run, not a production deployment. No secrets are included.

## State and custody

Six named value slots under `heirbeat_vault::heirbeat_vault`:

| Slot | Encoding | Initial value |
| --- | --- | --- |
| `owner` | AccountId word `[0, 0, suffix, prefix]` | Configured owner |
| `beneficiary` | Same AccountId encoding | Configured beneficiary |
| `asset_faucet` | Same AccountId encoding | One configured fungible faucet |
| `last_check_in` | Felt in `[value, 0, 0, 0]` | `0` by default |
| `timeout_blocks` | Felt containing a validated `u32` | Configured timeout |
| `claimed` | Felt: `0` false, `1` true | `0` |

Assets reside in Miden's native account vault, separately from component storage. Only the configured faucet's fungible asset **with callbacks disabled** is supported. Other faucets, callback-enabled assets, and NFTs are rejected by exact asset-key comparison. There is no inheritance amount or percentage allocation.

`check_in()` requires `claimed == 0` and `active_note::get_sender()` equal to the stored owner. It records `tx::get_block_number()` and rejects older reference heights.

`deadline = last_check_in + timeout_blocks`. Eligibility is derived, never stored. The block API means the **transaction reference block**, not the later commitment block. Both deadline operands are validated as `u32` and widened to `u64` before addition; the maximum sum is `8_589_934_590`, without wrapping. Initialization to zero remains temporary pending finalized vault-creation semantics.

`deposit()` requires an unclaimed vault and a nonempty note containing only the supported asset key. It adds assets without changing any protocol storage or counting as a heartbeat. Anyone can fund the vault. The deposit note enforces its committed recipient ID; an account-target tag alone is insufficient authorization.

`claim()` requires the active note sender to equal the stored beneficiary, `claimed == 0`, reference block `>= deadline`, and a nonzero supported balance. It sets `claimed = 1`, removes the full balance, and creates one public standard P2ID note bound to the stored beneficiary. Amount and destination are not caller arguments. The payout uses the claim note's serial number and canonical beneficiary tag. Failed execution commits neither state nor asset changes.

CLAIMED is terminal: further claims, heartbeats, and deposits fail. A zero-balance claim fails without closing the vault. Rejected deposit notes remain unconsumed; rejection does not undo the sender's already-committed note creation or provide a refund path. There are no owner/beneficiary updates.

## Notes and authorization

The vault uses `AccountType::Public` and `AuthNetworkAccount::with_allowed_notes` containing the three Heirbeat roots: `check-in-note`, `claim-note`, and `deposit-note`. The live v0.16 Network Account additionally retains the required `NetworkAccountConfig` and `FeeSponsorship` roots; its P2ID input root is absent. Its transaction-script allowlist contains only the canonical expiration root. Payout P2ID notes are consumed by the beneficiary wallet, not by the vault.

Check-in and claim notes carry no assets or storage arguments. Deposit notes carry assets and two recipient Felts `[suffix, prefix]`. Each invokes its corresponding compiled vault procedure through FPI.

Notes originate in signature-authenticated wallet transactions and are committed before consumption. Forged host sender metadata is constructible, but `AccountInterface::build_send_notes_script` rejects it with `InvalidSenderAccount`. Bypassing that guard still emits the attacker's actual ID: kernel output-note metadata derives sender from `account::get_id`. Both owner and beneficiary spoofing paths are tested.

The contract pins the canonical `miden-standards 0.16.1` P2ID script root in `contracts/heirbeat-vault/src/p2id.rs`; integration tests verify it against the standard library. Inspect/regenerate the constant with `cargo run -p integration --example p2id_root`. The transaction host resolves the standard payout script without expected-output-note hints.

## Build and verification

Use the Miden v0.16.0 toolchain binaries on `PATH`. Build from each contract directory because cargo-miden's top-level artifact path is relative to its working directory.

```bash
export PATH="$HOME/.local/share/midenup/toolchains/0.16.0/bin:$PATH"
(cd contracts/heirbeat-vault && cargo miden build --release)
(cd contracts/check-in-note && cargo miden build --release)
(cd contracts/claim-note && cargo miden build --release)
(cd contracts/deposit-note && cargo miden build --release)
cargo fmt --all -- --check
cargo test --workspace -- --nocapture
```

## Testnet lifecycle CLI

The `integration` binary operates on the Miden v0.16 public testnet and stores
non-secret settings and public transaction evidence in
`.local/testnet-v016/heirbeat.json`. Account signing keys remain in the Miden
keystore under `.local/testnet-v016/.miden/keystore`; this directory is ignored
by Git. Import/track the owner and beneficiary accounts and ensure the owner
has native fee liquidity before using mutating commands, then configure their
public IDs:

```bash
cargo run -p integration --bin testnet_lifecycle -- configure \
  --owner <OWNER_ID> --beneficiary <BENEFICIARY_ID>
cargo run -p integration --bin testnet_lifecycle -- status --json
cargo run -p integration --bin testnet_lifecycle -- create-faucet --yes
cargo run -p integration --bin testnet_lifecycle -- deploy-vault --timeout 10 --yes
cargo run -p integration --bin testnet_lifecycle -- mint --amount 100 --yes
cargo run -p integration --bin testnet_lifecycle -- deposit --amount 100 --yes
cargo run -p integration --bin testnet_lifecycle -- heartbeat --yes
cargo run -p integration --bin testnet_lifecycle -- status
cargo run -p integration --bin testnet_lifecycle -- claim --yes
cargo run -p integration --bin testnet_lifecycle -- consume --yes
cargo run -p integration --bin testnet_lifecycle -- verify
```

Live mutations require `--yes`; `deposit`, `heartbeat`, and `claim` also accept
`--dry-run` to build and validate the notes and target attachment without
submitting. Polling is bounded and configurable with `--poll-seconds` and
`--timeout-seconds`. The CLI never submits a Network Account transaction: it
submits the normal wallet transaction with the feature note and paired fee
sponsorship, then waits for NTX-builder execution. Use `fund-fees` for normal
wallet P2ID fee funding and sponsorship only for Network Account execution.

Each artifact is `contracts/<package>/target/miden/release/<package>.masp`. Tests load packages using `Package::read_from_bytes`, attach the component through `AccountComponent::from_package` with named initialization data, and extract scripts with `NoteScript::from_package`. Account dependencies remain in Miden project/WIT metadata, without a normal Rust account path dependency. Claim/deposit builds here reuse the check-in-note Rust cache through `CARGO_TARGET_DIR`; MASP output remains at each package's path above.

Runtime coverage includes:

- Single deposit: vault `0 → 100 → 0`, beneficiary `0 → 100`; both deposit and payout consumed.
- Deposits of `40 + 60` from different wallets pay the complete `100`.
- Exact-deadline claims, repeated heartbeats, deadline extension `6 → 9`, and u32 overflow boundaries.
- Early, wrong-claimant, owner, zero-balance, and repeated claims; terminal heartbeat/deposit rejection.
- Sender spoofing, strict allowlist, incorrect deposit recipient, other faucet, and NFT rejection.
- Atomic rollback when payout creation encounters malformed script advice and when a second claim aborts a transaction after its first payout was created. Retrying the valid claim succeeds.

MockChain executes real transaction code with dummy proofs for block application. Tests use deterministic assets seeded into initial wallets, not a live faucet deployment. They reload committed account state, verify balances and commitments, inspect exact payout recipients/assets, and check consumption. An attacker cannot consume the beneficiary's P2ID payout.

## Versions and limitations

Miden channel `0.16.0`; contract SDK `miden 0.14.0`; cargo-miden/midenc `0.10.0`; client/sqlite-store `0.16.0`; protocol/standards/tx/testing `0.16.1`; VM `0.29.4`. Contract SDK build dependencies retain their official SDK-resolved RC protocol transitive dependency, isolated from the stable host/runtime graph. MockChain regression coverage remains enabled alongside the live testnet evidence above.

Rust assertions lower to the VM's generic `entered unreachable code` error. Negative tests therefore use otherwise-valid funded fixtures and verify unchanged committed state, rather than treating that error alone as proof of a specific failed condition. Existing wide-arithmetic and MAST HASHLESS/STRIPPED build diagnostics are nonfatal. No upstream runtime blocker is known; production proving and network scheduling remain unverified.

# Heirbeat

Heirbeat implements a PUBLIC Miden Network Account with owner-authorized heartbeats, beneficiary inactivity claims, and fungible-asset custody. An eligible claim pays the **entire supported balance** to the configured beneficiary through a standard P2ID note. Runtime behavior is tested in MockChain; privacy, messages, frontend, production proofs, and public testnet deployment remain future milestones.

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

The vault uses `AccountType::Public` and `AuthNetworkAccount::with_allowed_notes` containing **exactly** `check-in-note`, `claim-note`, and `deposit-note` script roots. `NetworkAccount::new` and decoded allowlists are checked. The transaction-script allowlist is empty. Payout P2ID notes are consumed by the beneficiary wallet, not by the vault.

Check-in and claim notes carry no assets or storage arguments. Deposit notes carry assets and two recipient Felts `[suffix, prefix]`. Each invokes its corresponding compiled vault procedure through FPI.

Notes originate in signature-authenticated wallet transactions and are committed before consumption. Forged host sender metadata is constructible, but `AccountInterface::build_send_notes_script` rejects it with `InvalidSenderAccount`. Bypassing that guard still emits the attacker's actual ID: kernel output-note metadata derives sender from `account::get_id`. Both owner and beneficiary spoofing paths are tested.

The contract pins the canonical `miden-standards 0.15.3` P2ID script root in `contracts/heirbeat-vault/src/p2id.rs`; integration tests verify it against the standard library. Inspect/regenerate the constant with `cargo run -p integration --example p2id_root`. The transaction host resolves the standard payout script without expected-output-note hints.

## Build and verification

Use the v0.15 toolchain binaries on `PATH`. Build from each contract directory because cargo-miden's top-level artifact path is relative to its working directory.

```bash
export PATH="$HOME/.local/share/midenup/toolchains/0.15.0/bin:$PATH"
(cd contracts/heirbeat-vault && cargo miden build --release)
(cd contracts/check-in-note && cargo miden build --release)
(cd contracts/claim-note && cargo miden build --release)
(cd contracts/deposit-note && cargo miden build --release)
cargo fmt --all -- --check
cargo test --workspace -- --nocapture
```

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

Rust `nightly-2026-04-30`; Miden channel `0.15.0`; contract SDK `miden 0.13.1`; protocol/standards/tx/testing `0.15.3`; client/sqlite-store `0.15.2`; MAST package `0.23.4`; resolved VM crates `0.23.5`. Integration retains `cargo-miden 0.9.0` with resolved compiler dependencies `0.9.2`. No v0.16 upgrade.

Rust assertions lower to the VM's generic `entered unreachable code` error. Negative tests therefore use otherwise-valid funded fixtures and verify unchanged committed state, rather than treating that error alone as proof of a specific failed condition. Existing wide-arithmetic and MAST HASHLESS/STRIPPED build diagnostics are nonfatal. No upstream runtime blocker is known; production proving and network scheduling remain unverified.

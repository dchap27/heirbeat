# Heirbeat

Heirbeat's PUBLIC Miden Network Account architecture and owner-authorized heartbeat are proven in MockChain. This milestone adds beneficiary claim eligibility and a terminal claimed state. **No assets are deposited, moved, or paid out.** The project remains MockChain-only; production proofs, node scheduling, and public testnet deployment come later.

## State and rules

Five named value slots under `heirbeat_vault::heirbeat_vault`:

| Slot | Encoding | Initial value |
| --- | --- | --- |
| `owner` | SDK AccountId word `[0, 0, suffix, prefix]` | Configured owner |
| `beneficiary` | Same AccountId encoding | Configured beneficiary |
| `last_check_in` | Felt in `[value, 0, 0, 0]` | `0` by default |
| `timeout_blocks` | Felt containing a configured `u32` | Configured timeout |
| `claimed` | Felt in `[value, 0, 0, 0]`: `0` false, `1` true | `0` |

`deadline = last_check_in + timeout_blocks`. Eligibility is derived, never stored:

```text
ACTIVE -- reference block >= deadline --> ELIGIBLE -- beneficiary claim --> CLAIMED
```

`check_in()` requires `claimed == 0` and `active_note::get_sender()` equal to the stored owner. It records `tx::get_block_number()` and rejects older reference heights. Before a claim, a heartbeat can extend the deadline and restore ACTIVE status.

`claim()` requires the active note sender to equal the stored beneficiary, `claimed == 0`, and `tx::get_block_number() >= deadline`. It sets only `claimed = 1`; beneficiary and heartbeat state remain unchanged. CLAIMED is terminal: both subsequent claims and owner heartbeats fail. There are no owner/beneficiary update procedures or payout notes.

The block API returns the **transaction reference block**, not the later account-state commitment block. The contract validates both deadline operands as `u32`, then adds their canonical values as `u64`. The integration accessor uses the same bounds and widening. Maximum sum: `8_589_934_590`; a deadline above `u32::MAX` remains unreachable by a u32 reference block rather than wrapping. Default heartbeat initialization to zero remains temporary pending finalized vault-creation semantics.

## Notes and sender binding

`check-in-note` invokes `check_in()`; `claim-note` invokes `claim()`. Both carry no assets or note-storage arguments. Tests construct public notes with an account-target tag; this is routing metadata, not an additional recipient check in either contract.

The vault uses `AccountType::Public` and `AuthNetworkAccount::with_allowed_notes` containing exactly those two script roots. `NetworkAccount::new` and the decoded allowlists are checked. The transaction-script allowlist is empty; wallet send scripts execute only on the sending wallets.

Owner, beneficiary, and attacker notes are produced by signature-authenticated wallet transactions and committed before consumption. Forged host metadata is constructible, but `AccountInterface::build_send_notes_script` rejects it with `InvalidSenderAccount`. Tests also bypass this host guard: an owner/beneficiary-built script executed by the attacker emits the attacker's actual ID because the kernel's `output_note::build_metadata` reads `account::get_id`. The forged note is never committed, and the actual attacker claim is rejected even when eligible. Fixture injection or unauthenticated-note simulation is not treated as sender-authenticity evidence.

## Build and verification

Use the v0.15 toolchain binaries on `PATH`. Run builds from each contract directory because cargo-miden's top-level artifact path is relative to its working directory.

```bash
export PATH="$HOME/.local/share/midenup/toolchains/0.15.0/bin:$PATH"
(cd contracts/heirbeat-vault && cargo miden build --release)
(cd contracts/check-in-note && cargo miden build --release)
(cd contracts/claim-note && cargo miden build --release)
cargo fmt --all -- --check
cargo test --workspace -- --nocapture
```

Artifacts are respectively `contracts/{heirbeat-vault,check-in-note,claim-note}/target/miden/release/{package-name}.masp`. Tests use `Package::read_from_bytes`, `AccountComponent::from_package` with named initialization data, and `NoteScript::from_package`. FPI dependencies remain in Miden project/WIT metadata, without a Rust account path dependency. The claim-note build in this environment reused the check-in-note Rust cache via `CARGO_TARGET_DIR`; its MASP still resides at the claim-note path above.

Nine runtime tests pass, none ignored:

- Heartbeats persist at blocks `1` and `5`; deadline moves `100 → 101 → 105`.
- Claim fails at reference block `5`, succeeds exactly at deadline `6`, persists at block `7`, and consumes the note.
- Repeated claim and post-claim owner heartbeat fail without changing any account state.
- Attacker and owner claims fail when eligible; failed notes remain unconsumed.
- Heartbeat at `3` extends deadline `6 → 9`; claim fails at `7` and succeeds at `9`.
- Deadline `1 + u32::MAX = 4_294_967_296` does not wrap into eligibility.
- Owner/beneficiary sender spoofing and arbitrary note roots cannot authorize vault mutation.

MockChain uses the real transaction executor with dummy proofs for block application. Tests reload committed state, compare execution/account commitments, verify note consumption, and check that successful claims neither change asset custody nor produce output notes.

## Versions and limitations

Rust `nightly-2026-04-30`; Miden channel `0.15.0`; contract SDK `miden 0.13.1`; protocol/standards/tx/testing `0.15.3`; client/sqlite-store `0.15.2`; MAST package `0.23.4`; resolved VM crates `0.23.5`. Integration retains `cargo-miden 0.9.0` with resolved compiler dependencies `0.9.2`. No v0.16 upgrade.

Rust assertion messages lower to the VM's generic `entered unreachable code` assertion, so negative tests check that error plus unchanged committed state; the error alone does not identify the failed contract condition. Existing `wide-arithmetic` and MAST HASHLESS/STRIPPED build diagnostics remain nonfatal. No new runtime blocker was observed.

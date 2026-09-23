# Heirbeat

Heirbeat's Miden PUBLIC Network Account architecture is proven in MockChain. The current milestone implements owner-authorized heartbeat state through a compiled vault component and a minimal check-in note. Inheritance claims, deposits, payouts, beneficiaries, and public testnet deployment are not implemented; testnet comes later.

```text
owner wallet -- creates CheckInNote --> HeirbeatVault Network Account
```

## State and authorization

The `heirbeat-vault` component has three named value slots under `heirbeat_vault::heirbeat_vault`:

| Slot | Encoding | Initial value |
| --- | --- | --- |
| `owner` | SDK AccountId word `[0, 0, suffix, prefix]` | Configured owner wallet ID |
| `last_check_in` | Felt in `[value, 0, 0, 0]` | `0` |
| `timeout_blocks` | Felt in `[value, 0, 0, 0]`, configured as `u32` | `100` in tests |

Zero initialization of `last_check_in` is temporary until vault creation semantics are finalized. Tests seed the vault into MockChain genesis using `build_existing()`. The owner and timeout have no update procedure in this milestone.

`check_in()` reads `active_note::get_sender()` and compares both account-ID elements with stored `owner`. It then reads `tx::get_block_number()`, rejects a reference block older than the stored heartbeat, and updates `last_check_in`. Neither owner identity nor height is accepted as an argument. Read-only getters expose the heartbeat and timeout.

The block API returns the **transaction reference block**, not the block committing the resulting account state. Tests send and commit each note through a signature-authenticated owner wallet, execute it against the vault at the latest reference block, apply another block, and reload committed vault state.

`check-in-note` calls only `check_in()`, carries no assets or note-storage arguments, and uses an account-target tag. The tag routes the note; it is not an additional recipient check in the contract. The vault uses `AccountType::Public` and `AuthNetworkAccount::with_allowed_notes` with exactly this note's script root. `NetworkAccount::new` verifies recognition. The transaction-script allowlist stays empty; wallet send scripts run on the sending wallets, never on the vault.

The integration accessor derives `deadline = last_check_in + timeout_blocks`, without storing it. It validates both stored scalar values as `u32`, then widens to `u64` before addition. The maximum deadline is `2 * u32::MAX = 8_589_934_590`, so neither u32 nor Felt wraparound occurs. There is no on-chain deadline/claim procedure yet.

## Sender authenticity

Tests do not inject heartbeat notes into MockChain genesis. They execute signed wallet transactions and commit their output notes before vault consumption.

Untrusted host code can construct a `Note` claiming any sender. The spoofing test proves two enforcement points:

1. `AccountInterface::build_send_notes_script` for the attacker rejects owner-labelled metadata with `AccountInterfaceError::InvalidSenderAccount(owner)`.
2. Bypassing that host check by building the script for the owner but executing it as the attacker still emits the **attacker** as sender. The transaction kernel's `output_note::build_metadata` obtains the ID with `account::get_id`; it does not accept a caller-supplied sender. The resulting note ID differs from the forgery, which is never committed.

MockChain fixture injection and unauthenticated-note simulation must not be treated as proof of note provenance. The tests establish sender binding through the real executor and authenticated committed-note path. MockChain applies dummy proofs; production proof generation and node scheduling remain outside this milestone.

## Build and tests

Use the installed v0.15 toolchain binaries on `PATH`. Build from each contract directory: this cargo-miden CLI chooses the output directory relative to its working directory, even with `--manifest-path`.

```bash
export PATH="$HOME/.local/share/midenup/toolchains/0.15.0/bin:$PATH"
(cd contracts/heirbeat-vault && cargo miden build --release)
(cd contracts/check-in-note && cargo miden build --release)
cargo fmt --all -- --check
cargo test --workspace -- --nocapture
```

Artifacts:

- `contracts/heirbeat-vault/target/miden/release/heirbeat-vault.masp`
- `contracts/check-in-note/target/miden/release/check-in-note.masp`

Integration tests load these using `Package::read_from_bytes`, attach the component using `AccountComponent::from_package` with named initialization data, and extract the note using `NoteScript::from_package`. The account dependency uses Miden project/WIT metadata, not a normal Rust path dependency.

Runtime results: four tests, none ignored. First and second heartbeats are exactly `0 → 1 → 5`; derived deadlines are `100 → 101 → 105`. Wrong-owner execution fails without mutation or consumption; an unallowlisted note rejects the whole transaction, including a valid check-in. Sender spoofing is rejected/bound as described above.

## Versions and tooling limits

- Rust: `nightly-2026-04-30`; Miden toolchain channel: `0.15.0`.
- Contract SDK: `miden 0.13.1`.
- Protocol, standards, transaction and testing crates: `0.15.3`.
- Client/sqlite-store: `0.15.2`; MAST package: `0.23.4`; resolved VM crates: `0.23.5`.
- Integration build-helper dependency: `cargo-miden 0.9.0`, resolved compiler dependencies `0.9.2`.

The SDK's void-only component interface triggered `#[account]` with `no entry found for key`. The final interface includes useful Felt-returning state getters and builds successfully. Rust assertion messages currently lower to the VM's `entered unreachable code` assertion; the wrong-owner test checks that exact VM error. The build also emits `wide-arithmetic` and MAST HASHLESS/STRIPPED diagnostics while exiting successfully and producing executable packages. No v0.16 upgrade was made.

# Heirbeat

Heirbeat is intended to become a programmable digital-inheritance / dead-man-switch protocol native to Miden. This repository currently contains only a technical viability probe; it does not implement heartbeat/inheritance policy, beneficiaries, deposits, encryption, or production protocol abstractions.

## Runtime probe: PROVEN

The supplied compiled `touch-note` executes against a PUBLIC Network Account containing the compiled `probe-account` component in v0.15.3 MockChain. After the executed transaction is added and a block applied, the account is reloaded from committed chain state and `last_seen` has changed from `0` to exactly `1` (storage word `[0, 0, 0, 0]` → `[1, 0, 0, 0]`). The committed account commitment matches the execution result, and the note is consumed.

`integration/tests/probe_flow.rs` contains three executable, non-ignored tests:

- `compiled_packages_load`: deserializes both supplied release packages, reporting each loading error independently.
- `network_account_touch_flow`: constructs the account, verifies Network Account recognition and allowlists, executes an authenticated committed note, applies a block, and checks persistent account state and note consumption.
- `network_account_rejects_unallowlisted_note`: attempts a transaction containing the real mutating touch-note and another valid custom note with a different root. It requires `ERR_NOTE_SCRIPT_ALLOWLIST_NOTE_NOT_ALLOWED`, then applies an empty block and checks that the entire account remains unchanged and neither note was consumed.

All three passed on 2026-09-21: **3 passed, 0 failed, 0 ignored**. Formatting also passed. No upstream blocker was observed.

## Package loading and account setup

The tests read these existing artifacts relative to `CARGO_MANIFEST_DIR`; they do not rebuild or replace either contract:

- `contracts/probe-account/target/miden/release/probe-account.masp`
- `contracts/touch-note/target/miden/release/touch-note.masp`

`Package::read_from_bytes` loads each MASP. `AccountComponentMetadata::try_from` extracts the account storage schema, and `InitStorageData` initializes its single `last_seen` slot to zero. `AccountComponent::from_package` supplies the compiled component to `AccountBuilder::with_component`. `NoteScript::from_package` extracts the note script using its package metadata.

The builder uses `AccountType::Public` and `with_auth_component(AuthNetworkAccount::with_allowed_notes(BTreeSet::from([script.root()]))?)`. `build_existing()` seeds the account into MockChain genesis, following the upstream network-auth test pattern. There is no signature auth or reimplemented account component.

`NetworkAccount::new(account)` verifies recognition through public account type and the standardized note-allowlist storage slot. Tests assert that its decoded allowlist contains exactly the touch-note root. `NetworkAccountTxScriptAllowlist` is also decoded and asserted empty. No transaction script is needed, allowed, or executed. These APIs follow the [official v0.15 migration guidance](https://github.com/0xMiden/docs/issues/312).

The public note carries `NoteTag::with_account_target(account.id())`. It is committed to MockChain and passed by note ID to `build_tx_context(...).build()?.execute().await`. The executor runs the custom note's FPI call into the compiled account component. `add_pending_executed_transaction` followed by `prove_next_block` applies the result; `committed_account` reloads it. MockChain uses dummy proofs: this proves runtime execution and mock-chain persistence, not production proof generation, node scheduling, or testnet deployment. The target tag is routing metadata, not an added recipient check in the contract.

## Exact tested crate versions

| Crate | Version |
| --- | --- |
| `integration` | `0.1.0` |
| `miden-protocol`, `miden-standards`, `miden-tx`, `miden-testing` | `0.15.3` |
| `miden-client`, `miden-client-sqlite-store` | `0.15.2` |
| `miden-mast-package` | `0.23.4` |
| `miden-core`, `miden-assembly`, `miden-processor` (resolved VM crates) | `0.23.5` |
| `cargo-miden` (optional build helper, unused by runtime tests) | `0.9.0` |
| `midenc-*` (resolved compiler dependencies) | `0.9.2` |
| Rust contract SDK `miden` (contract lockfiles) | `0.13.1` |
| `tokio` | `1.53.1` |

Rust is pinned to `nightly-2026-04-30`. No v0.16 dependencies were introduced. The supplied MASPs contain dependency labels for `miden-core 0.22.3` and `miden-protocol 0.14.0`; despite those labels, both load and the above execution passes with the listed v0.15 runtime. This result is specifically for these artifacts:

```text
449511738b109cd45e104375a986022715abd59a50bbd6dac18dd493f40d14e6  probe-account.masp
3eccaa67be0c8171f8c2effc190a7db088be52b979f3b0d4eafb7ed43ecf5435  touch-note.masp
```

## Commands

Run the existing compiled artifacts:

```bash
cargo fmt --all -- --check
cargo test -p integration --test probe_flow -- --nocapture
```

The first dependency download required network access outside the sandbox after crates.io DNS resolution failed. The initial `cargo test -p integration --test probe_flow --no-run` exposed the v0.15 `to_commitment()` method name; the harness was corrected and the executable command above passed.

To rebuild contracts separately, if needed:

```bash
cargo miden build --release --manifest-path contracts/probe-account/Cargo.toml
cargo miden build --release --manifest-path contracts/touch-note/Cargo.toml
```

The note must not have a normal Rust path dependency on `probe-account`; the account dependency is declared through Miden project/WIT metadata. The earlier `expected only one Wasm artifact` compiler panic was fixed by removing that normal Rust dependency. No contract builds, commits, pushes, or testnet submissions were performed for this runtime probe.

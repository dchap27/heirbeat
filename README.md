# Heirbeat

Heirbeat is intended to become a programmable digital-inheritance / dead-man-switch protocol native to Miden. This repository currently contains only a technical viability probe; it does not implement inheritance, beneficiaries, deposits, encryption, or production protocol abstractions.

## Probe scope

The probe defines:

- `probe-account`: a custom account component with persistent `last_seen` storage, `touch()`, and `get_last_seen()`.
- `touch-note`: a custom note whose only state-changing operation is an FPI call to `probe-account::Probe::touch()`.
- `integration`: the build helper and the planned MockChain end-to-end test boundary.

The intended test flow is a PUBLIC account with `AuthNetworkAccount` and only the `touch-note` root allowlisted. The full test is intentionally ignored until the note package links: a note-to-component linkage failure makes Network Account execution untestable and must be reported as a toolchain issue.

## Selected v0.15 toolchain

The official v0.15 tutorial/template selects this coherent combination:

| Layer | Version |
| --- | --- |
| `midenup` / Miden CLI | `0.1.0` / porcelain active toolchain `0.15.0` |
| Miden protocol/testnet | v0.15 (protocol crates resolve to 0.15.x; tutorial pins 0.15.3-compatible APIs) |
| Miden VM / assembly | 0.23.4 (VM line 0.23) |
| Rust contract SDK crate | `miden = 0.13` |
| Compiler / `cargo-miden` | `cargo-miden = 0.9.0` (compiler release line v0.9) |
| Rust toolchain | `nightly-2026-04-30`, rustc 1.97.0-nightly, target `wasm32-wasip2` |
| Rust client | `miden-client = 0.15.2`, sqlite store `0.15.2` |
| Standards | `miden-standards = 0.15.3` |
| Transaction/testing crates | `miden-tx = 0.15.3`, `miden-testing = 0.15.3` |
| MAST package / crypto | `miden-mast-package = 0.23.4`, `miden-crypto = 0.25.1` (transitive) |

Before implementation, the installed environment was recorded as:

```text
midenup: not installed
miden CLI: not installed
cargo-miden: not installed
midenc: not installed
rustc: 1.88.0 (6b00bc388 2025-06-23)
cargo: 1.88.0 (873a06493 2025-05-10)
rustup: stable-x86_64-unknown-linux-gnu only
```

The selected `rust-toolchain.toml` is checked into this repository. The first installation attempt used the read-only default Rustup home and did not complete. Installing `cargo-miden 0.9.0` under the pre-existing Rust 1.88 toolchain failed with:

```text
error: cannot install package `cargo-miden 0.9.0`, it requires rustc 1.97 or newer, while the currently active rustc version is 1.88.0
```

On the follow-up attempt, the exact nightly was installed successfully in the writable temporary Rustup home `/tmp/heirbeat-rustup`:

```text
rustc 1.97.0-nightly (c935696dd 2026-04-29)
cargo 1.97.0-nightly (eb9b60f1f 2026-04-24)
```

The normal Rustup home is read-only in this environment, so using the temporary home is required. GitHub access works (`git ls-remote` succeeds), and rustup's static download host works. crates.io remains unavailable: `curl https://index.crates.io/config.json` cannot connect, and Cargo fails downloading `https://static.crates.io/crates/cargo-miden/0.9.0/download` with `Could not connect to server`.

## Commands

With the pinned nightly and Miden v0.15 toolchain installed:

```bash
midenup init
midenup install 0.15.0

# Build the account first so its generated WIT is available to the note.
cargo miden build --release --manifest-path contracts/probe-account/Cargo.toml
cargo miden build --release --manifest-path contracts/touch-note/Cargo.toml

cargo fmt --all -- --check
cargo test --workspace
```

The current CLI documentation has a discrepancy: `miden build` is documented in some v0.13 pages, while the project build implementation is `cargo miden build`. On a default midenup install, `cargo-miden` may also need to be installed or exposed on `PATH` separately from the `miden` porcelain.

## Current result

Formatting passes with the available stable formatter. The account and note contract builds could not be run here because cargo-miden cannot be downloaded from crates.io in this environment. Consequently, this checkout does not claim that Network Account + custom note + account-component FPI is viable.

The exact `cargo-miden 0.9.0` baseline could not be installed because of the crates.io download failure, so no account-build artifact exists and the note build was correctly not attempted. The smallest compiler-only 0.9.2 check was also attempted: `cargo-miden 0.9.2` itself downloaded, but Cargo then failed on `https://index.crates.io/config.json`, so it could not compile/install. Compiler v0.9.2 was also inspected from the official source: its release notes mention updated templates and tx-kernel binding alignment, but no fix for the known `#[note]`/`#[account]` WIT merge defect. No compiler-only upgrade was applied. The relevant upstream v0.15 report describes the expected next boundary if the account builds but the note fails: `expected function fpi-get-count to be present`. That indicates incompatible generated WIT/FPI bindings between the `miden = 0.13` SDK and the v0.15 compiler/protocol line. The probe deliberately keeps the FPI architecture intact so that failure can be reproduced and versioned rather than hidden by moving logic into the note.

No testnet submission is attempted.

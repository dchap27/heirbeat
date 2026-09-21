//! Integration harness for the probe.
//!
//! The executable test is intentionally kept next to the build helper. Once the
//! v0.15 contract linker accepts the generated FPI interface, this is the only
//! test that needs to be completed with the final MockChain network-account API.

use anyhow::{Context, Result};
use cargo_miden::run;
use miden_mast_package::Package;
use std::path::Path;

pub fn build_contract(path: &Path) -> Result<Package> {
    let manifest = path.join("Cargo.toml");
    let args = [
        "cargo",
        "miden",
        "build",
        "--release",
        "--manifest-path",
        manifest.to_str().context("non-UTF8 manifest path")?,
    ];
    let output =
        run(args.into_iter().map(String::from))?.context("cargo miden returned no output")?;
    let cargo_miden::CommandOutput::BuildCommandOutput { output } = output else {
        anyhow::bail!("unexpected cargo-miden output")
    };
    let artifact = output.first().context("no MASP artifact produced")?;
    Ok(Package::read_from_bytes(&std::fs::read(artifact)?)?)
}

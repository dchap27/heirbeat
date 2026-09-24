//! Integration harness and optional contract build helper for Heirbeat.
//! Runtime tests load the existing release packages without rebuilding them.

use anyhow::{Context, Result};
use miden_mast_package::Package;
use miden_protocol::utils::serde::Deserializable;
use std::path::Path;

pub fn build_contract(path: &Path) -> Result<Package> {
    // Use the project-pinned toolchain; linking cargo-miden 0.10 as a Rust library
    // would pull its release-candidate protocol dependencies into this runtime.
    let status = std::process::Command::new("miden")
        .args(["build", "--release"])
        .current_dir(path)
        .status()
        .context("failed to invoke the project Miden toolchain")?;
    anyhow::ensure!(status.success(), "Miden contract build failed: {status}");
    let name = path
        .file_name()
        .context("missing contract directory name")?
        .to_string_lossy();
    let artifact = path.join(format!("target/miden/release/{name}.masp"));
    Ok(Package::read_from_bytes(&std::fs::read(artifact)?)?)
}

//! Inspect the rebuilt account component exports and note-package external roots.
use std::{collections::BTreeSet, path::Path};

use anyhow::{ensure, Context, Result};
use miden_core::mast::MastNodeExt;
use miden_mast_package::Package;
use miden_protocol::{
    account::{component::AccountComponent, component::InitStorageData},
    utils::serde::Deserializable,
    Word,
};

fn package(name: &str) -> Result<Package> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
        "../contracts/{name}/target/miden/release/{name}.masp"
    ));
    Package::read_from_bytes(&std::fs::read(&path)?)
        .with_context(|| format!("loading {}", path.display()))
}

fn main() -> Result<()> {
    let vault_package = package("heirbeat-vault")?;
    println!(
        "vault package digests: mast={} content={} interface={}",
        vault_package.digest().to_hex(),
        vault_package.content_digest().to_hex(),
        vault_package.interface_digest()?.to_hex()
    );
    let mut init = InitStorageData::default();
    for name in [
        "owner",
        "asset_faucet",
        "beneficiary",
        "claimed",
        "last_check_in",
        "timeout_blocks",
    ] {
        init.insert_value(
            format!("heirbeat_vault::heirbeat_vault::{name}"),
            Word::default(),
        )?;
    }
    let component = AccountComponent::from_package(&vault_package, &init)?;
    let procedures = component
        .procedures()
        .map(|(root, _)| (*root.mast_root(), root))
        .collect::<Vec<_>>();

    println!("vault package: {}", vault_package.name);
    println!("exported account procedures:");
    for export in component.component_code().exports() {
        println!("  {} -> {}", export.path, export.digest.to_hex());
    }
    println!("installed component procedure roots:");
    for (_, root) in &procedures {
        println!("  {root}");
    }

    for note_name in ["check-in-note", "claim-note", "deposit-note"] {
        let note_package = package(note_name)?;
        println!("{note_name} dependencies:");
        let dependencies = note_package.manifest.dependencies().collect::<Vec<_>>();
        for dependency in &dependencies {
            println!(
                "  {} {} {:?} {}",
                dependency.name,
                dependency.version,
                dependency.kind,
                dependency.digest.to_hex()
            );
        }
        let vault_dependency = dependencies
            .iter()
            .find(|dependency| dependency.name.to_string() == "heirbeat-vault")
            .with_context(|| format!("{note_name} does not link heirbeat-vault"))?;
        ensure!(
            vault_dependency.digest == vault_package.digest(),
            "{note_name} links a different heirbeat-vault package"
        );
        let external_roots = note_package
            .mast_forest()
            .nodes()
            .iter()
            .filter(|node| node.is_external())
            .map(|node| node.digest())
            .collect::<BTreeSet<_>>();
        let linked = procedures
            .iter()
            .filter(|(root, _)| external_roots.contains(root))
            .collect::<Vec<_>>();
        println!("{note_name} external roots matching vault exports:");
        for (_, root) in &linked {
            println!("  {root}");
        }
        ensure!(
            linked.len() == 1,
            "expected exactly one vault procedure root linked by {note_name}, found {}",
            linked.len()
        );
    }

    Ok(())
}

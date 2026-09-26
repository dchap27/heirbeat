use std::{collections::BTreeMap, fs, path::Path};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

pub const DEFAULT_RPC_ENDPOINT: &str = "https://rpc.testnet.miden.io";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct TestnetConfig {
    pub schema_version: u32,
    pub rpc_endpoint: String,
    pub owner: Option<String>,
    pub beneficiary: Option<String>,
    pub inherited_faucet: Option<String>,
    pub vault: Option<String>,
    pub timeout_blocks: Option<u32>,
    pub asset_name: Option<String>,
    pub asset_symbol: Option<String>,
    pub asset_decimals: Option<u8>,
    pub asset_max_supply: Option<u64>,
    pub payout_note_id: Option<String>,
    pub poll_seconds: u64,
    pub timeout_seconds: u64,
    pub public_ids: BTreeMap<String, String>,
}

impl Default for TestnetConfig {
    fn default() -> Self {
        Self {
            schema_version: 1,
            rpc_endpoint: DEFAULT_RPC_ENDPOINT.to_owned(),
            owner: None,
            beneficiary: None,
            inherited_faucet: None,
            vault: None,
            timeout_blocks: None,
            asset_name: None,
            asset_symbol: None,
            asset_decimals: None,
            asset_max_supply: None,
            payout_note_id: None,
            poll_seconds: 5,
            timeout_seconds: 300,
            public_ids: BTreeMap::new(),
        }
    }
}

impl TestnetConfig {
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let contents = fs::read_to_string(path)
            .with_context(|| format!("reading non-secret config at {}", path.display()))?;
        let config: Self = serde_json::from_str(&contents)
            .with_context(|| format!("parsing config at {}", path.display()))?;
        anyhow::ensure!(
            config.schema_version == 1,
            "unsupported config schema version"
        );
        Ok(config)
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("creating state directory {}", parent.display()))?;
        }
        let contents = serde_json::to_vec_pretty(self)?;
        let temporary = path.with_extension("json.tmp");
        fs::write(&temporary, contents)
            .with_context(|| format!("writing temporary config {}", temporary.display()))?;
        fs::rename(&temporary, path)
            .with_context(|| format!("atomically replacing config {}", path.display()))?;
        Ok(())
    }

    pub fn ensure_unconfigured(&self, field: &str, value: Option<&str>, force: bool) -> Result<()> {
        anyhow::ensure!(
            force || value.is_none(),
            "{field} is already configured; refusing to create a duplicate. Use --force only if you intend to replace it."
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_round_trips_public_values_without_secret_fields() {
        let mut config = TestnetConfig {
            owner: Some("0x0123".to_owned()),
            timeout_blocks: Some(10),
            ..Default::default()
        };
        config
            .public_ids
            .insert("heartbeat_transaction".into(), "0xabcd".into());
        let encoded = serde_json::to_string(&config).unwrap();
        let decoded: TestnetConfig = serde_json::from_str(&encoded).unwrap();
        assert_eq!(config, decoded);
        assert!(!encoded.to_ascii_lowercase().contains("private_key"));
        assert!(!encoded.to_ascii_lowercase().contains("seed_phrase"));
    }

    #[test]
    fn duplicate_resource_creation_requires_force() {
        let config = TestnetConfig {
            inherited_faucet: Some("0x123".into()),
            ..Default::default()
        };
        assert!(config
            .ensure_unconfigured(
                "inherited faucet",
                config.inherited_faucet.as_deref(),
                false
            )
            .is_err());
        assert!(config
            .ensure_unconfigured("inherited faucet", config.inherited_faucet.as_deref(), true)
            .is_ok());
    }

    #[test]
    fn security_config_rejects_unrecognized_fields_including_secret_like_fields() {
        let error = serde_json::from_str::<TestnetConfig>(
            r#"{"schema_version":1,"private_key":"never-accepted"}"#,
        )
        .unwrap_err();
        assert!(error.to_string().contains("unknown field"));
    }
}

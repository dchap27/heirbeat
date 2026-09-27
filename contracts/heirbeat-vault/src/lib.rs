#![no_std]
#![feature(alloc_error_handler)]

extern crate alloc;

use miden::*;
use miden::storage::{get_map_item, set_map_item};
mod p2id;
mod network_auth_ids;

#[component_storage]
struct HeirbeatStorage {
    /// SDK AccountId word encoding: [0, 0, suffix, prefix].
    #[storage(description = "Configured owner account ID")]
    owner: StorageValue<Word>,
    #[storage(description = "Only supported fungible faucet (callbacks disabled)")]
    asset_faucet: StorageValue<Word>,
    #[storage(description = "Configured beneficiary account ID")]
    beneficiary: StorageValue<Word>,
    #[storage(description = "Terminal claim flag (0 or 1)")]
    claimed: StorageValue<Felt>,
    #[storage(description = "Last authorized transaction reference block")]
    last_check_in: StorageValue<Felt>,
    #[storage(description = "Timeout in blocks (configured u32)")]
    timeout_blocks: StorageValue<Felt>,
    #[storage(description = "One-way activation flag (0 setup, 1 immutable policy)")]
    activated: StorageValue<Felt>,
}

#[component]
trait HeirbeatVault {
    #[account_procedure]
    fn check_in(&mut self);
    #[account_procedure]
    fn claim(&mut self);
    #[account_procedure]
    fn deposit(&mut self);
    #[account_procedure]
    fn activate(&mut self);
    fn get_last_check_in(&self) -> Felt;
    fn get_timeout_blocks(&self) -> Felt;
}

#[component]
impl HeirbeatVault for HeirbeatStorage {
    fn get_last_check_in(&self) -> Felt {
        self.last_check_in.get()
    }
    fn get_timeout_blocks(&self) -> Felt {
        self.timeout_blocks.get()
    }
    fn activate(&mut self) {
        assert!(self.activated.get() == felt!(0), "Heirbeat: already activated");
        assert!(self.claimed.get() == felt!(0), "Heirbeat: already claimed");

        let sender = active_note::get_sender();
        let owner = self.owner.get();
        assert!(
            sender.prefix == owner[3] && sender.suffix == owner[2],
            "Heirbeat: sender is not owner"
        );

        // Activation must be isolated from owner-authorized config notes in the same transaction.
        // The only permitted companion input is a fee sponsorship paired to this activation note.
        let activation_root = active_note::get_script_root();
        let mut activation_count = 0u32;
        let mut sponsorship_count = 0u32;
        let num_inputs = tx::get_num_input_notes();
        assert!(num_inputs == 1 || num_inputs == 2, "Heirbeat: invalid activation inputs");
        for index in 0..num_inputs {
            let root = input_note::get_script_root(NoteIdx { inner: Felt::from(index) });
            if root == activation_root {
                activation_count += 1;
            } else if root == fee_sponsorship_root() {
                sponsorship_count += 1;
            } else {
                assert!(false, "Heirbeat: activation cannot be combined with other notes");
            }
        }
        assert!(
            activation_count == 1 && sponsorship_count <= 1,
            "Heirbeat: invalid activation note set"
        );

        let allowlist_slot = network_note_allowlist_slot();
        let config_root = network_account_config_root();
        assert!(
            get_map_item(allowlist_slot, &config_root) != Word::default(),
            "Heirbeat: config surface is already frozen"
        );
        assert!(
            get_map_item(allowlist_slot, &activation_root) != Word::default(),
            "Heirbeat: activation note is not allowlisted"
        );
        let p2id_root = Word::new(p2id::P2ID_ROOT.map(|value| Felt::new(value).unwrap()));
        assert!(
            get_map_item(allowlist_slot, &p2id_root) == Word::default(),
            "Heirbeat: remove bootstrap P2ID before activation"
        );

        // v0.16 AuthNetworkAccount checks this map against the transaction's initial storage.
        // Zeroing both entries here accepts this activation transaction, then blocks future
        // NetworkAccountConfigNote and activation-note transactions at account authorization.
        set_map_item(allowlist_slot, config_root, Word::default());
        set_map_item(allowlist_slot, activation_root, Word::default());
        self.activated.set(felt!(1));
    }
    fn check_in(&mut self) {
        assert!(self.activated.get() == felt!(1), "Heirbeat: vault is not activated");
        assert!(self.claimed.get() == felt!(0), "Heirbeat: already claimed");
        let sender = active_note::get_sender();
        let owner = self.owner.get();
        assert!(
            sender.prefix == owner[3] && sender.suffix == owner[2],
            "Heirbeat: sender is not owner"
        );
        let current = tx::get_block_number().as_felt();
        // A transaction with an older reference block must not move the heartbeat backwards.
        assert!(
            current >= self.last_check_in.get(),
            "Heirbeat: stale reference block"
        );
        self.last_check_in.set(current);
    }
    fn claim(&mut self) {
        assert!(self.activated.get() == felt!(1), "Heirbeat: vault is not activated");
        let sender = active_note::get_sender();
        let beneficiary = self.beneficiary.get();
        assert!(
            sender.prefix == beneficiary[3] && sender.suffix == beneficiary[2],
            "Heirbeat: sender is not beneficiary"
        );
        assert!(self.claimed.get() == felt!(0), "Heirbeat: already claimed");
        let current = u64::from(tx::get_block_number().as_u32());
        // Validate before adding: two u32 values fit in u64, with no field reduction.
        let last = self.last_check_in.get().as_canonical_u64();
        let timeout = self.timeout_blocks.get().as_canonical_u64();
        assert!(
            last <= u32::MAX as u64 && timeout <= u32::MAX as u64,
            "Heirbeat: invalid block range"
        );
        let deadline = last + timeout;
        assert!(current >= deadline, "Heirbeat: deadline not reached");
        let faucet = self.asset_faucet.get();
        let asset_id = supported_asset_id(faucet);
        let payout_asset = Asset::new(asset_id, active_account::get_asset(asset_id));
        assert!(
            payout_asset.amount() > AssetAmount::ZERO,
            "Heirbeat: empty vault"
        );
        self.claimed.set(felt!(1));
        native_account::remove_asset(payout_asset);
        let script_root = Word::new(p2id::P2ID_ROOT.map(|value| Felt::new(value).unwrap()));
        let recipient = note::build_recipient(
            active_note::get_serial_number(),
            script_root,
            alloc::vec![beneficiary[2], beneficiary[3]],
        );
        // Canonical v0.15 account-target tag: top 14 prefix bits in a u32.
        let tag = ((beneficiary[3].as_canonical_u64() >> 32) as u32) & 0xfffc_0000;
        let output = output_note::create(
            Tag::from(Felt::from_u32(tag)),
            NoteType::from(felt!(1)),
            recipient,
        );
        output_note::add_asset(payout_asset, output);
    }
    fn deposit(&mut self) {
        assert!(self.activated.get() == felt!(1), "Heirbeat: vault is not activated");
        assert!(self.claimed.get() == felt!(0), "Heirbeat: already claimed");
        let faucet = self.asset_faucet.get();
        let supported = supported_asset_id(faucet);
        let assets = active_note::get_initial_assets();
        assert!(!assets.is_empty(), "Heirbeat: empty deposit");
        // Validate the entire note before adding any assets. This excludes NFTs, other
        // faucets, and callback-enabled assets, not merely other asset amounts.
        for asset in &assets {
            assert!(asset.key == supported, "Heirbeat: unsupported asset");
        }
        for asset in assets {
            native_account::add_asset(asset);
        }
    }
}

// These v0.16 identifiers are verified against the stable miden-standards API in integration
// tests. StorageSlotId::new takes (suffix, prefix), matching the kernel host-call order.
fn network_note_allowlist_slot() -> StorageSlotId {
    StorageSlotId::new(
        Felt::new(network_auth_ids::ALLOWED_NOTE_SCRIPTS_SLOT_SUFFIX).unwrap(),
        Felt::new(network_auth_ids::ALLOWED_NOTE_SCRIPTS_SLOT_PREFIX).unwrap(),
    )
}

fn network_account_config_root() -> Word {
    Word::new(network_auth_ids::NETWORK_ACCOUNT_CONFIG_ROOT.map(|value| Felt::new(value).unwrap()))
}

fn fee_sponsorship_root() -> Word {
    Word::new(network_auth_ids::FEE_SPONSORSHIP_ROOT.map(|value| Felt::new(value).unwrap()))
}

/// v0.16 AssetId encoding: [class suffix, class prefix, faucet suffix with
/// Fungible composition, faucet prefix]. The configured AccountId suffix has
/// an unused low metadata byte, as required by the protocol.
fn supported_asset_id(faucet: Word) -> Word {
    let suffix = faucet[2].as_canonical_u64();
    Word::new([
        felt!(0),
        felt!(0),
        Felt::new((suffix & !0xff) | 1).unwrap(),
        faucet[3],
    ])
}

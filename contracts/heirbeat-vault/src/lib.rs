#![no_std]
#![feature(alloc_error_handler)]

extern crate alloc;

use miden::*;
mod p2id;

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
}

#[component]
trait HeirbeatVault {
    #[account_procedure]
    fn check_in(&mut self);
    #[account_procedure]
    fn claim(&mut self);
    #[account_procedure]
    fn deposit(&mut self);
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
    fn check_in(&mut self) {
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

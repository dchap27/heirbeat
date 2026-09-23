#![no_std]
#![feature(alloc_error_handler)]

use miden::*;

#[component_storage]
struct HeirbeatStorage {
    /// SDK AccountId word encoding: [0, 0, suffix, prefix].
    #[storage(description = "Configured owner account ID")]
    owner: StorageValue<Word>,
    #[storage(description = "Last authorized transaction reference block")]
    last_check_in: StorageValue<Felt>,
    #[storage(description = "Timeout in blocks (configured u32)")]
    timeout_blocks: StorageValue<Felt>,
}

#[component]
trait HeirbeatVault {
    fn check_in(&mut self);
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
        let sender = active_note::get_sender();
        let owner = self.owner.get();
        assert!(
            sender.prefix == owner[3] && sender.suffix == owner[2],
            "Heirbeat: sender is not owner"
        );
        let current = tx::get_block_number();
        // A transaction with an older reference block must not move the heartbeat backwards.
        assert!(
            current >= self.last_check_in.get(),
            "Heirbeat: stale reference block"
        );
        self.last_check_in.set(current);
    }
}

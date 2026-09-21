#![no_std]
#![feature(alloc_error_handler)]

use miden::*;

#[component_storage]
struct ProbeStorage {
    #[storage(description = "last_seen")]
    last_seen: StorageValue<Felt>,
}

#[component]
trait Probe {
    fn touch(&mut self);
    fn get_last_seen(&self) -> Felt;
}

#[component]
impl Probe for ProbeStorage {
    fn touch(&mut self) {
        self.last_seen.set(self.last_seen.get() + felt!(1));
    }

    fn get_last_seen(&self) -> Felt {
        self.last_seen.get()
    }
}

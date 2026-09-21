#![no_std]
#![feature(alloc_error_handler)]

use miden::*;

/// The active account wrapper is generated from probe-account's WIT interface.
#[account(probe_account::Probe)]
pub struct ProbeAccount;

#[note]
struct TouchNote;

#[note]
impl TouchNote {
    #[note_script]
    fn run(self, _arg: Word, account: &mut ProbeAccount) {
        account.touch();
    }
}

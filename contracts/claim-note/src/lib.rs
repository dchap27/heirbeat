#![no_std]
#![feature(alloc_error_handler)]

use miden::*;

#[account(heirbeat_vault::HeirbeatVault)]
pub struct HeirbeatAccount;

#[note]
struct ClaimNote;

#[note]
impl ClaimNote {
    #[note_script]
    fn run(self, _arg: Word, account: &mut HeirbeatAccount) {
        account.claim();
    }
}

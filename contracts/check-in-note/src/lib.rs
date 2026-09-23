#![no_std]
#![feature(alloc_error_handler)]

use miden::*;

#[account(heirbeat_vault::HeirbeatVault)]
pub struct HeirbeatAccount;

#[note]
struct CheckInNote;

#[note]
impl CheckInNote {
    #[note_script]
    fn run(self, _arg: Word, account: &mut HeirbeatAccount) {
        account.check_in();
    }
}

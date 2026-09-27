#![no_std]
#![feature(alloc_error_handler)]

use miden::*;

#[account(heirbeat_vault::HeirbeatVault)]
pub struct HeirbeatAccount;

#[note]
struct ActivateVaultNote;

#[note]
impl ActivateVaultNote {
    #[note_script]
    fn run(self, _arg: Word, account: &mut HeirbeatAccount) {
        account.activate();
    }
}

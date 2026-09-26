#![no_std]
#![feature(alloc_error_handler)]

use miden::*;

#[account(heirbeat_vault::HeirbeatVault)]
pub struct HeirbeatAccount;

#[note]
struct DepositNote;

#[note]
impl DepositNote {
    #[note_script]
    fn run(self, _arg: Word, account: &mut HeirbeatAccount) {
        // Tags only route notes. Bind custody to the recipient in committed storage.
        let target = active_note::get_storage();
        assert!(target.len() == 2, "Heirbeat: invalid deposit recipient");
        let recipient = native_account::get_id();
        assert!(
            target[0] == recipient.suffix && target[1] == recipient.prefix,
            "Heirbeat: wrong deposit recipient"
        );
        account.deposit();
    }
}

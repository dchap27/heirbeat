//! Intended end-to-end scenario for the v0.15 Network Account path.
//!
//! This test is left as a compile-time probe until the note package links. The
//! first command in the test is deliberately the account build: if the account
//! succeeds and touch-note fails with `expected function fpi-* to be present`,
//! that is an upstream compiler/SDK incompatibility, not an application failure.

#[test]
#[ignore = "blocked until cargo-miden links the v0.13 SDK FPI binding against protocol v0.15"]
fn network_account_touch_flow() {
    todo!(
        "Create PUBLIC account + AuthNetworkAccount::with_allowed_notes(touch_note.root()), "
            "execute the public touch note in MockChain, then assert last_seen incremented"
    );
}

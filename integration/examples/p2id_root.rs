//! Print the pinned standard P2ID root for the contract constant.
fn main() {
    let root = miden_standards::note::P2idNote::script_root().as_word();
    println!(
        "{:?}",
        root.as_elements()
            .iter()
            .map(|felt| felt.as_canonical_u64())
            .collect::<Vec<_>>()
    );
}

// Canonical miden-standards 0.16.1 P2ID root. Regenerate with:
// cargo run -p integration --example p2id_root
// Integration tests compare this constant to P2idNote::script_root().
pub const P2ID_ROOT: [u64; 4] = [
    3753793277686139666,
    16926746659472928710,
    1136859898937662014,
    10130066283336208623,
];

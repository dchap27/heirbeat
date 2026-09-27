// Stable v0.16.1 AuthNetworkAccount storage/root identifiers used by the one-way activation.
// Integration tests derive these from miden-standards and StorageSlotName and assert equality.
pub const ALLOWED_NOTE_SCRIPTS_SLOT_SUFFIX: u64 = 2_126_136_152_909_143_842;
pub const ALLOWED_NOTE_SCRIPTS_SLOT_PREFIX: u64 = 17_348_658_509_170_012_731;
pub const NETWORK_ACCOUNT_CONFIG_ROOT: [u64; 4] = [
    8_075_035_663_837_133_512,
    1_150_644_011_991_293_897,
    3_117_287_733_479_066_417,
    5_672_360_194_367_104_946,
];
pub const FEE_SPONSORSHIP_ROOT: [u64; 4] = [
    1_015_264_762_381_798_369,
    9_547_176_364_870_343_903,
    3_998_928_787_042_619_802,
    17_355_644_573_911_496_610,
];

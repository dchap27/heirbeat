import {
  AccountBuilder,
  AccountComponent,
  AccountId,
  Account,
  AccountStorage,
  AccountStorageMode,
  AccountType,
  Felt,
  NoteScript,
  NoteScriptFee,
  Package,
  StorageSlot,
  StorageSlotArray,
  Word,
} from "@miden-sdk/miden-sdk";
import { loadFeatureScript } from "../heirbeat/feature-notes";
import { releaseSdkValue } from "./sdk-lifetime";

const HEIRBEAT_SLOT = "heirbeat_vault::heirbeat_vault::";
const OWNABLE_SLOT = "miden::standards::access::ownable2step::owner_config";
const AUTHORITY_SLOT = "miden::standards::access::authority::authority_config";
const SCHEMA_SLOT = "miden::standards::inspection::storage_schema::commitment";
const ALLOWED_TX_SLOT = "miden::standards::auth::network_account::allowed_tx_scripts";
const CLI_SCHEMA_COMMITMENT = [
  7719079962924827991n,
  5573801878082583294n,
  5947310930313345739n,
  5221074269396151993n,
] as const;

export interface VaultAccountConstructionInput {
  owner: string;
  beneficiary: string;
  inheritedFaucet: string;
  nativeFaucet: string;
  timeoutBlocks: number;
  /** Test-only deterministic seed. Production callers should omit this. */
  testSeed?: Uint8Array;
}

export interface VaultAccountConstructionSummary {
  accountId: string;
  accountType: "public";
  accountTypeExport: Array<[string, string]>;
  accountTypePublicRuntimeValue: string;
  accountStorageMode: string;
  accountPublic: boolean;
  accountIdPublic: boolean;
  accountIdPrefix: string;
  networkAccount: boolean;
  networkNoteAllowlistCount: number | null;
  storage: Record<string, string[]>;
  storageSlots: string[];
  noteAllowlist: string[];
  transactionScriptAllowlist: string[];
  componentOrder: string[];
  procedureRoots: string[];
  accountCodeCommitment: string;
  accountStorageCommitment: string;
  accountStorageRuntime: {
    constructorName: string;
    freeMethodType: string;
    ownPropertyNames: string[];
    prototypeMethodNames: string[];
    cleanup: "freed-sdk-wrapper" | "runtime-managed";
  };
  accountSchemaCommitment?: string;
  serializedAccountBase64: string;
}

async function loadPackage(path: string): Promise<Package> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Cannot load account component package (${response.status}): ${path}`);
  return Package.deserialize(new Uint8Array(await response.arrayBuffer()));
}

function idWord(id: AccountId): Word {
  return Word.newFromFelts([new Felt(0n), new Felt(0n), id.suffix(), id.prefix()]);
}

function scalarWord(value: bigint): Word {
  return Word.newFromFelts([new Felt(value), new Felt(0n), new Felt(0n), new Felt(0n)]);
}

function componentSlots(entries: Array<[string, Word]>): StorageSlotArray {
  try {
    // StorageSlot.fromValue borrows the Word pointer and constructs its own
    // slot value; the input Word wrappers remain caller-owned.
    return new StorageSlotArray(entries.map(([name, value]) => StorageSlot.fromValue(name, value)));
  } finally {
    entries.forEach(([, value]) => releaseSdkValue(value, "caller-owned"));
  }
}

export function plainWordValues(word: { toFelts(): Array<{ asInt(): bigint }> }): string[] {
  // The browser package decorates Account.storage().getItem() into a
  // StorageResult facade. That accessor result owns its underlying Word and
  // does not expose free(); only the fresh Felt wrappers returned here belong
  // to this caller.
  const values = word.toFelts();
  try { return values.map((felt) => felt.asInt().toString()); }
  finally { values.forEach((felt) => releaseSdkValue(felt, "caller-owned")); }
}

/**
 * The public browser entry point decorates Account.storage() into a
 * JavaScript StorageView. That view owns the raw AccountStorage wrapper and has
 * no disposal API. Only dispose a direct raw SDK AccountStorage wrapper when
 * the caller explicitly owns it; never dispose a StorageView/accessor result.
 */
export function disposeOwnedAccountStorage(value: unknown, ownership: "caller-owned" | "borrowed" | "transferred"):
  "freed-sdk-wrapper" | "runtime-managed" | "not-owned" {
  if (ownership !== "caller-owned") return "not-owned";
  if (!(value instanceof AccountStorage)) return "runtime-managed";
  return releaseSdkValue(value, "caller-owned") === "released" ? "freed-sdk-wrapper" : "runtime-managed";
}

function accountStorageRuntime(value: unknown): VaultAccountConstructionSummary["accountStorageRuntime"] {
  const object = value !== null && (typeof value === "object" || typeof value === "function")
    ? value as object
    : undefined;
  const prototype = object ? Object.getPrototypeOf(object) as object | null : null;
  const methodNames = prototype
    ? Object.getOwnPropertyNames(prototype).filter((name) => name !== "constructor")
    : [];
  const hasSdkDisposer = value instanceof AccountStorage && typeof (value as AccountStorage).free === "function";
  return {
    constructorName: object?.constructor?.name ?? typeof value,
    freeMethodType: object ? typeof (object as { free?: unknown }).free : "undefined",
    ownPropertyNames: object ? Object.getOwnPropertyNames(object) : [],
    prototypeMethodNames: methodNames,
    cleanup: hasSdkDisposer ? "freed-sdk-wrapper" : "runtime-managed",
  };
}

/** Builds the CLI-equivalent public vault account locally and returns plain JS data only. */
export async function constructVaultAccount(input: VaultAccountConstructionInput): Promise<VaultAccountConstructionSummary> {
  if (!Number.isSafeInteger(input.timeoutBlocks) || input.timeoutBlocks <= 0 || input.timeoutBlocks > 0xffff_ffff) {
    throw new Error("Timeout must be a positive u32 block count.");
  }
  const owner = AccountId.fromHex(input.owner);
  const beneficiary = AccountId.fromHex(input.beneficiary);
  const inheritedFaucet = AccountId.fromHex(input.inheritedFaucet);
  const nativeFaucet = AccountId.fromHex(input.nativeFaucet);
  if (input.testSeed && input.testSeed.length !== 32) throw new Error("Test account seed must contain exactly 32 bytes.");
  const seed = input.testSeed?.slice() ?? crypto.getRandomValues(new Uint8Array(32));
  const featureScripts = await Promise.all(([
    "heartbeat", "claim", "deposit", "activation",
  ] as const).map(loadFeatureScript));
  const roots = [
    ...featureScripts.map((script) => script.root()),
    NoteScript.p2id().root(),
    NoteScript.networkAccountConfig().root(),
    NoteScript.feeSponsorship().root(),
  ];
  const fees = roots.map((root) => new NoteScriptFee(root, 0n));
  let vaultPackage: Package | undefined;
  let ownablePackage: Package | undefined;
  let authorityPackage: Package | undefined;
  let schemaPackage: Package | undefined;
  let vaultSlots: StorageSlotArray | undefined;
  let ownableSlots: StorageSlotArray | undefined;
  let authoritySlots: StorageSlotArray | undefined;
  let schemaSlots: StorageSlotArray | undefined;
  let vaultComponent: AccountComponent | undefined;
  let ownableComponent: AccountComponent | undefined;
  let authorityComponent: AccountComponent | undefined;
  let schemaComponent: AccountComponent | undefined;
  let networkComponents: AccountComponent[] = [];
  let builder: AccountBuilder | undefined;
  let publicStorageMode: AccountStorageMode | undefined;
  let result: ReturnType<AccountBuilder["build"]> | undefined;
  let account: Account | undefined;
  let storage: ReturnType<Account["storage"]> | undefined;
  let storageRuntime: VaultAccountConstructionSummary["accountStorageRuntime"] | undefined;
  try {
    vaultPackage = await loadPackage("/contracts/heirbeat-vault.masp");
    ownablePackage = await loadPackage("/miden-standards-0.16.1/miden-standards-access-ownable2step.masp");
    authorityPackage = await loadPackage("/miden-standards-0.16.1/miden-standards-access-authority.masp");
    schemaPackage = await loadPackage("/miden-standards-0.16.1/miden-standards-inspection-schema-commitment.masp");
    vaultSlots = componentSlots([
      [`${HEIRBEAT_SLOT}owner`, idWord(owner)],
      [`${HEIRBEAT_SLOT}asset_faucet`, idWord(inheritedFaucet)],
      [`${HEIRBEAT_SLOT}beneficiary`, idWord(beneficiary)],
      [`${HEIRBEAT_SLOT}claimed`, scalarWord(0n)],
      [`${HEIRBEAT_SLOT}last_check_in`, scalarWord(0n)],
      [`${HEIRBEAT_SLOT}timeout_blocks`, scalarWord(BigInt(input.timeoutBlocks))],
      [`${HEIRBEAT_SLOT}activated`, scalarWord(0n)],
    ]);
    ownableSlots = componentSlots([[OWNABLE_SLOT, Word.newFromFelts([
      owner.suffix(), owner.prefix(), new Felt(0n), new Felt(0n),
    ])]]);
    authoritySlots = componentSlots([[AUTHORITY_SLOT, Word.newFromFelts([
      new Felt(1n), new Felt(0n), new Felt(0n), new Felt(0n),
    ])]]);
    const schemaWord = new Word(new BigUint64Array(CLI_SCHEMA_COMMITMENT));
    const schemaHex = schemaWord.toHex();
    schemaSlots = componentSlots([[SCHEMA_SLOT, schemaWord]]);

    vaultComponent = AccountComponent.fromPackage(vaultPackage, vaultSlots);
    vaultSlots = undefined; // fromPackage consumes the StorageSlotArray wrapper
    ownableComponent = AccountComponent.fromPackage(ownablePackage, ownableSlots);
    ownableSlots = undefined;
    authorityComponent = AccountComponent.fromPackage(authorityPackage, authoritySlots);
    authoritySlots = undefined;
    schemaComponent = AccountComponent.fromPackage(schemaPackage, schemaSlots);
    schemaSlots = undefined;

    networkComponents = AccountComponent.createNetworkAuthComponents(fees, nativeFaucet, []);
    const procedureDigests = [vaultComponent, ownableComponent, authorityComponent, ...networkComponents, schemaComponent]
      .flatMap((component) => {
        const items = component.getProcedures();
        try { return items.map((item) => releaseDigest(item)); }
        finally { items.forEach((item) => releaseSdkValue(item, "caller-owned")); }
      }).sort();

    // The package's public browser entry shadows the generated AccountType
    // enum with faucet selectors. AccountStorageMode is the supported account
    // visibility API in 0.16.3 and avoids passing the shadowed undefined value.
    const sdkAccountType = AccountType as unknown as Record<string, unknown>;
    const accountTypeExport: Array<[string, string]> = Object.entries(sdkAccountType)
      .map(([name, value]) => [name, String(value)]);
    const accountTypePublicRuntimeValue = String(sdkAccountType.Public);
    publicStorageMode = AccountStorageMode.public();
    const accountStorageMode = publicStorageMode.asStr();
    builder = new AccountBuilder(seed);
    builder = builder.storageMode(publicStorageMode);
    releaseSdkValue(publicStorageMode, "caller-owned");
    publicStorageMode = undefined;
    builder = builder
      .withComponent(vaultComponent)
      .withBasicWalletComponent()
      .withComponent(ownableComponent)
      .withComponent(authorityComponent);
    for (const component of networkComponents) builder = builder.withComponent(component);
    builder = builder.withComponent(schemaComponent);
    result = builder.buildWithoutSchemaCommitment();
    account = result.account;

    const networkAccount = account.isNetworkAccount();
    const initialAllowlist = account.networkNoteAllowlist();
    const networkNoteAllowlistCount = initialAllowlist?.length ?? null;
    initialAllowlist?.forEach((root) => releaseSdkValue(root, "caller-owned"));
    storage = account.storage();
    storageRuntime = accountStorageRuntime(storage);
    const accountStorage = storage;
    const names = accountStorage.getSlotNames();
    const serialized = account.serialize();
    const code = account.code();
    const codeCommitment = code.commitment();
    const codeCommitmentHex = codeCommitment.toHex();
    releaseSdkValue(codeCommitment, "caller-owned");
    releaseSdkValue(code, "caller-owned");
    const storageCommitment = accountStorage.commitment();
    const storageCommitmentHex = storageCommitment.toHex();
    releaseSdkValue(storageCommitment, "caller-owned");

    const storageValues: Record<string, string[]> = {};
    for (const name of ["owner", "beneficiary", "asset_faucet", "claimed", "activated", "last_check_in", "timeout_blocks"]) {
      const value = accountStorage.getItem(`${HEIRBEAT_SLOT}${name}`);
      if (!value) throw new Error(`Constructed vault is missing ${name} storage.`);
      storageValues[name] = plainWordValues(value);
    }
    const ownableValue = accountStorage.getItem(OWNABLE_SLOT);
    if (!ownableValue) throw new Error("Missing Ownable2Step owner slot.");
    storageValues.ownable2step_owner_config = plainWordValues(ownableValue);
    const authorityValue = accountStorage.getItem(AUTHORITY_SLOT);
    if (!authorityValue) throw new Error("Missing owner-controlled authority slot.");
    storageValues.authority_config = plainWordValues(authorityValue);

    const noteAllowlist = (account.networkNoteAllowlist() ?? []).map((root) => {
      try { return root.toHex(); }
      finally { releaseSdkValue(root, "caller-owned"); }
    }).sort();
    const mapEntries = accountStorage.getMapEntries(ALLOWED_TX_SLOT) ?? [];
    const transactionScriptAllowlist = mapEntries
      .filter((entry) => !/^0x0+$/i.test(entry.value))
      .map((entry) => entry.key.toLowerCase()).sort();
    mapEntries.forEach((entry) => releaseSdkValue(entry, "caller-owned"));
    const accountId = account.id();
    let accountIdString: string;
    let accountIdPublic: boolean;
    let accountIdPrefix: string;
    try {
      accountIdString = accountId.toString();
      accountIdPublic = accountId.isPublic();
      const prefix = accountId.prefix();
      try { accountIdPrefix = prefix.asInt().toString(); }
      finally { releaseSdkValue(prefix, "caller-owned"); }
    } finally { releaseSdkValue(accountId, "caller-owned"); }

    return {
      accountId: accountIdString,
      accountType: "public",
      accountTypeExport,
      accountTypePublicRuntimeValue,
      accountStorageMode,
      accountPublic: account.isPublic(),
      accountIdPublic,
      accountIdPrefix,
      networkAccount,
      networkNoteAllowlistCount,
      storage: storageValues,
      storageSlots: names,
      noteAllowlist,
      transactionScriptAllowlist,
      componentOrder: ["heirbeat-vault", "BasicWallet", "Ownable2Step", "Authority::OwnerControlled", "AuthNetworkAccount", "AccountSchemaCommitment"],
      procedureRoots: procedureDigests,
      accountCodeCommitment: codeCommitmentHex,
      accountStorageCommitment: storageCommitmentHex,
      accountStorageRuntime: storageRuntime,
      accountSchemaCommitment: schemaHex,
      serializedAccountBase64: btoa(String.fromCharCode(...serialized)),
    };
  } finally {
    releaseSdkValue(account, "caller-owned");
    if (storage) disposeOwnedAccountStorage(storage, "caller-owned");
    releaseSdkValue(result, "caller-owned");
    releaseSdkValue(builder, "caller-owned");
    releaseSdkValue(publicStorageMode, "caller-owned");
    releaseSdkValue(vaultComponent, "caller-owned");
    releaseSdkValue(ownableComponent, "caller-owned");
    releaseSdkValue(authorityComponent, "caller-owned");
    releaseSdkValue(schemaComponent, "caller-owned");
    networkComponents.forEach((component) => releaseSdkValue(component, "caller-owned"));
    releaseSdkValue(vaultSlots, "transferred");
    releaseSdkValue(ownableSlots, "transferred");
    releaseSdkValue(authoritySlots, "transferred");
    releaseSdkValue(schemaSlots, "transferred");
    releaseSdkValue(vaultPackage, "caller-owned");
    releaseSdkValue(ownablePackage, "caller-owned");
    releaseSdkValue(authorityPackage, "caller-owned");
    releaseSdkValue(schemaPackage, "caller-owned");
    releaseSdkValue(owner, "caller-owned");
    releaseSdkValue(beneficiary, "caller-owned");
    releaseSdkValue(inheritedFaucet, "caller-owned");
    releaseSdkValue(nativeFaucet, "caller-owned");
    featureScripts.forEach((script) => releaseSdkValue(script, "caller-owned"));
    // NoteScriptFee borrows its Word root; createNetworkAuthComponents takes
    // ownership of the NoteScriptFee wrappers, not the source roots.
    roots.forEach((root) => releaseSdkValue(root, "caller-owned"));
    seed.fill(0);
  }
}

function releaseDigest(item: { digest: Word }): string {
  const digest = item.digest;
  try { return digest.toHex().toLowerCase(); }
  finally { releaseSdkValue(digest, "caller-owned"); }
}

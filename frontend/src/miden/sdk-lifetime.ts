/**
 * Explicit ownership policy for Web SDK values crossing the JS/WASM boundary.
 * Caller-owned wrappers may be released only when the active runtime exposes a
 * disposer. Borrowed, transferred, and unknown values are left to their owner or
 * WASM finalizer. This avoids treating TypeScript declarations as runtime proof.
 */
export type SdkValueOwnership = "caller-owned" | "borrowed" | "transferred" | "unknown";
export type SdkValueRelease = "released" | "runtime-managed" | "not-owned" | "already-released" | "cleanup-failed";

const releasedValues = new WeakSet<object>();

export function releaseSdkValue(value: unknown, ownership: SdkValueOwnership): SdkValueRelease {
  if (ownership !== "caller-owned") return "not-owned";
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return "runtime-managed";
  }
  if (releasedValues.has(value)) return "already-released";
  const free = Reflect.get(value, "free") as unknown;
  if (typeof free !== "function") return "runtime-managed";
  releasedValues.add(value);
  try {
    free.call(value);
    return "released";
  } catch {
    // Cleanup is best-effort. A destructor failure must not replace the
    // construction/classification error that caused the caller to unwind.
    return "cleanup-failed";
  }
}

export interface ExecutionProgress {
  elapsedMs: number;
  heartbeatCount: number;
  startedAtUtc: string;
}

export type PromiseSettlement<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };

export type ExecutionWaitResult<T> =
  | { kind: "settled"; elapsedMs: number; settlement: PromiseSettlement<T> }
  | { kind: "timed_out"; elapsedMs: number; settlement: Promise<PromiseSettlement<T>> };

/** Observe a diagnostic promise without cancelling or otherwise changing it. */
export async function waitForDiagnosticExecution<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onProgress: (progress: ExecutionProgress) => void,
  heartbeatMs = 1_000,
): Promise<ExecutionWaitResult<T>> {
  const started = performance.now();
  const startedAtUtc = new Date().toISOString();
  let heartbeatCount = 0;
  const settlement = promise.then<PromiseSettlement<T>, PromiseSettlement<T>>(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  interval = setInterval(() => {
    heartbeatCount += 1;
    onProgress({
      elapsedMs: Math.round(performance.now() - started),
      heartbeatCount,
      startedAtUtc,
    });
  }, heartbeatMs);

  const result = await Promise.race([settlement.then(() => "settled" as const), timeout]);
  if (timer !== undefined) clearTimeout(timer);
  if (interval !== undefined) clearInterval(interval);
  const elapsedMs = Math.round(performance.now() - started);
  return result === "timeout"
    ? { kind: "timed_out", elapsedMs, settlement }
    : { kind: "settled", elapsedMs, settlement: await settlement };
}

/** A late resolve after timeout is evidence only; it never becomes a success transition. */
export function lateExecutionIsSuccess(_settlement: PromiseSettlement<unknown>): false {
  return false;
}

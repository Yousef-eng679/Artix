export const TRANSPORT_TIMEOUT_MS = 10000;

export async function withTimeout<T>(
  promise: Promise<T> | PromiseLike<T>,
  timeoutMs = TRANSPORT_TIMEOUT_MS,
  errorMsg = 'Network transport request timed out'
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(errorMsg);
      (err as any).name = 'TimeoutError';
      (err as any).code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

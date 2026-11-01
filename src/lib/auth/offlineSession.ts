import { Session, isAuthApiError, isAuthRetryableFetchError } from '@supabase/supabase-js';

export interface RecoveredOfflineSession {
  session: Session;
  isExpired: boolean;
  storageKey: string;
}

const EXPIRY_SAFETY_MARGIN_MS = 30_000;

function resolveStorage(explicitStorage?: Storage | null): Storage | null {
  if (explicitStorage !== undefined) return explicitStorage;
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Discovers candidate Supabase auth localStorage keys in priority order.
 */
export function getSupabaseAuthStorageKeys(
  supabaseClient?: unknown,
  explicitStorage?: Storage | null,
): string[] {
  const keys: string[] = [];
  const pushUnique = (key: unknown) => {
    if (typeof key === 'string' && key.trim().length > 0 && !keys.includes(key)) {
      keys.push(key);
    }
  };

  const clientAny = supabaseClient as { storageKey?: unknown; auth?: { storageKey?: unknown } } | undefined;
  pushUnique(clientAny?.storageKey);
  pushUnique(clientAny?.auth?.storageKey);

  const envUrl = import.meta.env.VITE_SUPABASE_URL;
  if (typeof envUrl === 'string' && envUrl.trim().length > 0) {
    try {
      const hostPrefix = new URL(envUrl).hostname.split('.')[0];
      if (hostPrefix) {
        pushUnique(`sb-${hostPrefix}-auth-token`);
      }
    } catch {
      // Ignore malformed env URL
    }
  }

  const storage = resolveStorage(explicitStorage);
  if (storage) {
    try {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key && /^sb-.*-auth-token$/.test(key)) {
          pushUnique(key);
        }
      }
    } catch {
      // Ignore restricted storage iteration errors
    }
  }

  return keys;
}

/**
 * Inspects localStorage for a previously persisted Supabase session with a non-empty
 * refresh_token and a structurally valid user.id so offline cold starts with an
 * expired access_token preserve local user identity and Dexie access.
 */
export function recoverOfflineSessionFromStorage(
  supabaseClient?: unknown,
  explicitStorage?: Storage | null,
): RecoveredOfflineSession | null {
  const storage = resolveStorage(explicitStorage);
  if (!storage) return null;

  const candidateKeys = getSupabaseAuthStorageKeys(supabaseClient, storage);
  for (const key of candidateKeys) {
    let raw: string | null = null;
    try {
      raw = storage.getItem(key);
    } catch {
      continue;
    }
    if (!raw) continue;

    let parsed: Record<string, unknown>;
    try {
      const json = JSON.parse(raw);
      if (!json || typeof json !== 'object') continue;
      parsed = json as Record<string, unknown>;
    } catch {
      continue;
    }

    const accessToken = parsed.access_token;
    const refreshToken = parsed.refresh_token;
    if (typeof accessToken !== 'string' || accessToken.trim().length === 0) continue;
    if (typeof refreshToken !== 'string' || refreshToken.trim().length === 0) continue;

    let userObj = parsed.user as Record<string, unknown> | undefined;
    if (!userObj || typeof userObj !== 'object') {
      try {
        const separateUserRaw = storage.getItem(`${key}-user`);
        if (separateUserRaw) {
          const parsedSeparate = JSON.parse(separateUserRaw) as { user?: Record<string, unknown> };
          if (parsedSeparate?.user && typeof parsedSeparate.user === 'object') {
            userObj = parsedSeparate.user;
          }
        }
      } catch {
        // Ignore malformed separate user entry
      }
    }

    const userId = userObj?.id;
    if (typeof userId !== 'string' || userId.trim().length === 0) continue;

    const expiresAt = typeof parsed.expires_at === 'number' ? parsed.expires_at : null;
    const isExpired =
      expiresAt !== null ? expiresAt * 1000 - Date.now() < EXPIRY_SAFETY_MARGIN_MS : false;

    const session = {
      ...parsed,
      user: userObj,
    } as unknown as Session;

    return {
      session,
      isExpired,
      storageKey: key,
    };
  }

  return null;
}

/**
 * Purges stored Supabase session artifacts from localStorage so offline signOut()
 * never leaves behind a recoverable offline session.
 */
export function clearStoredSupabaseSession(
  supabaseClient?: unknown,
  explicitStorage?: Storage | null,
): void {
  const storage = resolveStorage(explicitStorage);
  if (!storage) return;

  const candidateKeys = getSupabaseAuthStorageKeys(supabaseClient, storage);
  for (const key of candidateKeys) {
    try {
      storage.removeItem(key);
      storage.removeItem(`${key}-user`);
      storage.removeItem(`${key}-code-verifier`);
    } catch {
      // Ignore storage removal errors
    }
  }
}

export function isRetryableAuthNetworkError(error: unknown): boolean {
  if (!error) return false;
  if (isAuthRetryableFetchError(error)) return true;

  const errObj = error as { name?: string; status?: number; message?: string };
  if (errObj.name === 'AuthRetryableFetchError') return true;
  if (errObj.status === 0) return true;
  if (error instanceof TypeError && /fetch|network|offline/i.test(error.message)) return true;
  return false;
}

export function isFatalAuthRevocationError(error: unknown): boolean {
  if (!error) return false;
  if (isAuthApiError(error)) {
    return error.status >= 400 && error.status < 500 && error.status !== 429;
  }
  const errObj = error as { __isAuthError?: boolean; status?: number };
  if (
    errObj.__isAuthError &&
    typeof errObj.status === 'number' &&
    errObj.status >= 400 &&
    errObj.status < 500 &&
    errObj.status !== 429
  ) {
    return true;
  }
  return false;
}

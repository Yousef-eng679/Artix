import { useState, useEffect, createContext, useContext, ReactNode, useRef, useCallback } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { clearSensitiveBrowserCaches } from '@/lib/sync/userSyncRuntime';
import {
  clearStoredSupabaseSession,
  isFatalAuthRevocationError,
  isRetryableAuthNetworkError,
  recoverOfflineSessionFromStorage,
} from '@/lib/auth/offlineSession';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  sessionError: Error | null;
  isOfflineSession: boolean;
  reauthRequired: boolean;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signUp: (email: string, password: string) => Promise<{ error: Error | null }>;
  signInWithGoogle: () => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  updatePassword: (newPassword: string) => Promise<{ error: Error | null }>;
  refreshSession: () => Promise<Session | null>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionError, setSessionError] = useState<Error | null>(null);
  const [isOfflineSession, setIsOfflineSession] = useState(false);
  const [reauthRequired, setReauthRequired] = useState(false);
  const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef(true);
  const isOfflineSessionRef = useRef(false);
  const explicitSignOutRef = useRef(false);

  const updateOfflineSession = useCallback((next: boolean) => {
    isOfflineSessionRef.current = next;
    setIsOfflineSession(next);
  }, []);

  // Proactive session refresh function
  const refreshSession = useCallback(async (): Promise<Session | null> => {
    try {
      const { data: { session: refreshedSession }, error } = await supabase.auth.refreshSession();

      if (error) {
        console.error('Session refresh failed:', error.message);
        if (isMountedRef.current) {
          setSessionError(error);
          if (isOfflineSessionRef.current && isFatalAuthRevocationError(error)) {
            setReauthRequired(true);
          }
        }
        return null;
      }

      if (isMountedRef.current) {
        updateOfflineSession(false);
        setReauthRequired(false);
        setSessionError(null);
        setSession(refreshedSession);
        setUser(refreshedSession?.user ?? null);
      }

      return refreshedSession;
    } catch (error) {
      console.error('Unexpected error during session refresh:', error);
      if (isMountedRef.current) {
        setSessionError(error as Error);
        if (isOfflineSessionRef.current && isFatalAuthRevocationError(error)) {
          setReauthRequired(true);
        }
      }
      return null;
    }
  }, [updateOfflineSession]);

  useEffect(() => {
    isMountedRef.current = true;
    let authStateTransitioned = false;

    // Listener for ONGOING auth changes (does NOT control loading state)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, newSession) => {
        if (!isMountedRef.current) return;

        if (event === 'INITIAL_SESSION') {
          if (!newSession) {
            return;
          }
          updateOfflineSession(false);
          setReauthRequired(false);
          setSessionError(null);
          setSession(newSession);
          setUser(newSession.user ?? null);
          return;
        }

        authStateTransitioned = true;
        console.log('Auth state change:', event);

        if (event === 'SIGNED_OUT') {
          if (isOfflineSessionRef.current && !explicitSignOutRef.current) {
            // Refresh token was revoked server-side during background reconnect;
            // keep local offline workspace accessible and prompt non-destructive re-auth.
            setReauthRequired(true);
            return;
          }

          explicitSignOutRef.current = false;
          updateOfflineSession(false);
          setReauthRequired(false);
          setSession(null);
          setUser(null);
          setSessionError(null);
          void clearSensitiveBrowserCaches();
          if (refreshTimerRef.current) {
            clearTimeout(refreshTimerRef.current);
            refreshTimerRef.current = null;
          }
          return;
        }

        explicitSignOutRef.current = false;
        setSession(newSession);
        setUser(newSession?.user ?? null);

        if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN' || event === 'USER_UPDATED') {
          updateOfflineSession(false);
          setReauthRequired(false);
          setSessionError(null);
        }
      }
    );

    // INITIAL load (controls loading state)
    const initializeAuth = async () => {
      try {
        const browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
        if (browserOffline) {
          const recovered = recoverOfflineSessionFromStorage(supabase);
          if (recovered) {
            if (!isMountedRef.current || authStateTransitioned) return;
            updateOfflineSession(recovered.isExpired);
            setReauthRequired(false);
            setSession(recovered.session);
            setUser(recovered.session.user);
            return;
          }
        }

        const { data: { session: initialSession }, error } = await supabase.auth.getSession();

        if (!isMountedRef.current || authStateTransitioned) return;

        if (
          !initialSession &&
          (isRetryableAuthNetworkError(error) ||
            (typeof navigator !== 'undefined' &&
              navigator.onLine === false &&
              !isFatalAuthRevocationError(error)))
        ) {
          const recovered = recoverOfflineSessionFromStorage(supabase);
          if (recovered) {
            updateOfflineSession(true);
            setReauthRequired(false);
            if (error) setSessionError(error);
            setSession(recovered.session);
            setUser(recovered.session.user);
            return;
          }
        }

        if (error) {
          console.error('Error getting initial session:', error);
          setSessionError(error);
        }

        updateOfflineSession(false);
        setReauthRequired(false);
        setSession(initialSession);
        setUser(initialSession?.user ?? null);
      } finally {
        // Only set loading to false after initial check is complete
        if (isMountedRef.current) setLoading(false);
      }
    };

    void initializeAuth();

    const handleOnline = () => {
      if (!isMountedRef.current || !isOfflineSessionRef.current) return;
      void refreshSession();
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleOnline);
    }

    return () => {
      isMountedRef.current = false;
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleOnline);
      }
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      subscription.unsubscribe();
    };
  }, [refreshSession, updateOfflineSession]);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    return { error: error as Error | null };
  };

  const signUp = async (email: string, password: string) => {
    const redirectUrl = `${window.location.origin}/dashboard`;

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: redirectUrl,
      },
    });
    return { error: error as Error | null };
  };

  const signInWithGoogle = async () => {
    const redirectUrl = `${window.location.origin}/dashboard`;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: redirectUrl,
      },
    });
    return { error: error as Error | null };
  };

  const signOut = async () => {
    explicitSignOutRef.current = true;
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    await clearSensitiveBrowserCaches();

    const browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (browserOffline || isOfflineSessionRef.current) {
      clearStoredSupabaseSession(supabase);
      if (isMountedRef.current) {
        updateOfflineSession(false);
        setReauthRequired(false);
        setSessionError(null);
        setSession(null);
        setUser(null);
      }
      void Promise.resolve(supabase.auth.signOut({ scope: 'local' })).catch(() => {});
      return;
    }

    await supabase.auth.signOut();
    clearStoredSupabaseSession(supabase);
    if (isMountedRef.current) {
      updateOfflineSession(false);
      setReauthRequired(false);
      setSessionError(null);
      setSession(null);
      setUser(null);
    }
  };

  const updatePassword = async (newPassword: string) => {
    const { error } = await supabase.auth.updateUser({
      password: newPassword,
    });
    return { error: error as Error | null };
  };

  return (
    <AuthContext.Provider value={{
      user,
      session,
      loading,
      sessionError,
      isOfflineSession,
      reauthRequired,
      signIn,
      signUp,
      signInWithGoogle,
      signOut,
      updatePassword,
      refreshSession
    }}>
      {reauthRequired && user ? (
        <div
          role="status"
          data-testid="reauth-sync-banner"
          className="bg-amber-500/15 border-b border-amber-500/30 px-4 py-2 text-xs text-foreground flex items-center justify-between gap-3"
        >
          <span>Re-authenticate to sync offline changes. Your local workspace remains safe on this device.</span>
          <a href="/auth" className="font-medium underline underline-offset-2 shrink-0">
            Sign in
          </a>
        </div>
      ) : null}
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

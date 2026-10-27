import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Manager, MemberSession, SessionInfo } from '../../shared/types';
import { api, AUTH_REQUIRED_EVENT, errorMessage } from './api';

interface AuthContextValue {
  /** null while the session is loading. */
  session: SessionInfo | null;
  error: string | null;
  /** Call after setup creates the first manager. */
  signedIn: (manager: Manager) => void;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSession(await api.get<SessionInfo>('/auth/session'));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onAuthRequired = () => setSession((s) => (s ? { ...s, manager: null, member: null } : s));
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      error,
      refresh,
      signedIn: (manager) => setSession({ manager, member: null, needsSetup: false }),
      signOut: async () => {
        await api.post('/auth/logout', {});
        setSession({ manager: null, member: null, needsSetup: false });
      },
    }),
    [session, error, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}

/** The signed-in manager. Only use inside the manager app shell. */
export function useManager(): Manager {
  const manager = useAuth().session?.manager;
  if (!manager) throw new Error('useManager used while signed out');
  return manager;
}

/** The signed-in account member. Only use inside the member app shell. */
export function useMember(): MemberSession {
  const member = useAuth().session?.member;
  if (!member) throw new Error('useMember used while signed out');
  return member;
}

export const hasPolicy = (member: MemberSession, code: string) => member.policyCodes.includes(code);

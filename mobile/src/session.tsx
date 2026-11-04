import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  RejectedError, type Session, forgetPassword, refresh, savedEmail, savedLogin, signIn, signInDevice, signOut,
} from './auth';
import { setTokenSource } from './api';
import { clearCache } from './cache';

export type SessionState =
  | { name: 'loading' }
  | { name: 'offline'; message: string }
  | { name: 'email'; notice?: string }
  | { name: 'code' }
  | { name: 'ready' };

interface SessionValue {
  state: SessionState;
  email: string;
  setEmail(email: string): void;
  retry(): void;
  // Returns false when the email already has an account and a code was sent.
  continueWith(email: string, code?: string): Promise<boolean>;
  changeEmail(): void;
  logOut(): Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession needs SessionProvider.');
  return value;
}

// Refreshes a little before expiry, as the website does.
const EARLY_MS = 60_000;

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ name: 'loading' });
  const [email, setEmail] = useState('');
  const session = useRef<Session | null>(null);
  const pending = useRef<Promise<Session> | null>(null);

  const ready = useCallback((next: Session) => {
    session.current = next;
    setState({ name: 'ready' });
    return next;
  }, []);

  // Signs in with the saved password. If another device or the website replaced it,
  // a known device gets a new one without a code.
  const restore = useCallback(async (): Promise<Session | null> => {
    const login = await savedLogin();
    if (!login) return null;
    setEmail(login.email);
    try {
      return await signIn(login.email, login.password);
    } catch (failure) {
      if (!(failure instanceof RejectedError)) throw failure;
      await forgetPassword();
      return signInDevice(login.email);
    }
  }, []);

  const start = useCallback(async () => {
    try {
      const restored = await restore();
      if (restored) {
        ready(restored);
      } else if (await savedLogin()) {
        setState({ name: 'code' });
      } else {
        setEmail(await savedEmail() ?? '');
        setState({ name: 'email' });
      }
    } catch (failure) {
      if (failure instanceof RejectedError) {
        setState({ name: 'email', notice: failure.message });
      } else {
        setState({ name: 'offline', message: failure instanceof Error ? failure.message : 'Unable to connect.' });
      }
    }
  }, [restore, ready]);

  // start sets state only after its first await, so this does not render twice.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void start(); }, [start]);

  const token = useCallback(async () => {
    const current = session.current;
    if (!current) throw new Error('Sign in to continue.');
    if (current.expiresAt - Date.now() > EARLY_MS) return current.idToken;
    pending.current ??= refresh(current)
      .catch(async failure => {
        // The refresh token can be revoked by a sign-out elsewhere; the saved password still works.
        if (!(failure instanceof RejectedError)) throw failure;
        const restored = await restore();
        if (!restored) {
          session.current = null;
          setState({ name: 'email', notice: 'Your session expired. Sign in again.' });
          throw failure;
        }
        return restored;
      })
      .then(next => { session.current = next; return next; })
      .finally(() => { pending.current = null; });
    return (await pending.current).idToken;
  }, [restore]);

  useEffect(() => setTokenSource(token), [token]);

  const continueWith = useCallback(async (address: string, code?: string) => {
    const next = await signInDevice(address, code);
    setEmail(address);
    if (!next) {
      setState({ name: 'code' });
      return false;
    }
    ready(next);
    return true;
  }, [ready]);

  const logOut = useCallback(async () => {
    clearCache();
    const current = session.current;
    if (current) await signOut(current);
    else await forgetPassword();
    session.current = null;
    setState({ name: 'email' });
  }, []);

  const value = useMemo<SessionValue>(() => ({
    state, email, setEmail, retry: () => {
      setState({ name: 'loading' });
      void start();
    }, continueWith, logOut,
    changeEmail: () => setState({ name: 'email' }),
  }), [state, email, start, continueWith, logOut]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

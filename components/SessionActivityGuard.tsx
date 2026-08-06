import { useEffect, useRef, useState } from 'react';
import { useSession, signOut, getSession } from 'next-auth/react';
import { IDLE_TIMEOUT_MS, ABSOLUTE_TIMEOUT_MS } from '../lib/sessionTimeout';

// How often the watchdog re-evaluates the idle / absolute deadlines. Runs every
// second so the warning countdown stays accurate.
const CHECK_INTERVAL_MS = 1000;
// Minimum gap between server-side session refreshes triggered by activity.
const REFRESH_THROTTLE_MS = 60 * 1000;
// How long before a deadline we warn the user, giving them a chance to stay
// signed in (idle) or save their work (absolute) instead of losing it.
const WARNING_LEAD_MS = 60 * 1000;

const ACTIVITY_EVENTS = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart', 'click'];

type WarningType = 'idle' | 'absolute';

/**
 * Client-side enforcement of the session policy (see lib/sessionTimeout.ts):
 *
 *   - Idle timeout (15 min): on user activity we refresh the next-auth session
 *     (throttled), which rolls the JWT `exp` forward. With no activity the
 *     token lapses server-side and the user is signed out. We surface a warning
 *     60s before the deadline; any activity (or the "Stay signed in" button)
 *     extends the session so active users never lose their work.
 *   - Absolute timeout (30 min): a hard cap measured from `loginAt`; activity
 *     cannot extend it, so we warn 60s ahead to let the user save/submit before
 *     they are signed out.
 *
 * Renders a warning modal when a deadline is near; otherwise renders nothing.
 *
 * Note: browser-close termination is enforced by the session cookie (it has no
 * maxAge, so it is dropped when the browser closes). We deliberately do NOT use
 * a per-tab sessionStorage flag to force sign-out, because that signed users
 * out whenever they opened the app in a second tab — and signOut clears the
 * cookie for every tab, wiping work in progress.
 */
export default function SessionActivityGuard() {
  const { data: session, status } = useSession();
  const lastActivityRef = useRef<number>(Date.now());
  const lastRefreshRef = useRef<number>(0);
  const signingOutRef = useRef<boolean>(false);
  // Once the user acknowledges the absolute-timeout warning we keep it closed
  // for the rest of this session. The absolute deadline can't be extended, so
  // without this flag the 1s watchdog re-opens the modal every tick. Reset on a
  // new login (the effect re-runs when loginAt changes).
  const absoluteAckedRef = useRef<boolean>(false);

  const [warning, setWarning] = useState<{ type: WarningType; remaining: number } | null>(null);

  const loginAt = (session as any)?.loginAt as number | undefined;

  useEffect(() => {
    if (status !== 'authenticated') {
      setWarning(null);
      return;
    }

    // Fresh session (or new loginAt): allow the absolute warning again.
    absoluteAckedRef.current = false;

    const endSession = (reason: string) => {
      if (signingOutRef.current) return;
      signingOutRef.current = true;
      // eslint-disable-next-line no-console
      console.info(`[session] signing out: ${reason}`);
      signOut({ callbackUrl: '/' });
    };

    const markActivity = () => {
      lastActivityRef.current = Date.now();
      // Roll the server-side session forward, but no more than once a minute.
      // We use getSession() rather than next-auth's update(): update() flips the
      // global session status to "loading" while it revalidates, which makes
      // every `status === 'loading'` guard swap the page for a loader and remount
      // it (resetting scroll position mid-form). getSession() rolls the cookie
      // (updateAge re-issues the JWT) without ever toggling the loading state.
      const now = Date.now();
      if (now - lastRefreshRef.current > REFRESH_THROTTLE_MS) {
        lastRefreshRef.current = now;
        void getSession();
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') markActivity();
    };

    ACTIVITY_EVENTS.forEach((evt) =>
      window.addEventListener(evt, markActivity, { passive: true })
    );
    document.addEventListener('visibilitychange', onVisibility);

    const interval = setInterval(() => {
      const now = Date.now();
      // Idle deadline is measured from the user's LAST ACTIVITY — the warning
      // only appears after a genuine stretch of inactivity, and any activity
      // (or "Stay signed in") pushes it forward.
      const idleDeadline = lastActivityRef.current + IDLE_TIMEOUT_MS;
      const absoluteDeadline =
        typeof loginAt === 'number' ? loginAt + ABSOLUTE_TIMEOUT_MS : Infinity;

      // Whichever deadline comes first governs.
      const deadline = Math.min(idleDeadline, absoluteDeadline);
      const type: WarningType = idleDeadline <= absoluteDeadline ? 'idle' : 'absolute';

      if (now >= deadline) {
        endSession(type === 'idle' ? 'idle timeout' : 'absolute timeout');
        return;
      }

      if (deadline - now <= WARNING_LEAD_MS) {
        // The absolute warning is dismissible: once acknowledged, stay closed
        // until the deadline actually signs the user out. (Idle warnings clear
        // themselves via activity / "Stay signed in", so they don't need this.)
        if (type === 'absolute' && absoluteAckedRef.current) {
          setWarning((prev) => (prev ? null : prev));
        } else {
          setWarning({ type, remaining: Math.ceil((deadline - now) / 1000) });
        }
      } else {
        // setState bails out cheaply when the value is already null.
        setWarning((prev) => (prev ? null : prev));
      }
    }, CHECK_INTERVAL_MS);

    return () => {
      ACTIVITY_EVENTS.forEach((evt) => window.removeEventListener(evt, markActivity));
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(interval);
    };
  }, [status, loginAt]);

  const staySignedIn = async () => {
    // Roll the server cookie forward and confirm the session is still valid. If
    // the token already lapsed we can't revive it here — sign out cleanly rather
    // than dismiss the warning and let the next action hit "Unauthorized".
    // Reset the activity clock FIRST so the 1s watchdog doesn't re-open the
    // warning while getSession() is in flight.
    lastActivityRef.current = Date.now();
    lastRefreshRef.current = Date.now();
    setWarning(null);
    const s = await getSession();
    if (!s) {
      signOut({ callbackUrl: '/' });
    }
  };

  if (!warning) return null;

  const mins = Math.floor(warning.remaining / 60);
  const secs = warning.remaining % 60;
  const countdown = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="session-warning-title"
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <h2 id="session-warning-title" className="text-lg font-semibold text-gray-900">
          {warning.type === 'idle' ? 'Still there?' : 'Your secure session is ending'}
        </h2>
        <p className="mt-2 text-sm text-gray-600">
          {warning.type === 'idle' ? (
            <>
              You&apos;ll be signed out in <span className="font-semibold">{countdown}</span> due to
              inactivity. Choose &ldquo;Stay signed in&rdquo; to continue — your work won&apos;t be
              lost.
            </>
          ) : (
            <>
              For security, sessions end {Math.round(ABSOLUTE_TIMEOUT_MS / 60000)} minutes after
              sign-in. You&apos;ll be signed out in <span className="font-semibold">{countdown}</span>.
              Please save or submit your work now — you&apos;ll need to sign in again to continue.
            </>
          )}
        </p>
        <div className="mt-6 flex justify-end gap-3">
          {warning.type === 'idle' ? (
            <button
              type="button"
              onClick={staySignedIn}
              className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700"
            >
              Stay signed in
            </button>
          ) : (
            <button
              type="button"
              onClick={() => { absoluteAckedRef.current = true; setWarning(null); }}
              className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700"
            >
              Got it
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

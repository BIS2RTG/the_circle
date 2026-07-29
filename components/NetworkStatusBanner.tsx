import { useEffect, useState } from 'react';

/**
 * Global connectivity banner.
 *
 * Watches the browser's online/offline state and shows a fixed banner the
 * moment the connection drops — across every page, including while signing in
 * or approving. This is what stops a user from assuming "the system is down"
 * when it's really their own network: the app tells them plainly, and confirms
 * when the connection is back.
 *
 * The browser's `navigator.onLine` / online / offline events only reflect the
 * OS network interface (they can't detect a dead server on a live Wi-Fi), so
 * per-request failures are additionally surfaced as friendly messages via
 * getErrorMessage()/networkError.ts. This banner covers the unambiguous
 * "no connection at all" case.
 */
export default function NetworkStatusBanner() {
  // Start "online": SSR and the first client paint must agree to avoid a
  // hydration mismatch. We reconcile with the real value in the effect below.
  const [online, setOnline] = useState(true);
  // Briefly show a success banner when the connection is restored.
  const [justReconnected, setJustReconnected] = useState(false);

  useEffect(() => {
    // Reconcile with the real state on mount (in case we loaded while offline).
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setOnline(false);
    }

    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const goOffline = () => {
      setOnline(false);
      setJustReconnected(false);
    };

    const goOnline = () => {
      setOnline((wasOnline) => {
        // Only celebrate a reconnect if we were actually offline.
        if (!wasOnline) {
          setJustReconnected(true);
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => setJustReconnected(false), 4000);
        }
        return true;
      });
    };

    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);

    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, []);

  if (online && !justReconnected) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 top-0 z-[10000] flex justify-center px-4 pt-[env(safe-area-inset-top)]"
    >
      <div
        className={`mt-2 flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium shadow-lg ${
          online
            ? 'bg-emerald-600 text-white'
            : 'bg-amber-500 text-white'
        }`}
      >
        {online ? (
          <>
            <svg className="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span>Back online — you&apos;re reconnected.</span>
          </>
        ) : (
          <>
            <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-white" />
            </span>
            <span>No internet connection. The system is fine — we&apos;ll reconnect automatically.</span>
          </>
        )}
      </div>
    </div>
  );
}

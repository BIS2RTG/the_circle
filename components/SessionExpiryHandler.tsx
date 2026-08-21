import { useEffect, useRef, useState } from 'react';
import { signOut, useSession } from 'next-auth/react';
import { hasDraftSaver, rescueDraft } from '../lib/draftRescue';

/**
 * Global "session expired" catch-net.
 *
 * The session has both an idle (15 min) and an absolute (2 h) timeout. When one
 * lapses, every protected API responds 401 — and a user who was part-way through
 * filling in a form (e.g. a Travel Authorization) would otherwise get a bare,
 * confusing "Unauthorized" the moment they save/submit, with no idea what to do.
 *
 * This component patches `window.fetch` so that ANY 401 from our own `/api/*`
 * surface (across every form and page, without touching each handler) raises a
 * single, clear modal that tells the user exactly what happened and gives them
 * one button to sign in again. It is the reactive partner to
 * SessionActivityGuard, which proactively signs idle/expired sessions out.
 *
 * Deliberately does NOT auto-redirect: a user mid-form should get the chance to
 * copy any unsaved text before signing in again (unsaved on-screen edits can't
 * be saved once the session is gone).
 */
export default function SessionExpiryHandler() {
  const { status } = useSession();
  const [expired, setExpired] = useState(false);
  // Guard so concurrent 401s (a form often fires several requests at once) only
  // ever raise the modal once.
  const trippedRef = useRef(false);
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    if (typeof window === 'undefined' || !window.fetch) return;
    const originalFetch = window.fetch.bind(window);

    const isOwnApi = (url: string): boolean => {
      try {
        const u = new URL(url, window.location.origin);
        if (u.origin !== window.location.origin) return false;
        // next-auth's own endpoints legitimately 401 during sign-in/refresh —
        // never treat those as an expiry event.
        if (u.pathname.startsWith('/api/auth')) return false;
        return u.pathname.startsWith('/api/');
      } catch {
        return false;
      }
    };

    const patched: typeof window.fetch = async (input, init) => {
      const res = await originalFetch(input as any, init);
      try {
        if (
          res.status === 401 &&
          !trippedRef.current &&
          statusRef.current === 'authenticated'
        ) {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof Request
              ? input.url
              : String((input as URL).href ?? input);
          if (isOwnApi(url)) {
            trippedRef.current = true;
            setExpired(true);
          }
        }
      } catch {
        /* never let the interceptor break the caller's fetch */
      }
      return res;
    };

    window.fetch = patched;
    return () => {
      window.fetch = originalFetch;
    };
  }, []);

  if (!expired) return null;

  const signInAgain = () => {
    // Return the user to the page they were on after they re-authenticate.
    const callbackUrl =
      typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/';
    signOut({ callbackUrl: `/?callbackUrl=${encodeURIComponent(callbackUrl)}` });
  };

  // Whether the page the user is on has an in-progress form whose draft can be
  // rescued to local storage before signing out.
  const canSaveDraft = hasDraftSaver();

  const saveDraftAndSignIn = () => {
    // Snapshot the current form to storage (synchronous) BEFORE we navigate
    // away — after re-login the form's autosave restores it.
    rescueDraft();
    signInAgain();
  };

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="session-expired-title"
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <h2 id="session-expired-title" className="text-lg font-semibold text-gray-900">
          Your session has expired
        </h2>
        <p className="mt-2 text-sm text-gray-600">
          For your security you&apos;ve been signed out after a period of time, so your last
          action could not be completed. Please sign in again to continue.
        </p>
        {canSaveDraft ? (
          <p className="mt-2 text-sm text-gray-600">
            You can save what you&apos;ve filled in as a draft first — we&apos;ll bring it
            back automatically once you sign in again. (Uploaded files can&apos;t be kept and
            will need to be re-attached.)
          </p>
        ) : (
          <p className="mt-2 text-sm text-gray-600">
            Any unsaved changes on this page can&apos;t be saved now — if you have text you need,
            copy it before signing in again.
          </p>
        )}
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {canSaveDraft && (
            <button
              type="button"
              onClick={saveDraftAndSignIn}
              className="rounded-lg border border-primary-600 px-4 py-2 text-sm font-medium text-primary-700 hover:bg-primary-50"
            >
              Save draft &amp; sign in
            </button>
          )}
          <button
            type="button"
            onClick={signInAgain}
            className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700"
          >
            {canSaveDraft ? 'Sign in without saving' : 'Sign in again'}
          </button>
        </div>
      </div>
    </div>
  );
}

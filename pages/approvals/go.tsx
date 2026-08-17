import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { useSession, signIn } from 'next-auth/react';

/**
 * Approval magic-link landing page.
 *
 * Reached from an approval email link (`/approvals/go?token=…&next=/requests/…`).
 * If the approver already has a session we forward them straight to the request.
 * Otherwise we sign them in with the signed token (the `approval-link`
 * provider) — no login page — and then land them on the request to sign. If the
 * token is missing/expired we fall back to the normal login, preserving the
 * destination so they still reach the request after signing in.
 */
export default function ApprovalGo() {
  const router = useRouter();
  const { status } = useSession();
  const [failed, setFailed] = useState(false);
  const startedRef = useRef(false);

  const token = typeof router.query.token === 'string' ? router.query.token : null;
  const nextRaw = typeof router.query.next === 'string' ? router.query.next : null;
  const next = nextRaw && nextRaw.startsWith('/') && !nextRaw.startsWith('//') ? nextRaw : '/dashboard';

  useEffect(() => {
    if (!router.isReady || status === 'loading' || startedRef.current) return;
    startedRef.current = true;

    (async () => {
      // Already signed in → just go to the request.
      if (status === 'authenticated') {
        router.replace(next);
        return;
      }
      if (!token) {
        router.replace(`/?callbackUrl=${encodeURIComponent(next)}`);
        return;
      }
      const res = await signIn('approval-link', { token, redirect: false });
      if (res?.ok) {
        // Hard navigation (not router.replace) so the browser makes a fresh
        // document request carrying the just-set session cookie. The target
        // (/requests/[id]) re-checks the session in getServerSideProps; a
        // client-side SPA transition can race that check on mobile in-app
        // browsers (Outlook/Gmail webviews), where the new cookie isn't yet
        // observed by the SSR data fetch — bouncing the approver back to login.
        window.location.assign(next);
      } else {
        // Invalid/expired token — fall back to a normal login that returns here.
        router.replace(`/?callbackUrl=${encodeURIComponent(next)}`);
      }
    })().catch(() => setFailed(true));
  }, [router, router.isReady, status, token, next]);

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        fontFamily: "'Segoe UI', Arial, sans-serif",
        color: '#4b5563',
        background: '#f4f1ec',
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          border: '4px solid #e5e7eb',
          borderTopColor: '#9A7545',
          borderRadius: '50%',
          animation: 'circle-spin 0.8s linear infinite',
        }}
      />
      <p style={{ fontSize: 14 }}>
        {failed ? 'Something went wrong. Redirecting…' : 'Opening your approval…'}
      </p>
      <style>{`@keyframes circle-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

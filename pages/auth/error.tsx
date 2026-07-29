import { useRouter } from "next/router";
import { useEffect, useState } from "react";

const errorMessages: Record<string, string> = {
  Configuration: "There is a problem with the server configuration. Check if all environment variables are set correctly.",
  AccessDenied: "Access denied. Your organization may not be registered or you don't have permission.",
  Verification: "The verification link has expired or has already been used.",
  OAuthSignin: "We couldn't reach Microsoft to start sign-in. This is almost always a temporary network or connection problem, not a fault with the system — please check your internet connection and try again.",
  OAuthCallback: "We couldn't complete sign-in with Microsoft. This is usually a temporary network or connection problem — please check your internet connection and try again.",
  OAuthCreateAccount: "Could not create user account.",
  EmailCreateAccount: "Could not create user account.",
  Callback: "Error in authentication callback. This can happen when the connection to Microsoft is interrupted — please try again.",
  OAuthAccountNotLinked: "This email is already associated with another account.",
  SessionRequired: "Please sign in to access this page.",
  Default: "An authentication error occurred.",
};

// Auth errors that typically stem from a network/connectivity failure reaching
// Microsoft rather than a real misconfiguration. For these we lead with the
// connectivity explanation so users don't assume the system is broken.
const NETWORK_RELATED_ERRORS = new Set(["OAuthSignin", "OAuthCallback", "Callback"]);

// Threshold above which we treat the local clock as out of sync with the server.
// Microsoft rejects tokens whose nbf is more than ~5 minutes in the future, so
// anything beyond that will reliably break OAuth.
const CLOCK_SKEW_THRESHOLD_MS = 2 * 60 * 1000;

function formatSkew(ms: number): string {
  const abs = Math.abs(ms);
  const direction = ms > 0 ? "behind" : "ahead";
  const minutes = Math.round(abs / 60000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ${direction}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ${direction}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ${direction}`;
}

export default function AuthError() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [clockSkewMs, setClockSkewMs] = useState<number | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if (!router.isReady) return;
    if (router.query.error) {
      setError(router.query.error as string);
    } else {
      // No error code → this route is also configured as pages.signIn, so a
      // bare visit means NextAuth wants us to start a sign-in. Bounce home
      // where the real sign-in button lives.
      router.replace("/");
    }
  }, [router.isReady, router.query, router]);

  // When the OAuth callback fails, the most common root cause we see in the
  // wild is the user's machine clock being out of sync. NextAuth swallows the
  // underlying "JWT not active yet" message and just forwards `OAuthCallback`,
  // so we detect skew here by comparing the server's `Date` header against the
  // local clock and surface a specific, actionable message.
  useEffect(() => {
    if (error !== "OAuthCallback" && error !== "Callback") return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch("/api/auth/csrf", { cache: "no-store" });
        const serverDate = resp.headers.get("date");
        if (!serverDate) return;
        const serverMs = new Date(serverDate).getTime();
        if (Number.isNaN(serverMs)) return;
        const skew = serverMs - Date.now();
        if (!cancelled && Math.abs(skew) > CLOCK_SKEW_THRESHOLD_MS) {
          setClockSkewMs(skew);
        }
      } catch {
        // Network failure — fall back to the generic message.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [error]);

  // Track the browser's own connectivity so we can tell the user plainly when
  // THEY are offline (vs a server-side reachability problem we can't see).
  useEffect(() => {
    const update = () => setOffline(typeof navigator !== "undefined" && navigator.onLine === false);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  const isClockSkew = clockSkewMs !== null;
  const isNetworkError = !isClockSkew && (offline || (error !== null && NETWORK_RELATED_ERRORS.has(error)));
  const errorMessage = offline
    ? "You appear to be offline. Sign-in needs an internet connection to reach Microsoft. Reconnect and try again — the system itself is working fine."
    : error
    ? errorMessages[error] || errorMessages.Default
    : errorMessages.Default;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8 text-center">
        <div className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 ${isNetworkError ? "bg-amber-100" : "bg-red-100"}`}>
          {isNetworkError ? (
            <svg className="w-8 h-8 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18.364 5.636a9 9 0 010 12.728m-12.728 0a9 9 0 010-12.728m9.9 2.829a5 5 0 010 7.07m-7.072 0a5 5 0 010-7.07M12 15a1 1 0 100-2 1 1 0 000 2z" />
            </svg>
          ) : (
            <svg className="w-8 h-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          )}
        </div>

        <h1 className="text-2xl font-bold text-gray-900 mb-2">
          {isClockSkew
            ? "Your computer's clock is wrong"
            : isNetworkError
            ? "Connection problem"
            : "Authentication Error"}
        </h1>

        {error && !isClockSkew && !isNetworkError && (
          <p className="text-sm text-gray-500 mb-2">Error code: {error}</p>
        )}

        {isClockSkew ? (
          <div className="text-left text-gray-700 mb-6 space-y-3 text-sm">
            <p>
              Sign-in failed because this device&apos;s clock is off by about{" "}
              <strong>{formatSkew(clockSkewMs!)}</strong> compared to the server.
              Microsoft rejects sign-in tokens when the clock is more than a few
              minutes off, so you&apos;ll keep getting this error until the time is
              fixed.
            </p>
            <p className="font-semibold text-gray-900">How to fix it:</p>
            <ol className="list-decimal list-inside space-y-1">
              <li>
                Open <strong>Settings &rarr; Time &amp; language &rarr; Date &amp; time</strong>.
              </li>
              <li>
                Turn on <strong>Set time automatically</strong> and{" "}
                <strong>Set time zone automatically</strong>.
              </li>
              <li>
                Click <strong>Sync now</strong>, then try signing in again.
              </li>
            </ol>
            <p className="text-xs text-gray-500">
              If you&apos;re on a managed device and these settings are locked, ask
              your IT administrator to resync the system clock.
            </p>
          </div>
        ) : (
          <p className="text-gray-600 mb-6">{errorMessage}</p>
        )}
        
        <div className="space-y-3">
          <button
            onClick={() => router.push("/")}
            className="w-full bg-[#9A7545] text-white py-2 px-4 rounded-lg hover:bg-[#5E4426] transition-colors"
          >
            Try Again
          </button>
          
          <button
            onClick={() => router.push("/")}
            className="w-full bg-gray-100 text-gray-700 py-2 px-4 rounded-lg hover:bg-gray-200 transition-colors"
          >
            Go to Home
          </button>
        </div>
        
        <p className="text-xs text-gray-400 mt-6">
          If this problem persists, contact your administrator.
        </p>
      </div>
    </div>
  );
}

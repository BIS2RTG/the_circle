/**
 * Connectivity-error helpers.
 *
 * When the browser can't reach the server at all — offline, flaky Wi-Fi, VPN
 * drop, DNS failure, request timeout — `fetch()` rejects with a bare
 * `TypeError` whose message ("Failed to fetch", "NetworkError...", "Load
 * failed") means nothing to a user and reads like the app itself is broken.
 * These helpers let every call site recognise that case and show a message
 * that makes clear it's a connection problem, not a system fault, so the user
 * knows to retry rather than assume the system is down.
 */

const FRIENDLY_NETWORK_MESSAGE =
  "Can't reach the server. Please check your internet connection and try again.";

// Substrings emitted by the major engines when a fetch fails at the network
// layer (kept lower-cased for a case-insensitive match).
const NETWORK_ERROR_SIGNATURES = [
  'failed to fetch',        // Chromium / Edge
  'networkerror',           // Firefox ("NetworkError when attempting to fetch")
  'load failed',            // Safari / WebKit
  'network request failed', // React Native / some polyfills
  'connection',             // "connection refused/reset/closed"
  'err_internet_disconnected',
  'err_network',
  'err_connection',
  'the internet connection appears to be offline',
];

/**
 * True when `error` represents a connectivity failure rather than an
 * application error returned by the server. Also treats a known-offline
 * browser as a network error regardless of the thrown value.
 */
export function isNetworkError(error: unknown): boolean {
  // A browser that reports itself offline is definitively a connectivity issue.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return true;
  }

  // A timed-out request we aborted ourselves surfaces as an AbortError.
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }

  let message = '';
  if (error instanceof Error) {
    // `fetch` network failures are specifically TypeErrors; still, match on the
    // message too so wrapped/re-thrown errors are caught.
    message = `${error.name} ${error.message}`;
  } else if (typeof error === 'string') {
    message = error;
  } else if (error && typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    message = String(obj.message ?? obj.error ?? '');
  }

  const lower = message.toLowerCase();
  return NETWORK_ERROR_SIGNATURES.some((sig) => lower.includes(sig));
}

/**
 * Returns a friendly connectivity message when `error` is a network failure,
 * otherwise `null` so the caller can fall back to its own message.
 */
export function getNetworkErrorMessage(error: unknown): string | null {
  return isNetworkError(error) ? FRIENDLY_NETWORK_MESSAGE : null;
}

export { FRIENDLY_NETWORK_MESSAGE };

/**
 * Signature storage access (private bucket).
 *
 * The `signatures` bucket is PRIVATE — objects are not reachable by public URL.
 * Two access paths replace the old `getPublicUrl`:
 *
 *   - Browser display → the authenticated proxy `/api/signature/view`, which
 *     authorizes the caller (same-org / self / temp-capability) and streams the
 *     bytes via the service role. Use the *ProxyUrl helpers below.
 *   - Server-side use (PDF generation) → a short-lived signed URL via
 *     getSignatureSignedUrl(), or the raw bytes via downloadSignature().
 *
 * Object layout:
 *   <userId>.png                              — a user's saved signature
 *   temp/<sessionId>.png                      — mobile QR hand-off (ephemeral)
 *   manual/<userId>/<requestId>/<stepId>.ext  — drawn at approval time
 */

import { supabaseAdmin } from './supabaseAdmin';

export const SIGNATURE_BUCKET = 'signatures';

export const userSignaturePath = (userId: string) => `${userId}.png`;
export const tempSignaturePath = (sessionId: string) => `temp/${sessionId}.png`;

// Relative proxy URLs for browser <img> / persisted signature_url values.
export const userSignatureProxyUrl = (userId: string) =>
  `/api/signature/view?userId=${encodeURIComponent(userId)}`;
export const tempSignatureProxyUrl = (sessionId: string) =>
  `/api/signature/view?temp=${encodeURIComponent(sessionId)}`;
export const pathSignatureProxyUrl = (path: string) =>
  `/api/signature/view?path=${encodeURIComponent(path)}`;

/**
 * True if an object exists at `path` in the signatures bucket.
 * Uses a metadata-only `list` (no byte transfer) — this runs on the approval
 * hot path, so downloading the whole image just to test existence was wasteful.
 */
export async function signatureExists(path: string): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const idx = path.lastIndexOf('/');
  const folder = idx === -1 ? '' : path.slice(0, idx);
  const name = idx === -1 ? path : path.slice(idx + 1);
  const { data, error } = await supabaseAdmin.storage
    .from(SIGNATURE_BUCKET)
    .list(folder, { search: name, limit: 100 });
  if (error || !data) return false;
  return data.some((o) => o.name === name);
}

/** Download the raw bytes of a signature object, or null. */
export async function downloadSignature(path: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin.storage.from(SIGNATURE_BUCKET).download(path);
  if (error || !data) return null;
  const buffer = Buffer.from(await data.arrayBuffer());
  const contentType = (data as any).type || 'image/png';
  return { buffer, contentType };
}

/**
 * Short-lived signed URL for server-side consumers (e.g. a PDF generator that
 * fetches the image during rendering). Default TTL 5 min — long enough to
 * generate a document, short enough to not be a durable public link.
 */
export async function getSignatureSignedUrl(path: string, ttlSeconds = 300): Promise<string | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin.storage
    .from(SIGNATURE_BUCKET)
    .createSignedUrl(path, ttlSeconds);
  if (error || !data) return null;
  return data.signedUrl;
}

/**
 * Resolve the owning userId from a signature object path, used by the proxy to
 * apply a same-org authorization check.
 *   '<uuid>.png'                  -> '<uuid>'
 *   'manual/<uuid>/<req>/<step>'  -> '<uuid>'
 * Returns null for paths with no embedded owner (e.g. temp/*).
 */
export function ownerIdFromPath(path: string): string | null {
  if (path.startsWith('manual/')) {
    const parts = path.split('/');
    return parts[1] || null;
  }
  const base = path.split('/').pop() || '';
  const id = base.replace(/\.(png|jpe?g)$/i, '');
  return id || null;
}

/**
 * Resolve a *stored* signature reference to something a SERVER-SIDE consumer
 * (e.g. a pdfkit generator) can fetch. Persisted values are proxy URLs
 * (`/api/signature/view?...`) which require a browser session and so can't be
 * fetched server-side; this maps them — and legacy public URLs — to a
 * short-lived signed URL. `data:` URLs (inline drawn signatures) pass through.
 */
export async function resolveSignatureSignedUrl(
  stored: string | null | undefined,
  ttlSeconds = 300
): Promise<string | null> {
  if (!stored) return null;
  if (stored.startsWith('data:')) return stored;
  try {
    if (stored.includes('/api/signature/view') && stored.includes('?')) {
      const params = new URLSearchParams(stored.split('?')[1]);
      const userId = params.get('userId');
      const path = params.get('path');
      const temp = params.get('temp');
      if (userId) return getSignatureSignedUrl(userSignaturePath(userId), ttlSeconds);
      if (path) return getSignatureSignedUrl(path, ttlSeconds);
      if (temp) return getSignatureSignedUrl(tempSignaturePath(temp), ttlSeconds);
    }
    // Legacy public URL: .../object/public/signatures/<path>
    const m = stored.match(/\/signatures\/(.+?)(\?|$)/);
    if (m) return getSignatureSignedUrl(decodeURIComponent(m[1]), ttlSeconds);
  } catch {
    /* fall through */
  }
  return stored;
}

/** Allow only the known-safe object shapes through the `?path=` proxy mode. */
export function isAllowedSignaturePath(path: string): boolean {
  // <uuid>.png
  if (/^[0-9a-fA-F-]{36}\.png$/.test(path)) return true;
  // manual/<uuid>/<requestId>/<stepId>.<ext>
  if (/^manual\/[0-9a-fA-F-]{36}\/[\w-]+\/[\w-]+\.(png|jpe?g)$/.test(path)) return true;
  return false;
}

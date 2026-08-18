import { useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/router';
import { useSession } from 'next-auth/react';
import { registerDraftSaver } from '../lib/draftRescue';

/**
 * Client-side form autosave / crash recovery.
 *
 * Persists a serializable snapshot of a form's state to sessionStorage as the
 * user types (debounced) and restores it on a same-tab reload. This is the
 * safety net behind the session-timeout work: if the page is reloaded or the
 * session lapses mid-form within the same tab, the user's entries are recovered
 * instead of lost.
 *
 * sessionStorage (not localStorage) is deliberate: the snapshot lives only for
 * the life of the tab, so opening the form in a new tab — or after closing the
 * browser, or a later session — always starts BLANK. A new/blank form must
 * never come pre-filled with data from an earlier, abandoned session.
 *
 * Design notes:
 *  - Snapshots are keyed per user (so a different account on a shared machine
 *    never sees them) and per form type.
 *  - Snapshots expire after `ttlMs` (default 6h) and are removed automatically
 *    once the form is successfully saved (the page navigates to the request
 *    detail page) or the user explicitly discards — so a submitted or discarded
 *    form never resurrects stale data.
 *  - Only serializable slices should be passed in `data`. File uploads and
 *    signature canvases can't survive a reload and should be left out.
 *  - Restore runs once on mount and only when `enabled` (callers disable it in
 *    edit mode or when prefilling from a linked request, where the server is
 *    the source of truth).
 */

const PREFIX = 'circle:autosave:';
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const DEFAULT_DEBOUNCE_MS = 800;

interface StoredSnapshot<T> {
  v: 1;
  savedAt: number;
  data: T;
}

interface Options<T> {
  /** Stable identifier for this form type, e.g. 'petty-cash'. */
  formKey: string;
  /** The serializable form state to persist. */
  data: T;
  /** Apply a restored snapshot back onto the form's state. */
  onRestore: (saved: T) => void;
  /** Disable persist + restore (e.g. edit mode / linked prefill). Default true. */
  enabled?: boolean;
  /** Debounce before writing to storage. Default 800ms. */
  debounceMs?: number;
  /** How long a snapshot is considered fresh enough to restore. Default 6h. */
  ttlMs?: number;
}

export function useFormAutosave<T extends Record<string, unknown>>(opts: Options<T>) {
  const {
    formKey,
    data,
    onRestore,
    enabled = true,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    ttlMs = DEFAULT_TTL_MS,
  } = opts;

  const router = useRouter();
  const { data: session } = useSession();
  const userScope = (session?.user as any)?.id || session?.user?.email || 'anon';
  const storageKey = `${PREFIX}${userScope}:${formKey}`;
  // Scroll position is per-tab and short-lived, so it lives in sessionStorage.
  const scrollKey = `${storageKey}::scroll`;

  // Keep the latest callback / data without making them effect dependencies.
  const onRestoreRef = useRef(onRestore);
  onRestoreRef.current = onRestore;
  const dataRef = useRef(data);
  dataRef.current = data;

  const restoredRef = useRef(false);
  const hydratedRef = useRef(false);
  const skipFirstPersistRef = useRef(true);

  const clear = useCallback(() => {
    try {
      window.sessionStorage.removeItem(storageKey);
      window.sessionStorage.removeItem(scrollKey);
    } catch {
      /* storage unavailable — ignore */
    }
  }, [storageKey, scrollKey]);

  // Restore once on mount.
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (!enabled) {
      hydratedRef.current = true;
      return;
    }
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as StoredSnapshot<T>;
        if (parsed?.data && Date.now() - parsed.savedAt <= ttlMs) {
          onRestoreRef.current(parsed.data);
        } else {
          window.sessionStorage.removeItem(storageKey);
        }
      }
    } catch {
      /* corrupt snapshot — ignore */
    }
    hydratedRef.current = true;

    // Restore the scroll position the user was at before a full reload. The
    // restored content renders asynchronously, so the page may be too short to
    // honour the target on the first frame — retry over a few frames until the
    // document is tall enough.
    try {
      const rawY = window.sessionStorage.getItem(scrollKey);
      const targetY = rawY ? parseInt(rawY, 10) : NaN;
      if (Number.isFinite(targetY) && targetY > 0) {
        let attempts = 0;
        const restoreScroll = () => {
          attempts += 1;
          const maxY = document.documentElement.scrollHeight - window.innerHeight;
          window.scrollTo(0, Math.min(targetY, Math.max(0, maxY)));
          if (window.scrollY < targetY - 2 && attempts < 30) {
            requestAnimationFrame(restoreScroll);
          }
        };
        requestAnimationFrame(restoreScroll);
      }
    } catch {
      /* ignore */
    }
  }, [storageKey, scrollKey, enabled, ttlMs]);

  // Persist scroll position (throttled) so a reload can land where the user was.
  useEffect(() => {
    if (!enabled) return;
    let throttle: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      if (throttle) return;
      throttle = setTimeout(() => {
        throttle = null;
        try {
          window.sessionStorage.setItem(scrollKey, String(window.scrollY));
        } catch {
          /* ignore */
        }
      }, 250);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (throttle) clearTimeout(throttle);
    };
  }, [scrollKey, enabled]);

  // Persist on change (debounced) after hydration. The first run is skipped so
  // a freshly-restored (or empty) form doesn't immediately overwrite storage.
  const serialized = JSON.stringify(data);
  useEffect(() => {
    if (!enabled || !hydratedRef.current) return;
    if (skipFirstPersistRef.current) {
      skipFirstPersistRef.current = false;
      return;
    }
    const handle = setTimeout(() => {
      try {
        const payload: StoredSnapshot<T> = { v: 1, savedAt: Date.now(), data: dataRef.current };
        window.sessionStorage.setItem(storageKey, JSON.stringify(payload));
      } catch {
        /* quota exceeded / not serializable — ignore */
      }
    }, debounceMs);
    return () => clearTimeout(handle);
    // serialized is the change signal; dataRef.current holds the value to write.
  }, [serialized, enabled, storageKey, debounceMs]);

  // Force-write the current snapshot to storage immediately. Used by the
  // session-expiry "Save draft" rescue: it writes to localStorage (which the
  // restore-on-mount path reads) so the draft survives the sign-out → sign-in
  // round-trip and repopulates the form afterwards.
  const saveNow = useCallback((): boolean => {
    try {
      const payload: StoredSnapshot<T> = { v: 1, savedAt: Date.now(), data: dataRef.current };
      const raw = JSON.stringify(payload);
      window.localStorage.setItem(storageKey, raw);
      window.sessionStorage.setItem(storageKey, raw);
      return true;
    } catch {
      return false;
    }
  }, [storageKey]);

  // Register this form's snapshotter so the global SessionExpiryHandler can
  // rescue the draft before the user re-authenticates. Only while enabled
  // (a fresh form) — edit mode / linked prefill use the server as source.
  useEffect(() => {
    if (!enabled) return;
    return registerDraftSaver(saveNow);
  }, [enabled, saveNow]);

  // Clear the snapshot when the user deliberately discards changes (fired by
  // useUnsavedChangesPrompt). Without this, a discarded form's entries would be
  // restored the next time the same form is opened.
  useEffect(() => {
    const onDiscard = () => clear();
    window.addEventListener('form-autosave-discard', onDiscard);
    return () => window.removeEventListener('form-autosave-discard', onDiscard);
  }, [clear]);

  // Auto-clear once the form is successfully saved. Both submit and draft paths
  // navigate to the request detail page (`/requests/<id>`), so a completed
  // navigation there means the snapshot is no longer needed.
  useEffect(() => {
    const onComplete = (url: string) => {
      const path = url.split('?')[0];
      if (path !== '/requests/new' && /^\/requests\/[^/]+$/.test(path)) {
        clear();
      }
    };
    router.events.on('routeChangeComplete', onComplete);
    return () => router.events.off('routeChangeComplete', onComplete);
  }, [router.events, clear]);

  return { clear, saveNow };
}

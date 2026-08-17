/**
 * Draft-rescue registry.
 *
 * A tiny global bridge so the app-wide SessionExpiryHandler can save the
 * in-progress form's draft to local storage BEFORE the user is signed out and
 * has to re-authenticate. The active form (via useFormAutosave) registers a
 * snapshot function here; the expiry modal calls it when the user chooses to
 * save their draft. After re-login the form's own autosave restore recovers it.
 *
 * Only one form is ever mounted at a time, so a single slot is enough.
 */

/** Returns true when a draft snapshot was written to storage. */
type DraftSaver = () => boolean;

let currentSaver: DraftSaver | null = null;

/** Register the active form's snapshotter. Returns an unregister function. */
export function registerDraftSaver(fn: DraftSaver): () => void {
  currentSaver = fn;
  return () => {
    if (currentSaver === fn) currentSaver = null;
  };
}

/** Whether a form with a rescuable draft is currently mounted. */
export function hasDraftSaver(): boolean {
  return !!currentSaver;
}

/** Snapshot the current form's draft to storage. Returns true on success. */
export function rescueDraft(): boolean {
  try {
    return currentSaver ? currentSaver() : false;
  } catch {
    return false;
  }
}

import { waitUntil } from '@vercel/functions';

/**
 * Run best-effort work AFTER the HTTP response has been sent.
 *
 * The approval flow does the critical, must-be-durable work synchronously
 * (record the decision, advance the workflow, flip request status) and then
 * hands the slow best-effort follow-ups — notification emails, PDF archive
 * generation, the Microsoft push — to this helper so the approver's request
 * returns immediately instead of waiting several seconds for all of it.
 *
 * On Vercel, `waitUntil` keeps the serverless function alive until the promise
 * settles, so the work still completes after the response is flushed. Outside a
 * Vercel request context (local dev, cron scripts) `waitUntil` throws — we
 * swallow that; the promise is already running and a long-lived process drains
 * it normally.
 *
 * Never throws. A failing background task is logged, never surfaced.
 */
export function runInBackground(work: () => Promise<unknown>, label = 'background task'): void {
  let p: Promise<unknown>;
  try {
    p = Promise.resolve(work());
  } catch (err) {
    // Synchronous throw before the promise even started.
    console.error(`[${label}] threw synchronously:`, err);
    return;
  }
  p = p.catch((err) => console.error(`[${label}] failed:`, err));

  try {
    waitUntil(p);
  } catch {
    // Not inside a Vercel request context — the promise still runs on its own.
  }
}

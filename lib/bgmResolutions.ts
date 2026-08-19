/**
 * BGM-04 — Board Resolution & Action Tracker: shared, CLIENT-SAFE helpers.
 *
 * The stored task status is pending / in_progress / resolved. "Overdue" is a
 * DERIVED presentation status (past its deadline and not yet resolved) so it can
 * never drift from the clock. Both the UI and the reminder cron use
 * effectiveStatus() as the single source of truth.
 */

export const TASK_STATUSES = ['pending', 'in_progress', 'resolved'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** The four states the tracker surfaces (overdue is derived, not stored). */
export const EFFECTIVE_STATUSES = ['pending', 'in_progress', 'overdue', 'resolved'] as const;
export type EffectiveStatus = (typeof EFFECTIVE_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<EffectiveStatus, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  overdue: 'Overdue',
  resolved: 'Resolved',
};

export const TASK_STATUS_STYLES: Record<EffectiveStatus, { bg: string; text: string; dot: string; ring: string }> = {
  pending:     { bg: 'bg-neutral-100', text: 'text-neutral-600', dot: 'bg-neutral-400', ring: 'ring-neutral-200' },
  in_progress: { bg: 'bg-sky-50',      text: 'text-sky-700',     dot: 'bg-sky-500',     ring: 'ring-sky-200' },
  overdue:     { bg: 'bg-rose-50',     text: 'text-rose-700',    dot: 'bg-rose-500',    ring: 'ring-rose-200' },
  resolved:    { bg: 'bg-emerald-50',  text: 'text-emerald-700', dot: 'bg-emerald-500', ring: 'ring-emerald-200' },
};

export interface TaskLike {
  status: string | null;
  due_date: string | null;
  resolved_at?: string | null;
}

/**
 * Derive the live status shown to users.
 * A non-resolved task whose due_date is strictly before today is Overdue.
 */
export function effectiveStatus(task: TaskLike, now: Date = new Date()): EffectiveStatus {
  const stored = (task.status || 'pending') as TaskStatus;
  if (stored === 'resolved') return 'resolved';
  if (task.due_date) {
    const due = startOfDay(new Date(task.due_date));
    if (due.getTime() < startOfDay(now).getTime()) return 'overdue';
  }
  return stored;
}

/** Days until (positive) / since (negative) the due date, at day granularity. */
export function daysUntilDue(due_date: string | null, now: Date = new Date()): number | null {
  if (!due_date) return null;
  const due = startOfDay(new Date(due_date)).getTime();
  const today = startOfDay(now).getTime();
  return Math.round((due - today) / 86_400_000);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Roll a resolution's task statuses into an overall progress summary. */
export function summariseResolution(tasks: TaskLike[], now: Date = new Date()) {
  const counts: Record<EffectiveStatus, number> = { pending: 0, in_progress: 0, overdue: 0, resolved: 0 };
  for (const t of tasks) counts[effectiveStatus(t, now)] += 1;
  const total = tasks.length;
  const resolved = counts.resolved;
  const pct = total > 0 ? Math.round((resolved / total) * 100) : 0;
  const allResolved = total > 0 && resolved === total;
  const hasOverdue = counts.overdue > 0;
  return { counts, total, resolved, pct, allResolved, hasOverdue };
}

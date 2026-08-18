/**
 * Per-viewer status for a request shown in the dashboard "Recent activity" feed.
 *
 * The request's own `status` stays 'pending' until the WHOLE chain is signed
 * off, which is misleading on a per-user feed: an approver who has already
 * approved their step still saw "Pending". This resolves the badge from the
 * signed-in user's perspective instead:
 *
 *   - A fully resolved request (approved / rejected) reads the same for everyone.
 *   - Otherwise, if the viewer is an approver who has already acted, show THEIR
 *     outcome ("You approved" / "You rejected") even though the request overall
 *     is still in progress.
 *   - An approver whose turn it currently is sees "Awaiting you".
 *   - The requester (and anyone else) sees "Pending" while it's still in flight.
 *
 * Shared by the dashboard SSR (pages/dashboard/index.tsx) and the stats API
 * (pages/api/dashboard/stats.ts) so both compute the badge identically.
 */

export type ViewerStatusBucket = 'approved' | 'rejected' | 'pending';

export interface ViewerStatus {
  /** Drives the badge colour (approved = green, rejected = red, pending = amber). */
  status: ViewerStatusBucket;
  /** Human label shown on the badge. */
  label: string;
}

interface RequestStepLike {
  approver_user_id?: string | null;
  status?: string | null;
}

interface RequestLike {
  status?: string | null;
  creator_id?: string | null;
  request_steps?: RequestStepLike[] | null;
}

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export function computeViewerStatus(req: RequestLike, userId: string | null | undefined): ViewerStatus {
  const overall = (req.status || '').toLowerCase();

  // A resolved request is the truth for everyone who can see it.
  if (overall === 'approved') return { status: 'approved', label: 'Approved' };
  if (overall === 'rejected') return { status: 'rejected', label: 'Rejected' };

  // Only substitute a per-viewer status while the request is genuinely still in
  // flight. Terminal states (cancelled / withdrawn / completed) reflect the
  // request as a whole and must not read as "You approved".
  if (overall !== 'pending') {
    return { status: 'pending', label: capitalize(overall) || 'Pending' };
  }

  // In progress — resolve from the viewer's own step, if they have one.
  const userStep = userId
    ? (req.request_steps || []).find((s) => s.approver_user_id === userId)
    : undefined;

  if (userStep) {
    const stepStatus = (userStep.status || '').toLowerCase();
    if (stepStatus === 'approved') return { status: 'approved', label: 'You approved' };
    if (stepStatus === 'rejected') return { status: 'rejected', label: 'You rejected' };
    // Their step is active and unacted — it's waiting on them right now.
    if (stepStatus === 'pending') return { status: 'pending', label: 'Awaiting you' };
  }

  // Requester, watcher, or an approver whose turn hasn't come yet.
  return { status: 'pending', label: 'Pending' };
}
